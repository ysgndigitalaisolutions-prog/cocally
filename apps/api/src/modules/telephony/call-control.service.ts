import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Interval } from '@nestjs/schedule';
import {
  LIVE_CALL_STATES,
  type AgentTransferKind,
  type AgentTransferOffer,
  type CallState,
  type CurrentCallState,
  type TransferCard,
} from '@cocally/shared';
import { Model, Types } from 'mongoose';
import { config } from '../../common/config';
import { Call, CallDocument } from '../../schemas/call.schema';
import { Campaign, CampaignDocument } from '../../schemas/campaign.schema';
import { Lead, LeadDocument } from '../../schemas/lead.schema';
import { Transfer, TransferDocument } from '../../schemas/transfer.schema';
import { User, UserDocument } from '../../schemas/user.schema';
import { PresenceService } from '../workspace/presence.service';
import { RealtimeGateway } from '../workspace/realtime.gateway';
import { CallProgressService } from './call-progress.service';
import { LivekitService } from './livekit.service';

/** What an accepting agent needs to join the room. */
export interface AgentTransferAcceptResult {
  ok: true;
  transferId: string;
  callId: string;
  kind: AgentTransferKind;
  livekitUrl: string;
  livekitToken: string;
  roomName: string;
}

interface PendingAgentTransfer {
  transferId: string;
  tenantId: string;
  callId: string;
  kind: AgentTransferKind;
  fromAgentId: string;
  toAgentId: string;
  offer: AgentTransferOffer;
  /** True when the offer parked the customer, so expiry knows to un-park them. */
  heldForOffer: boolean;
  timer: NodeJS.Timeout;
}

/** A warm consult in progress: who hands over to whom when it completes. */
interface WarmHandover {
  fromAgentId: string;
  toAgentId: string;
}

/**
 * Agent call control: hold/resume, agent-to-agent transfer, external (off
 * platform) transfer, and the "what am I on right now?" recovery lookup.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHO PLAYS THE HOLD MUSIC — read this before changing anything in `hold()`
 * ─────────────────────────────────────────────────────────────────────────
 * This service holds a call *in state only*. It never touches the media.
 *
 * We have no server-side media publisher: nothing in this stack can push an
 * audio file into a LiveKit room. The actual hold experience is produced
 * entirely by the AGENT'S BROWSER, which on a successful `hold()`:
 *   1. unpublishes (or replaces) its microphone track with a looping track
 *      sourced from the `holdMusicUrl` this method returns, so the customer
 *      hears music instead of an open mic; and
 *   2. mutes its local playback of the customer's track, so the agent can
 *      talk to a colleague or a supervisor without the customer hearing.
 * `resume()` reverses both steps client-side.
 *
 * Consequences a future reader must know:
 *   • If the agent's tab dies while ON_HOLD the music dies with it and the
 *     customer hears silence — the state here will still say ON_HOLD. The
 *     presence sweep signing the agent out is the backstop, not this file.
 *   • `heldMs`/`holdCount` are therefore a record of what the *server was
 *     told*, accurate enough for QA but not a media-plane measurement.
 *   • The day a server-side publisher exists (a LiveKit ingress or a small
 *     agent process joining the room), the fix is to publish the track here
 *     and stop returning `holdMusicUrl` — nothing else changes.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SINGLE-INSTANCE LIMITATION
 * ─────────────────────────────────────────────────────────────────────────
 * Pending agent-to-agent offers and the wrap-up deadlines of agents who have
 * handed a call away live in in-process Maps (same pattern as
 * TransfersService.pendingOffers). One API instance is fine for a ten-seat
 * floor. Running two instances behind a load balancer would mean an offer
 * accepted on instance B is unknown to instance A: move these to Redis (or a
 * Transfer document with a state machine) before scaling out.
 */
@Injectable()
export class CallControlService {
  private readonly logger = new Logger(CallControlService.name);

  /** transferId → live offer awaiting accept/decline/expiry. */
  private readonly pendingOffers = new Map<string, PendingAgentTransfer>();

  /** callId → who is consulting with whom, for `completeWarmTransfer`. */
  private readonly warmHandovers = new Map<string, WarmHandover>();

  /**
   * agentId → { deadline, tenantId } for agents parked in WRAP_UP by a
   * transfer rather than by ending a call. Those agents are no longer on the
   * Call document, so the DB-backed arm of the wrap-up sweep cannot find them.
   */
  private readonly transferWrapUps = new Map<string, { deadline: number; tenantId: string }>();

  constructor(
    @InjectModel(Call.name) private readonly callModel: Model<CallDocument>,
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
    @InjectModel(Campaign.name) private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Transfer.name) private readonly transferModel: Model<TransferDocument>,
    private readonly presence: PresenceService,
    private readonly gateway: RealtimeGateway,
    private readonly livekit: LivekitService,
    private readonly progress: CallProgressService,
  ) {}

  // ── Shared helpers ──────────────────────────────────────────────────────

  /**
   * Load a still-live call this agent is actually on.
   *
   * Membership is `agentId` OR `participantAgentIds`: during a conference the
   * second agent is a real participant with call-control rights even though
   * the call is still "owned" by the first.
   */
  private async loadLiveCall(tenantId: string, agentId: string, callId: string): Promise<CallDocument> {
    if (!Types.ObjectId.isValid(callId)) throw new NotFoundException('Call not found');
    const call = await this.callModel
      .findOne({ _id: new Types.ObjectId(callId), tenantId: new Types.ObjectId(tenantId) })
      .exec();
    if (!call) throw new NotFoundException('Call not found');
    const onCall =
      call.agentId?.toString() === agentId || call.participantAgentIds.some((id) => id.toString() === agentId);
    if (!onCall) throw new ForbiddenException('This call belongs to another agent.');
    if (!LIVE_CALL_STATES.includes(call.state)) {
      throw new BadRequestException(`This call is no longer live (${call.state}).`);
    }
    return call;
  }

  /** Agents join `tenant:<id>`, so one tenant emit reaches supervisors and the agent alike. */
  private emitCallState(call: CallDocument, endReason?: string): void {
    this.gateway.emitToTenant(call.tenantId.toString(), 'call.state.changed', {
      callId: call._id.toString(),
      state: call.state,
      ...(endReason ? { endReason } : {}),
    });
  }

  private addParticipant(call: CallDocument, agentId: string): void {
    if (!call.participantAgentIds.some((id) => id.toString() === agentId)) {
      call.participantAgentIds.push(new Types.ObjectId(agentId));
    }
  }

  /** The state a call returns to once the customer comes off hold. */
  private resumedState(call: CallDocument): CallState {
    return call.agentId ? 'BRIDGED' : 'IN_CONVERSATION';
  }

  /** Accumulate held time and clear the marker. Safe to call when not held. */
  private settleHold(call: CallDocument): void {
    if (call.heldSince) {
      call.heldMs += Math.max(0, Date.now() - call.heldSince.getTime());
      call.heldSince = undefined;
    }
  }

  // ── A. Hold / resume ────────────────────────────────────────────────────

  /**
   * Park the customer. Returns the URL the agent's browser must publish — see
   * the class comment: the server does not produce this audio.
   */
  async hold(tenantId: string, agentId: string, callId: string): Promise<{ ok: true; holdMusicUrl: string | null }> {
    const call = await this.loadLiveCall(tenantId, agentId, callId);
    const holdMusicUrl = config.floor.holdMusicUrl ?? null;
    // Idempotent: a double-click on the hold button must not inflate holdCount
    // or reset heldSince (which would silently discard accumulated hold time).
    if (call.state === 'ON_HOLD') return { ok: true, holdMusicUrl };
    if (call.state !== 'BRIDGED' && call.state !== 'IN_CONVERSATION') {
      throw new BadRequestException(`Cannot hold a call in state ${call.state}.`);
    }

    call.state = 'ON_HOLD';
    call.heldSince = new Date();
    call.holdCount += 1;
    await call.save();

    this.emitCallState(call);
    this.logger.log(`call ${callId} placed on hold by agent ${agentId} (hold #${call.holdCount})`);
    return { ok: true, holdMusicUrl };
  }

  async resume(tenantId: string, agentId: string, callId: string): Promise<{ ok: true; state: CallState }> {
    const call = await this.loadLiveCall(tenantId, agentId, callId);
    if (call.state !== 'ON_HOLD') return { ok: true, state: call.state };

    this.settleHold(call);
    call.state = this.resumedState(call);
    await call.save();

    this.emitCallState(call);
    this.logger.log(`call ${callId} resumed by agent ${agentId} (${call.heldMs}ms held total)`);
    return { ok: true, state: call.state };
  }

  // ── B. Agent-to-agent transfer ──────────────────────────────────────────

  /**
   * Offer this call to another agent.
   *
   * BLIND and WARM park the customer for the duration of the accept window —
   * otherwise the customer sits listening to two agents negotiate a handover,
   * which is the single most demo-breaking thing an agent can do. CONFERENCE
   * does not park: the point of a conference is that the customer stays in the
   * conversation while the second agent arrives.
   *
   * The target is `reserve()`d exactly like an AI transfer, so a predictive
   * dial or an AI transfer cascade cannot double-book them mid-offer.
   */
  async offerAgentTransfer(
    tenantId: string,
    from: { id: string; email: string },
    callId: string,
    input: { kind: AgentTransferKind; toAgentId: string; note?: string },
  ): Promise<{ transferId: string; acceptDeadline: number; holdMusicUrl: string | null }> {
    const call = await this.loadLiveCall(tenantId, from.id, callId);
    if (input.toAgentId === from.id) throw new BadRequestException('You cannot transfer a call to yourself.');
    if (!Types.ObjectId.isValid(input.toAgentId)) throw new NotFoundException('Target agent not found');

    const [target, fromUser, lead, campaign] = await Promise.all([
      this.userModel
        .findOne({ _id: new Types.ObjectId(input.toAgentId), tenantId: new Types.ObjectId(tenantId), active: true })
        .select('name email presence roles')
        .lean()
        .exec(),
      this.userModel.findById(from.id).select('name email').lean().exec(),
      this.leadModel.findById(call.leadId).select('firstName lastName phone').lean().exec(),
      this.campaignModel.findById(call.campaignId).select('name').lean().exec(),
    ]);
    if (!target) throw new NotFoundException('Target agent not found');
    if (!target.roles.includes('AGENT') && !target.roles.includes('SUPERVISOR')) {
      throw new BadRequestException('Only agents and supervisors can receive a call transfer.');
    }
    // One outstanding offer per call — a second one would race the first onto
    // the same room and leave a reserved agent stranded.
    for (const pending of this.pendingOffers.values()) {
      if (pending.callId === callId) throw new BadRequestException('This call already has a transfer offer pending.');
    }

    const reserved = await this.presence.reserve(new Types.ObjectId(input.toAgentId));
    if (!reserved) throw new BadRequestException(`${target.name || target.email} is not available right now.`);

    const heldForOffer = input.kind !== 'CONFERENCE' && call.state !== 'ON_HOLD';
    if (heldForOffer) {
      call.state = 'ON_HOLD';
      call.heldSince = new Date();
      call.holdCount += 1;
      await call.save();
      this.emitCallState(call);
    }

    const transferId = new Types.ObjectId().toString();
    const offer: AgentTransferOffer = {
      transferId,
      callId,
      kind: input.kind,
      fromAgentId: from.id,
      fromAgentName: fromUser?.name || from.email,
      leadName: [lead?.firstName, lead?.lastName].filter(Boolean).join(' ') || (lead?.phone ?? 'Unknown'),
      phone: lead?.phone ?? '',
      campaignName: campaign?.name ?? '',
      note: input.note?.trim() ? input.note.trim() : null,
      acceptDeadline: Date.now() + config.floor.agentTransferAcceptSeconds * 1000,
    };

    const timer = setTimeout(
      () => void this.expireOffer(transferId, 'accept window elapsed'),
      config.floor.agentTransferAcceptSeconds * 1000,
    );
    // `unref` so a pending offer can never hold the process open on shutdown.
    timer.unref?.();
    this.pendingOffers.set(transferId, {
      transferId,
      tenantId,
      callId,
      kind: input.kind,
      fromAgentId: from.id,
      toAgentId: input.toAgentId,
      offer,
      heldForOffer,
      timer,
    });

    this.gateway.emitToUser(input.toAgentId, 'agent.transfer.offer', offer);
    this.logger.log(`${input.kind} transfer offered: call ${callId} ${from.email} → ${target.email}`);
    return {
      transferId,
      acceptDeadline: offer.acceptDeadline,
      holdMusicUrl: heldForOffer ? (config.floor.holdMusicUrl ?? null) : null,
    };
  }

  /** Tear an offer down and un-park the customer if the offer parked them. */
  private async expireOffer(transferId: string, reason: string): Promise<void> {
    const pending = this.pendingOffers.get(transferId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingOffers.delete(transferId);
    await this.unwindOffer(pending, reason);
  }

  /** An accept that could not be completed — same unwind as a timeout. */
  private async abandonAccept(pending: PendingAgentTransfer, reason: string): Promise<void> {
    await this.unwindOffer(pending, reason);
  }

  /**
   * Put everything the offer touched back: the reserved agent returns to the
   * pool, both parties are told, and a customer parked *by the offer* comes
   * back off hold. A customer the agent had parked before offering stays
   * parked — the offer did not put them there and must not take them out.
   */
  private async unwindOffer(pending: PendingAgentTransfer, reason: string): Promise<void> {
    const { transferId } = pending;
    await this.presence.release(pending.toAgentId);
    this.gateway.emitToUser(pending.toAgentId, 'agent.transfer.cancelled', { transferId, reason });
    this.gateway.emitToUser(pending.fromAgentId, 'agent.transfer.cancelled', { transferId, reason });

    if (pending.heldForOffer) {
      const call = await this.callModel.findById(pending.callId).exec();
      if (call && call.state === 'ON_HOLD') {
        this.settleHold(call);
        call.state = this.resumedState(call);
        await call.save();
        this.emitCallState(call);
      }
    }
    this.logger.log(`agent transfer ${transferId} cancelled: ${reason}`);
  }

  /**
   * The receiving agent takes the offer.
   *
   * BLIND      — ownership moves immediately, the original agent is removed
   *              from the room and dropped into wrap-up, the customer comes
   *              off hold to talk to whoever just arrived.
   * WARM       — the customer STAYS on hold; the two agents consult. Ownership
   *              only moves on `completeWarmTransfer`.
   * CONFERENCE — both agents stay, ownership does not move.
   */
  async acceptAgentTransfer(agentId: string, agentName: string, transferId: string): Promise<AgentTransferAcceptResult> {
    const pending = this.pendingOffers.get(transferId);
    if (!pending || pending.toAgentId !== agentId) throw new NotFoundException('Offer no longer active');
    clearTimeout(pending.timer);
    this.pendingOffers.delete(transferId);

    const call = await this.callModel.findById(pending.callId).exec();
    if (!call || !LIVE_CALL_STATES.includes(call.state)) {
      // The customer hung up inside the accept window; hand the agent back.
      await this.abandonAccept(pending, 'call already ended');
      throw new BadRequestException('That call has already ended.');
    }

    // Mint before mutating anything. If LiveKit is unreachable the accept must
    // fail cleanly — a half-accepted transfer leaves the customer parked on
    // hold with an agent reserved against a room they never joined, which is
    // the worst possible state on a live floor.
    let url: string;
    let token: string;
    let roomName: string;
    try {
      ({ url, token, roomName } = await this.livekit.mintToken(
        pending.callId,
        this.livekit.agentIdentity(agentId),
        agentName,
      ));
    } catch (err) {
      this.logger.error(`mintToken failed accepting transfer ${transferId}: ${(err as Error).message}`);
      await this.abandonAccept(pending, 'media plane unavailable');
      throw new BadRequestException('Could not join the call room — try again.');
    }
    await this.presence.markOnCall(agentId);
    this.addParticipant(call, pending.fromAgentId);
    this.addParticipant(call, agentId);

    if (pending.kind === 'BLIND') {
      await this.handOverOwnership(call, pending.fromAgentId, agentId);
    } else if (pending.kind === 'WARM') {
      // Customer stays parked; the consult happens between the two agents.
      this.warmHandovers.set(pending.callId, { fromAgentId: pending.fromAgentId, toAgentId: agentId });
      await call.save();
    } else {
      await call.save();
    }

    this.emitCallState(call);
    this.gateway.emitToUser(pending.fromAgentId, 'agent.transfer.accepted', { transferId, callId: pending.callId });
    this.logger.log(`agent transfer ${transferId} (${pending.kind}) accepted by ${agentId}`);

    return { ok: true, transferId, callId: pending.callId, kind: pending.kind, livekitUrl: url, livekitToken: token, roomName };
  }

  async declineAgentTransfer(agentId: string, transferId: string): Promise<{ ok: true }> {
    const pending = this.pendingOffers.get(transferId);
    if (!pending || pending.toAgentId !== agentId) throw new NotFoundException('Offer no longer active');
    await this.expireOffer(transferId, 'declined by the receiving agent');
    return { ok: true };
  }

  /** The originating agent changes their mind before the window elapses. */
  async cancelAgentTransfer(agentId: string, transferId: string): Promise<{ ok: true }> {
    const pending = this.pendingOffers.get(transferId);
    if (!pending || pending.fromAgentId !== agentId) throw new NotFoundException('Offer no longer active');
    await this.expireOffer(transferId, 'cancelled by the originating agent');
    return { ok: true };
  }

  /**
   * Move the call from one agent to another: reassign, evict the outgoing
   * agent from the room, un-park the customer, and put the outgoing agent in
   * wrap-up so they can write their notes.
   */
  private async handOverOwnership(call: CallDocument, fromAgentId: string, toAgentId: string): Promise<void> {
    call.transferredFromAgentId = new Types.ObjectId(fromAgentId);
    call.agentId = new Types.ObjectId(toAgentId);
    this.settleHold(call);
    call.state = this.resumedState(call);
    if (!call.bridgedAt) call.bridgedAt = new Date();
    await call.save();

    // Evict the outgoing agent's browser so its (possibly still playing) hold
    // track cannot leak over the new agent's audio.
    await this.livekit.removeParticipant(call._id.toString(), this.livekit.agentIdentity(fromAgentId));
    await this.parkInWrapUp(call.tenantId.toString(), fromAgentId, call._id.toString());
  }

  /**
   * Put an agent who just handed a call away into wrap-up. Their deadline is
   * tracked in-process rather than on the Call, because the Call has moved on
   * to a different agent — see `sweepWrapUp`.
   */
  private async parkInWrapUp(tenantId: string, agentId: string, callId: string): Promise<void> {
    const deadline = Date.now() + config.floor.wrapUpMaxSeconds * 1000;
    await this.presence.release(agentId, 'WRAP_UP');
    this.transferWrapUps.set(agentId, { deadline, tenantId });
    this.gateway.emitToTenant(tenantId, 'presence.updated', { userId: agentId, state: 'WRAP_UP' });
    this.gateway.emitToUser(agentId, 'wrapup.started', { callId, deadline });
  }

  /**
   * Finish a warm consult: the customer comes off hold onto the new agent and
   * the introducing agent drops out.
   */
  async completeWarmTransfer(tenantId: string, agentId: string, callId: string): Promise<{ ok: true }> {
    const call = await this.loadLiveCall(tenantId, agentId, callId);
    const handover = this.warmHandovers.get(callId);
    if (!handover) throw new BadRequestException('No warm transfer is in progress on this call.');
    if (handover.fromAgentId !== agentId && handover.toAgentId !== agentId) {
      throw new ForbiddenException('You are not part of this warm transfer.');
    }
    this.warmHandovers.delete(callId);

    await this.handOverOwnership(call, handover.fromAgentId, handover.toAgentId);
    this.emitCallState(call);
    this.logger.log(`warm transfer completed on call ${callId}: ${handover.fromAgentId} → ${handover.toAgentId}`);
    return { ok: true };
  }

  /**
   * Blind-transfer the customer off the platform (the client's office, a
   * different department, a partner).
   *
   * COST WARNING: this is a carrier-side REFER, so for as long as the customer
   * stays on the transferred call we are paying for a SECOND leg — the
   * original inbound/outbound leg is not released when the customer moves,
   * it is bridged onward. A five-minute external transfer bills ten minutes.
   * Supervisors should prefer an in-platform agent transfer where possible;
   * this exists for the cases where the destination is not on the platform.
   *
   * The customer is gone once this returns, so the call is finalised into
   * wrap-up: the agent still has to disposition it.
   */
  async transferExternal(
    tenantId: string,
    agentId: string,
    callId: string,
    destination: string,
  ): Promise<{ ok: true; destination: string }> {
    const call = await this.loadLiveCall(tenantId, agentId, callId);
    try {
      await this.livekit.transferSipToExternal(callId, destination);
    } catch (err) {
      this.logger.error(`external transfer of call ${callId} to ${destination} failed: ${(err as Error).message}`);
      throw new BadRequestException(`Could not transfer to ${destination}: ${(err as Error).message}`);
    }

    this.settleHold(call);
    const deadline = new Date(Date.now() + config.floor.wrapUpMaxSeconds * 1000);
    // Terminal state first so the racing `participant_left` webhook is a no-op.
    call.state = 'WRAP_UP';
    call.endReason = 'AGENT_HANGUP';
    call.endedAt = new Date();
    call.wrapUpDeadline = deadline;
    await call.save();
    this.warmHandovers.delete(callId);
    // The SIP leg has been REFERed away and the SDK only resolves once the
    // transfer completed, so tearing the room down cannot cut the customer off.
    await this.progress.releaseResources(call);

    await this.presence.release(agentId, 'WRAP_UP');
    this.gateway.emitToTenant(tenantId, 'presence.updated', { userId: agentId, state: 'WRAP_UP' });
    this.gateway.emitToUser(agentId, 'wrapup.started', { callId, deadline: deadline.getTime() });
    this.gateway.emitToUser(agentId, 'call.ended', { callId, reason: `transferred to ${destination}`, outcome: null });
    this.emitCallState(call, 'AGENT_HANGUP');
    this.logger.log(`call ${callId} transferred externally to ${destination} by agent ${agentId}`);
    return { ok: true, destination };
  }

  // ── B2. Agent hang-up (any call source) ─────────────────────────────────

  /**
   * The agent ends the call from the bar. Works for a bridged AI transfer, a
   * predictive bridge or a manual dial alike: persist WRAP_UP with a deadline
   * first (so a racing `participant_left` webhook is a no-op), then drop the
   * customer leg, stop the recording and free the pacing slot.
   */
  async hangupByAgent(tenantId: string, agentId: string, callId: string): Promise<{ ok: true; state: CallState }> {
    if (!Types.ObjectId.isValid(callId)) throw new NotFoundException('Call not found');
    const call = await this.callModel
      .findOne({ _id: new Types.ObjectId(callId), tenantId: new Types.ObjectId(tenantId) })
      .exec();
    if (!call) throw new NotFoundException('Call not found');
    const onCall =
      call.agentId?.toString() === agentId || call.participantAgentIds.some((id) => id.toString() === agentId);
    if (!onCall) throw new ForbiddenException('This call belongs to another agent.');
    if (!LIVE_CALL_STATES.includes(call.state)) return { ok: true, state: call.state };

    this.settleHold(call);
    const deadline = new Date(Date.now() + config.floor.wrapUpMaxSeconds * 1000);
    call.state = 'WRAP_UP';
    call.wrapUpDeadline = deadline;
    if (!call.endReason) call.endReason = 'AGENT_HANGUP';
    if (!call.endedAt) call.endedAt = new Date();
    if (!call.outcome && call.answeredAt) call.outcome = 'ANSWERED_HUMAN';
    await call.save();
    this.warmHandovers.delete(callId);

    await this.progress.releaseResources(call);

    for (const id of [call.agentId?.toString(), ...call.participantAgentIds.map((p) => p.toString())]) {
      if (!id) continue;
      const to = id === call.agentId?.toString() ? 'WRAP_UP' : 'AVAILABLE';
      await this.presence.release(id, to);
      this.gateway.emitToTenant(tenantId, 'presence.updated', { userId: id, state: to });
      this.gateway.emitToUser(id, 'call.ended', { callId, reason: 'AGENT_HANGUP', outcome: call.outcome ?? null });
      if (to === 'WRAP_UP') this.gateway.emitToUser(id, 'wrapup.started', { callId, deadline: deadline.getTime() });
    }
    this.emitCallState(call, 'AGENT_HANGUP');
    this.logger.log(`call ${callId} hung up by agent ${agentId}`);
    return { ok: true, state: call.state };
  }

  // ── C. Call-bar recovery ────────────────────────────────────────────────

  /**
   * "What am I on right now?" — the answer that survives an F5.
   *
   * Everything the call bar renders comes from the server, including a FRESH
   * LiveKit token: the browser's old token died with the page, so without a
   * new one the agent watches a live customer they cannot hear. This is the
   * single highest-value endpoint on the agent desktop.
   *
   * Membership is `agentId` OR `participantAgentIds` so an agent who reloads
   * mid-conference recovers too.
   */
  async currentCall(tenantId: string, agentId: string): Promise<CurrentCallState | null> {
    const oid = new Types.ObjectId(agentId);
    // WRAP_UP is included so an un-dispositioned call survives a reload: the
    // bar comes back in its "ended, disposition needed" state instead of the
    // agent being blocked from dialing by a record they can no longer see.
    const call = await this.callModel
      .findOne({
        tenantId: new Types.ObjectId(tenantId),
        $or: [
          { state: { $in: [...LIVE_CALL_STATES] }, $or: [{ agentId: oid }, { participantAgentIds: oid }] },
          { state: 'WRAP_UP', agentId: oid, disposition: null },
        ],
      })
      .sort({ startedAt: -1 })
      .exec();
    if (!call) return null;

    const callId = call._id.toString();
    const [lead, campaign, transfer] = await Promise.all([
      this.leadModel.findById(call.leadId).select('firstName lastName phone').lean().exec(),
      this.campaignModel.findById(call.campaignId).select('name').lean().exec(),
      // The card is snapshotted on the Transfer at offer time (XFER-05); if
      // this call arrived as an AI warm transfer we re-serve that same card so
      // the agent's context panel survives the reload with the call bar.
      this.transferModel
        .findOne({ callId: call._id, card: { $exists: true, $ne: null } })
        .sort({ createdAt: -1 })
        .select('card')
        .lean()
        .exec(),
    ]);

    // Degrade rather than 500 when LiveKit is not configured (simulation /
    // local dev): the call bar can still render state, timers and disposition.
    let livekitUrl = '';
    let livekitToken = '';
    let roomName = this.livekit.roomName(callId);
    if (this.livekit.isConfigured() && LIVE_CALL_STATES.includes(call.state)) {
      const minted = await this.livekit.mintToken(callId, this.livekit.agentIdentity(agentId), agentId);
      livekitUrl = minted.url;
      livekitToken = minted.token;
      roomName = minted.roomName;
    }

    return {
      callId,
      leadId: call.leadId.toString(),
      leadName: [lead?.firstName, lead?.lastName].filter(Boolean).join(' ') || (lead?.phone ?? 'Unknown'),
      phone: lead?.phone ?? '',
      campaignId: call.campaignId.toString(),
      campaignName: campaign?.name ?? '',
      state: call.state,
      manual: call.manual,
      agentId: call.agentId?.toString() ?? null,
      wrapUpDeadline: call.wrapUpDeadline?.getTime() ?? null,
      startedAt: call.startedAt.getTime(),
      bridgedAt: call.bridgedAt?.getTime() ?? null,
      onHold: call.state === 'ON_HOLD',
      cli: call.cli ?? null,
      livekitUrl,
      livekitToken,
      roomName,
      transferCard: (transfer?.card as unknown as TransferCard) ?? null,
    };
  }

  // ── E. Wrap-up sweep ────────────────────────────────────────────────────

  /**
   * Auto-return agents whose wrap-up has expired.
   *
   * This lives here rather than in PresenceService because it emits over the
   * realtime gateway, and PresenceService cannot depend on the gateway — the
   * gateway already depends on it, so injecting it back would be a DI cycle.
   * CallControlService sits above both, so it can talk to each.
   *
   * Two arms, because there are two ways to end up in wrap-up:
   *   1. the Call still points at the agent (hangup / external transfer) —
   *      the deadline is on the Call and survives a restart; and
   *   2. the agent handed the call to someone else, so the Call points at the
   *      NEW agent — the deadline is in `transferWrapUps` (in-process, see the
   *      class comment; worst case after a restart the agent clicks Available
   *      themselves).
   */
  @Interval(15_000)
  async sweepWrapUp(): Promise<void> {
    const now = new Date();
    // Deliberately NOT filtered on `state: 'WRAP_UP'`. A manual dial parks the
    // call itself in WRAP_UP, but an AI call that ends is COMPLETED/FAILED
    // while its *agent* is the one in wrap-up — filtering on call state would
    // silently strand every bridged AI-transfer agent. The deadline's presence
    // is the signal; `returnFromWrapUp` is what checks the agent is still in
    // wrap-up and refuses to yank them out of anything else.
    const due = await this.callModel
      .find({ wrapUpDeadline: { $ne: null, $lte: now } })
      .select('_id tenantId agentId')
      .lean()
      .exec();

    for (const call of due) {
      const callId = call._id.toString();
      // Clear the deadline first: if the presence write below throws we must
      // not re-sweep the same call every 15 seconds forever.
      await this.callModel.updateOne({ _id: call._id }, { $unset: { wrapUpDeadline: '' } }).exec();
      if (!call.agentId) continue;
      const agentId = call.agentId.toString();
      const returned = await this.presence.returnFromWrapUp(agentId);
      if (returned) {
        this.gateway.emitToTenant(call.tenantId.toString(), 'presence.updated', { userId: agentId, state: returned });
        this.logger.log(`wrap-up expired on call ${callId}; agent ${agentId} returned to ${returned}`);
      }
    }

    for (const [agentId, entry] of [...this.transferWrapUps.entries()]) {
      if (entry.deadline > Date.now()) continue;
      this.transferWrapUps.delete(agentId);
      const returned = await this.presence.returnFromWrapUp(agentId);
      if (returned) {
        this.gateway.emitToTenant(entry.tenantId, 'presence.updated', { userId: agentId, state: returned });
        this.logger.log(`post-transfer wrap-up expired; agent ${agentId} returned to ${returned}`);
      }
    }
  }
}
