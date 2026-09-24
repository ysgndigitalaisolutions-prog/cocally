import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { sipStatusToEndReason, type CallEndReason, type CallOutcome, type CallState } from '@cocally/shared';
import { Model, Types } from 'mongoose';
import { config } from '../../common/config';
import { Call, CallDocument } from '../../schemas/call.schema';
import { CliNumber, CliNumberDocument } from '../../schemas/cli-number.schema';
import { AuditService } from '../audit/audit.service';
import { LeadsService } from '../leads/leads.service';
import { RecordingsService } from '../recordings/recordings.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { PresenceService } from '../workspace/presence.service';
import { RealtimeGateway } from '../workspace/realtime.gateway';
import { TransfersService } from '../workspace/transfers.service';
import { CliService } from './cli.service';
import { LiveCallDriver } from './live-call.driver';
import { LivekitService } from './livekit.service';

/**
 * States that mean "somebody has already closed this call out".
 *
 * WRAP_UP is in here deliberately: the manual dialer parks a call there when
 * the agent hangs up, and the human's disposition owns the record from that
 * point. Re-finalising it from a late `room_finished` would run the retry
 * matrix a second time.
 */
const HANDLED_STATES: readonly CallState[] = ['COMPLETED', 'FAILED', 'WRAP_UP'];

/**
 * LiveKit's `DisconnectReason` values that carry SIP meaning.
 *
 * Mirrored as plain numbers (rather than importing the generated enum into a
 * mapping table) so the intent stays readable next to the reason it maps to —
 * and so a protocol bump that renames a member is a compile-time no-op rather
 * than a silent behaviour change.
 */
const DISCONNECT_USER_UNAVAILABLE = 11; // SIP callee did not respond in time
const DISCONNECT_USER_REJECTED = 12; // SIP callee rejected the call (busy)
const DISCONNECT_SIP_TRUNK_FAILURE = 13; // SIP protocol failure / unexpected response
const DISCONNECT_CLIENT_INITIATED = 1;
const DISCONNECT_PARTICIPANT_REMOVED = 4; // we called removeParticipant — i.e. our side hung up
const DISCONNECT_ROOM_DELETED = 5;
const DISCONNECT_CONNECTION_TIMEOUT = 14;
const DISCONNECT_MEDIA_FAILURE = 15;

/**
 * Participant attributes LiveKit SIP may carry the final response code on.
 *
 * The attribute name has moved between LiveKit releases, so several are tried
 * rather than hard-coding one and silently degrading every call to UNKNOWN
 * after an upgrade. Anything outside the SIP response range is ignored.
 */
const SIP_STATUS_ATTRIBUTES = [
  'sip.callStatusCode',
  'sip.statusCode',
  'sip.responseCode',
  'sip.h.x-status-code',
] as const;

/** A single 603 "Decline" is just a person rejecting a call. This many, this fast, is a pattern. */
const CARRIER_BLOCK_QUARANTINE_THRESHOLD = 5;
const CARRIER_BLOCK_WINDOW_MS = 15 * 60 * 1000;

/**
 * The call state machine that was missing for real calls.
 *
 * Nothing subscribed to LiveKit webhooks, so a live call never advanced past
 * RINGING: `answeredAt` was never set, no call ever reached a terminal state,
 * and `CALL_OUTCOMES` like BUSY / NO_ANSWER / DISCONNECTED were declared but
 * unreachable — which made the entire retry matrix dead code on the live path.
 * Every method here is driven by `LivekitWebhookController`.
 *
 * Two properties matter more than anything else in this file:
 *
 *  1. IDEMPOTENCE. Webhooks retry, and they arrive out of order —
 *     `room_finished` routinely beats `participant_left`. Finalisation is
 *     therefore a single conditional `findOneAndUpdate` against the
 *     non-terminal states, and whichever delivery loses the race returns
 *     without side effects.
 *  2. NEVER THROWING. A handler that throws turns into a webhook retry storm.
 *     The controller catches, and the individual side effects below are
 *     ordered so the important ones (outcome, retry matrix) happen before the
 *     cosmetic ones.
 */
@Injectable()
export class CallProgressService {
  private readonly logger = new Logger(CallProgressService.name);

  /** Recent CARRIER_BLOCKED timestamps per CLI number, for the burst detector. */
  private readonly carrierBlocks = new Map<string, number[]>();

  constructor(
    @InjectModel(Call.name) private readonly callModel: Model<CallDocument>,
    @InjectModel(CliNumber.name) private readonly cliModel: Model<CliNumberDocument>,
    private readonly livekit: LivekitService,
    private readonly cli: CliService,
    private readonly driver: LiveCallDriver,
    private readonly leads: LeadsService,
    private readonly recordings: RecordingsService,
    private readonly webhooks: WebhooksService,
    private readonly presence: PresenceService,
    private readonly gateway: RealtimeGateway,
    private readonly audit: AuditService,
    private readonly transfers: TransfersService,
  ) {}

  // ── Webhook entry points ────────────────────────────────────────────────

  /**
   * Somebody joined the room. When it is the customer's SIP leg, this IS the
   * answer event — the only moment on a real trunk where "they picked up" is
   * knowable.
   */
  async onParticipantJoined(callId: string, identity: string, attributes?: Record<string, string>): Promise<void> {
    if (identity !== this.livekit.sipParticipantIdentity(callId)) {
      // The AI worker, a human agent or a supervisor. Their arrival is not a
      // call-progress event; agent bridging is recorded where the transfer is.
      return;
    }
    // LiveKit adds the SIP participant to the room while the phone is still
    // ringing. Only `sip.callStatus: active` means someone picked up; the
    // authoritative answer signal is the awaited INVITE (see `markAnswered`).
    const status = attributes?.['sip.callStatus'];
    if (status && status !== 'active') {
      await this.callModel.updateOne({ _id: new Types.ObjectId(callId), state: { $in: ['DIALING', 'CONNECTING'] } }, { state: 'RINGING' }).exec();
      return;
    }
    if (!status) return; // no status attribute: wait for the INVITE to resolve
    await this.markAnswered(callId);
  }

  /** The customer picked up. Idempotent. */
  async markAnswered(callId: string): Promise<void> {
    const call = await this.load(callId);
    if (!call) return;
    if (HANDLED_STATES.includes(call.state)) return;
    if (call.answeredAt) return; // replayed webhook

    const answeredAt = new Date();
    call.answeredAt = answeredAt;
    call.ringMs = Math.max(0, answeredAt.getTime() - call.startedAt.getTime());
    // An agent already on the record means this is a human-fronted call
    // (manual/predictive), so the customer answering completes the bridge.
    const bridged = Boolean(call.agentId);
    call.state = bridged ? 'BRIDGED' : 'IN_CONVERSATION';
    if (bridged && !call.bridgedAt) call.bridgedAt = answeredAt;

    // Egress can refuse a room that has no publishers yet, so the driver's
    // pre-INVITE attempt may have returned null. Now that the customer is in
    // the room, try once more rather than losing the recording entirely.
    if (!call.recordingEgressId) {
      const recording = await this.livekit.startRecording(callId, call.tenantId.toString());
      if (recording) {
        call.recordingEgressId = recording.egressId;
        call.recordingUri = recording.uri;
      }
    }

    await call.save();
    this.logger.log(`call ${callId} answered after ${call.ringMs}ms → ${call.state}`);
    this.emitStateChanged(call);
  }

  /**
   * The awaited INVITE ended without an answer (busy, no answer, rejected,
   * invalid number, trunk refusal). The SIP status, when the carrier gave
   * one, drives the retry matrix and CLI health exactly like a webhook would.
   */
  async onDialFailed(callId: string, sipStatus: number | undefined, detail: string): Promise<void> {
    this.logger.log(`call ${callId} not answered: ${detail}`);
    await this.finalise(callId, sipStatus !== undefined ? { sipStatus } : { endReason: 'NO_ANSWER' });
  }

  /**
   * Somebody left. When it is the customer's SIP leg the call is over — this
   * is where BUSY / NO_ANSWER / DISCONNECTED finally become reachable.
   */
  async onParticipantLeft(
    callId: string,
    identity: string,
    disconnectReason?: number,
    sipStatus?: number,
  ): Promise<void> {
    if (identity !== this.livekit.sipParticipantIdentity(callId)) return;
    await this.finalise(callId, { sipStatus, disconnectReason });
  }

  /**
   * Safety net. LiveKit tears an empty room down on its own, and this fires
   * even when the `participant_left` delivery was lost — without it a dropped
   * webhook would leave a call live forever, holding a pacing slot and a
   * locked lead.
   */
  async onRoomFinished(callId: string): Promise<void> {
    await this.finalise(callId, {});
  }

  /** Persist where the finished recording actually landed. */
  async onEgressEnded(callId: string, egressId: string, uri?: string): Promise<void> {
    const call = await this.load(callId);
    if (!call) return;
    // Guard against a stale egress (e.g. a restarted recording) overwriting
    // the URI of the one this call is actually associated with.
    if (call.recordingEgressId && call.recordingEgressId !== egressId) return;
    call.recordingEgressId = egressId;
    if (uri) call.recordingUri = uri;
    await call.save();
  }

  /**
   * Terminal failure before the carrier ever got involved — the INVITE itself
   * threw. Called by `CallOrchestratorService` so a trunk misconfiguration
   * produces a FAILED call and a retry-matrix decision instead of a row stuck
   * in DIALING with its lead locked for ten minutes.
   */
  async failCall(callId: string, endReason: CallEndReason, detail: string): Promise<void> {
    this.logger.error(`call ${callId} failed before answer (${endReason}): ${detail}`);
    await this.finalise(callId, { endReason });
  }

  // ── Finalisation ────────────────────────────────────────────────────────

  private async finalise(
    callId: string,
    input: { endReason?: CallEndReason; sipStatus?: number; disconnectReason?: number },
  ): Promise<void> {
    if (!Types.ObjectId.isValid(callId)) return;
    const id = new Types.ObjectId(callId);

    // Read first so the outcome can be derived from what actually happened,
    // then commit with a conditional update — the read is advisory, the
    // update is the lock.
    const snapshot = await this.callModel.findById(id).lean().exec();
    if (!snapshot) return;
    if (HANDLED_STATES.includes(snapshot.state)) return;

    const answered = Boolean(snapshot.answeredAt);
    const endReason =
      input.endReason ?? this.deriveEndReason(input.sipStatus, input.disconnectReason, answered);
    const endedAt = new Date();

    // A manual dial is closed out by the agent's disposition, not by us. Record
    // the carrier facts and hand the record to the human — running the retry
    // matrix here as well would double-count the attempt and fight the
    // disposition for the lead's state.
    if (snapshot.manual) {
      await this.finaliseManual(id, callId, snapshot, endReason, input.sipStatus, endedAt);
      return;
    }

    // An outcome the conversation already established (OPT_OUT, a booked
    // appointment path) is better information than "the customer hung up",
    // so it wins — but only when the customer actually answered, which is the
    // guarantee that a never-answered call can never be recorded as ANSWERED_*.
    const derived = this.outcomeForEndReason(endReason, answered);
    // What answered matters more than how it ended: a voicemail the worker
    // hung up on is ANSWERED_VOICEMAIL (24 h retry), not a human contact that
    // would freeze the lead under the frequency cap for two weeks.
    const byAmd = answered ? this.outcomeForAmd(snapshot.amdClass) : null;
    const outcome: CallOutcome = answered && snapshot.outcome ? snapshot.outcome : (byAmd ?? derived);
    const state: CallState = outcome === 'FAILED' ? 'FAILED' : 'COMPLETED';

    const call = await this.callModel
      .findOneAndUpdate(
        { _id: id, state: { $nin: HANDLED_STATES } },
        {
          state,
          endedAt,
          endReason,
          outcome,
          ...(input.sipStatus !== undefined ? { sipStatusCode: input.sipStatus } : {}),
        },
        { new: true },
      )
      .exec();
    // Lost the race with a concurrent delivery of the same (or a sibling)
    // webhook. The winner has done, or is doing, everything below.
    if (!call) return;

    const tenantId = call.tenantId.toString();
    const leadId = call.leadId.toString();
    this.logger.log(`call ${callId} ended: ${endReason} → ${outcome} (answered=${answered})`);

    // Stop the meter first — an egress left running bills for an empty room.
    if (call.recordingEgressId) await this.livekit.stopRecording(call.recordingEgressId);

    // Then tear the room down rather than waiting out the 10-minute
    // `emptyTimeout`: the AI worker sits in the room until it is deleted, so
    // leaving it up holds a worker slot per finished call. Harmless when the
    // room is already gone (the `room_finished` path), and the resulting
    // `room_finished` re-entry is caught by the HANDLED_STATES guard above.
    await this.safely('hangup', () => this.livekit.hangup(callId));

    // Same transcript artefact the simulation path writes, so QA and the
    // recordings timeline do not have to care how the call was placed.
    await this.safely('captureLeg', () =>
      this.recordings.captureLeg({
        tenantId,
        callId,
        leadId,
        leg: 'AI',
        startedAt: call.startedAt,
        transcript: call.transcript.filter((t) => t.leg === 'AI'),
      }),
    );

    // THE point of all of this: the retry matrix finally runs on real calls.
    await this.safely('applyOutcome', () => this.leads.applyOutcome(leadId, outcome, callId));

    await this.safely('cliHealth', () => this.recordCliHealth(call, answered, endReason));

    await this.safely('webhook', () =>
      this.webhooks.dispatch(tenantId, 'call.completed', {
        callId,
        leadId,
        campaignId: call.campaignId.toString(),
        outcome,
        score: call.finalScore,
        endReason,
      }),
    );

    await this.safely('wrapUp', () => this.startWrapUp(call, endReason, outcome));
    await this.safely('cancelOffers', () => this.transfers.cancelOffersForCall(callId, 'the customer hung up'));
    await this.safely('supervision', () => this.clearSupervision(call._id));

    // Free the pacing slot and clear the floor card last, so a supervisor sees
    // the card disappear only once the record is genuinely closed.
    this.driver.release(callId);
    this.gateway.emitToTenant(tenantId, 'call.state.changed', { callId, state, endReason });
  }

  /**
   * Manual dials: record the carrier facts and park the call in WRAP_UP for
   * the agent, exactly as `ManualDialService.hangup()` does when the agent
   * hangs up first. This is the far-end-hangup case, which previously the
   * agent's UI never learned about at all.
   */
  private async finaliseManual(
    id: Types.ObjectId,
    callId: string,
    snapshot: Call,
    endReason: CallEndReason,
    sipStatus: number | undefined,
    endedAt: Date,
  ): Promise<void> {
    const call = await this.callModel
      .findOneAndUpdate(
        { _id: id, state: { $nin: HANDLED_STATES } },
        {
          state: 'WRAP_UP',
          endedAt,
          endReason,
          ...(sipStatus !== undefined ? { sipStatusCode: sipStatus } : {}),
          // A manual dial that was actually answered is a human answer by
          // definition — the agent spoke to someone. Stamping it here is what
          // lets manual traffic count toward the rolling 7-day number-health
          // aggregation instead of being silently excluded from it.
          ...(snapshot.answeredAt && !snapshot.amdClass ? { amdClass: 'HUMAN' as const } : {}),
          // The wrap-up window has to be opened here too, not only on the AI
          // path. Without it a far-end hangup left the agent pinned ON_CALL
          // with no deadline for the sweep to act on — they simply stopped
          // receiving work until they noticed and fixed it by hand.
          wrapUpDeadline: new Date(Date.now() + config.floor.wrapUpMaxSeconds * 1000),
        },
        { new: true },
      )
      .exec();
    if (!call) return;

    if (call.recordingEgressId) await this.livekit.stopRecording(call.recordingEgressId);
    // The manual dialer selects from the same CLI pool but never fed the
    // result back, so these dials were invisible to number health.
    await this.safely('cliHealth', () => this.recordCliHealth(call, Boolean(snapshot.answeredAt), endReason));

    await this.safely('participants', () => this.releaseOtherParticipants(call));
    await this.safely('supervision', () => this.clearSupervision(call._id));
    const agentId = call.agentId?.toString();
    if (agentId) {
      // Release ON_CALL → WRAP_UP so the sweep can return them to AVAILABLE.
      // The disposition still closes the record; this only frees the seat.
      await this.safely('manualWrapUp', () => this.presence.release(agentId, 'WRAP_UP'));
      this.gateway.emitToUser(agentId, 'call.ended', { callId, reason: endReason, outcome: null });
      this.gateway.emitToUser(agentId, 'wrapup.started', {
        callId,
        deadline: call.wrapUpDeadline?.getTime() ?? Date.now() + config.floor.wrapUpMaxSeconds * 1000,
      });
      this.gateway.emitToTenant(call.tenantId.toString(), 'presence.updated', {
        userId: agentId,
        state: 'WRAP_UP',
      });
    }
    this.driver.release(callId);
    this.gateway.emitToTenant(call.tenantId.toString(), 'call.state.changed', {
      callId,
      state: 'WRAP_UP',
      endReason,
    });
  }

  /**
   * An agent was on the call when it ended: give them the wrap-up window.
   *
   * Presence goes to WRAP_UP, never straight to AVAILABLE — the sweep that
   * auto-returns them when `wrapUpDeadline` passes owns that transition, and
   * releasing here would hand them a new call mid-disposition.
   */
  private async startWrapUp(call: CallDocument, endReason: CallEndReason, outcome: CallOutcome): Promise<void> {
    await this.releaseOtherParticipants(call);
    const agentId = call.agentId?.toString();
    if (!agentId) return;

    const deadline = new Date(Date.now() + config.floor.wrapUpMaxSeconds * 1000);
    await this.callModel.updateOne({ _id: call._id }, { wrapUpDeadline: deadline }).exec();
    await this.presence.release(agentId, 'WRAP_UP');

    const callId = call._id.toString();
    this.gateway.emitToUser(agentId, 'call.ended', { callId, reason: endReason, outcome });
    this.gateway.emitToUser(agentId, 'wrapup.started', { callId, deadline: deadline.getTime() });
    this.gateway.emitToTenant(call.tenantId.toString(), 'presence.updated', {
      userId: agentId,
      state: 'WRAP_UP',
    });
  }

  /**
   * Agents who were on the call without owning it (a warm consult, a
   * conference) are not on `call.agentId`, so the owner's wrap-up never
   * reaches them and they would sit ON_CALL until they noticed. Hand them
   * straight back to the floor.
   */
  private async releaseOtherParticipants(call: CallDocument): Promise<void> {
    const owner = call.agentId?.toString();
    const callId = call._id.toString();
    for (const id of call.participantAgentIds ?? []) {
      const agentId = id.toString();
      if (agentId === owner) continue;
      await this.presence.release(agentId, 'AVAILABLE');
      this.gateway.emitToUser(agentId, 'call.ended', { callId, reason: call.endReason ?? 'ended', outcome: null });
      this.gateway.emitToTenant(call.tenantId.toString(), 'presence.updated', { userId: agentId, state: 'AVAILABLE' });
    }
  }

  /** A supervisor attached to this call has nothing left to monitor. */
  private async clearSupervision(callId: Types.ObjectId): Promise<void> {
    await this.callModel.updateOne({ _id: callId }, { $unset: { supervisorId: '', supervisionMode: '' } }).exec();
  }

  /**
   * Release everything a call holds on the media plane and in pacing, for the
   * paths that close a call without going through `finalise` (an agent's
   * disposition or hang-up, an external transfer, the hung-call sweep).
   * Safe to call more than once.
   */
  async releaseResources(call: { _id: Types.ObjectId; recordingEgressId?: string }): Promise<void> {
    const callId = call._id.toString();
    if (call.recordingEgressId) await this.safely('stopRecording', () => this.livekit.stopRecording(call.recordingEgressId!));
    if (this.livekit.isConfigured()) await this.safely('hangup', () => this.livekit.hangup(callId));
    await this.safely('cancelOffers', () => this.transfers.cancelOffersForCall(callId, 'the call has ended'));
    this.driver.release(callId);
  }

  /** What answered, when the worker told us. Null when unknown/human. */
  private outcomeForAmd(amdClass: CallDocument['amdClass'] | undefined): CallOutcome | null {
    switch (amdClass) {
      case 'VOICEMAIL':
        return 'ANSWERED_VOICEMAIL';
      case 'IVR':
        return 'ANSWERED_IVR';
      case 'FAX':
      case 'SILENCE':
        return 'NO_ANSWER';
      default:
        return null;
    }
  }

  // ── CLI health ──────────────────────────────────────────────────────────

  /**
   * Feed the real answer result back into number health.
   *
   * `CliService`'s resting and quarantine heuristics have always been correct;
   * they were simply starved of data, because the only caller passed a
   * simulated answer flag (and the manual dialer passed nothing at all). This
   * is the one place a live call reports the truth.
   *
   * The number→document lookup exists because `recordDial` is keyed by CLI id
   * while a Call only stores the presented number. Going through `recordDial`
   * rather than incrementing the counters here is deliberate: it is what keeps
   * the same-day RESTING circuit breaker in one place.
   */
  private async recordCliHealth(call: CallDocument, answered: boolean, endReason: CallEndReason): Promise<void> {
    if (!call.cli) return;
    const cli = await this.cliModel.findOne({ tenantId: call.tenantId, number: call.cli }).exec();
    if (!cli) return;

    await this.cli.recordDial(cli._id, answered);

    if (endReason === 'CARRIER_BLOCKED') await this.onCarrierBlocked(cli);
  }

  /**
   * SIP 603 / 607 / 608 on an outbound dial is the earliest visible signal
   * that a number is being blocked — days before the 7-day answer-rate decay
   * that `CliService.recomputeHealth` watches for gets anywhere near its
   * threshold. It is worth shouting about.
   *
   * One rejection is not evidence: 603 "Decline" is also just a person
   * pressing decline. A burst of them from the same CLI is, so the number is
   * pulled only once the burst threshold is crossed — using the same
   * status/audit shape as `CliService`'s own auto-quarantine so the CLI health
   * dashboard and the audit log cannot tell the two apart.
   */
  private async onCarrierBlocked(cli: CliNumberDocument): Promise<void> {
    this.logger.error(
      `CARRIER BLOCK signal on CLI ${cli.number}: the callee's network rejected the call as unwanted (SIP 603/607/608).`,
    );

    const now = Date.now();
    const recent = (this.carrierBlocks.get(cli.number) ?? []).filter((t) => now - t < CARRIER_BLOCK_WINDOW_MS);
    recent.push(now);
    this.carrierBlocks.set(cli.number, recent);

    if (recent.length < CARRIER_BLOCK_QUARANTINE_THRESHOLD) return;
    if (cli.status === 'QUARANTINED') return;

    const reason = `${recent.length} carrier rejections (SIP 603/607/608) within ${Math.round(
      CARRIER_BLOCK_WINDOW_MS / 60000,
    )} minutes — the number is being actively blocked.`;
    cli.status = 'QUARANTINED';
    cli.quarantinedAt = new Date();
    cli.quarantineReason = reason;
    await cli.save();
    this.carrierBlocks.delete(cli.number);
    this.logger.error(`CLI ${cli.number} auto-QUARANTINED: ${reason}`);

    await this.audit.record({
      tenantId: cli.tenantId.toString(),
      actorLabel: 'system:call-progress',
      action: 'cli.auto_quarantine',
      entityType: 'CliNumber',
      entityId: cli._id.toString(),
      before: { status: 'ACTIVE' },
      after: { status: 'QUARANTINED', reason },
    });
  }

  // ── Mapping ─────────────────────────────────────────────────────────────

  /**
   * SIP status is the authority when the carrier gave us one; LiveKit's
   * coarser `DisconnectReason` is the fallback for the (common) case where it
   * did not surface a response code.
   */
  private deriveEndReason(
    sipStatus: number | undefined,
    disconnectReason: number | undefined,
    answered: boolean,
  ): CallEndReason {
    if (sipStatus !== undefined) return sipStatusToEndReason(sipStatus);

    switch (disconnectReason) {
      case DISCONNECT_USER_UNAVAILABLE:
        return 'NO_ANSWER';
      case DISCONNECT_USER_REJECTED:
        return 'BUSY';
      case DISCONNECT_SIP_TRUNK_FAILURE:
        return 'TRUNK_ERROR';
      case DISCONNECT_CONNECTION_TIMEOUT:
        return 'TIMEOUT';
      case DISCONNECT_MEDIA_FAILURE:
        return 'CONGESTION';
      case DISCONNECT_PARTICIPANT_REMOVED:
      case DISCONNECT_ROOM_DELETED:
        // We removed the SIP leg or deleted the room — i.e. our side hung up.
        return 'AI_HANGUP';
      case DISCONNECT_CLIENT_INITIATED:
        return 'CUSTOMER_HANGUP';
      default:
        // No status, no usable reason: an answered call that ends is a hangup;
        // an unanswered one that ends is a miss. Never guess upward.
        return answered ? 'CUSTOMER_HANGUP' : 'NO_ANSWER';
    }
  }

  /**
   * End reason → the outcome the retry matrix keys off.
   *
   * The `answered` gate is the invariant that makes this trustworthy: a call
   * that was never picked up can never produce an ANSWERED_* outcome, so
   * "contacted" metrics and the CONTACTED lead transition stay honest.
   */
  private outcomeForEndReason(endReason: CallEndReason, answered: boolean): CallOutcome {
    switch (endReason) {
      case 'CUSTOMER_HANGUP':
      case 'AGENT_HANGUP':
      case 'AI_HANGUP':
        return answered ? 'ANSWERED_HUMAN' : 'NO_ANSWER';
      case 'BUSY':
        return 'BUSY';
      case 'NO_ANSWER':
      case 'TIMEOUT':
        return 'NO_ANSWER';
      case 'INVALID_NUMBER':
      case 'REJECTED':
      case 'CARRIER_BLOCKED':
        // Not retryable at the same cadence as a miss: the number is bad or the
        // network is refusing us, and hammering it makes both worse.
        return 'DISCONNECTED';
      case 'CONGESTION':
      case 'TRUNK_ERROR':
        // Our problem, not the lead's — FAILED so the matrix retries soon.
        return 'FAILED';
      case 'UNKNOWN':
      default:
        return answered ? 'ANSWERED_HUMAN' : 'NO_ANSWER';
    }
  }

  // ── Plumbing ────────────────────────────────────────────────────────────

  private async load(callId: string): Promise<CallDocument | null> {
    if (!Types.ObjectId.isValid(callId)) return null;
    return this.callModel.findById(new Types.ObjectId(callId)).exec();
  }

  private emitStateChanged(call: CallDocument): void {
    const payload = { callId: call._id.toString(), state: call.state };
    this.gateway.emitToTenant(call.tenantId.toString(), 'call.state.changed', payload);
    const agentId = call.agentId?.toString();
    if (agentId) this.gateway.emitToUser(agentId, 'call.state.changed', payload);
  }

  /**
   * Run a finalisation side effect without letting it abort the rest.
   *
   * Finalisation is a chain of independent obligations — retry matrix, CLI
   * health, webhook, wrap-up — and a webhook subscriber that 500s on one of
   * them loses all the others AND gets the delivery retried, re-running
   * whatever already succeeded.
   */
  private async safely(label: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.error(`call finalisation step "${label}" failed: ${(err as Error).message}`);
    }
  }
}
