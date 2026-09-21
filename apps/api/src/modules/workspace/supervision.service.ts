import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { LIVE_CALL_STATES, type SupervisableCall, type SupervisionMode, type SupervisionSession } from '@cocally/shared';
import { Model, Types } from 'mongoose';
import { Call, CallDocument } from '../../schemas/call.schema';
import { Campaign, CampaignDocument } from '../../schemas/campaign.schema';
import { Lead, LeadDocument } from '../../schemas/lead.schema';
import { User, UserDocument } from '../../schemas/user.schema';
import { LivekitService } from '../telephony/livekit.service';
import { RealtimeGateway } from './realtime.gateway';

/**
 * How long to keep re-applying whisper isolation after the supervisor joins.
 *
 * The supervisor's microphone track does not exist at the instant the token is
 * minted — the browser still has to connect, negotiate and publish. Until that
 * track exists there is nothing for `applyWhisperSubscriptions` to unsubscribe
 * the customer from, so a single call at attach time is a no-op and the very
 * first coaching sentence goes straight down the customer's leg.
 *
 * Six attempts at 500ms covers ~3s of join latency, which is generously above
 * a normal LiveKit connect (200-800ms) while still failing loudly rather than
 * spinning forever.
 */
const WHISPER_ISOLATION_ATTEMPTS = 6;
const WHISPER_ISOLATION_DELAY_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Supervisor monitor / whisper / barge.
 *
 * All three modes are the *same* media path — the supervisor joins the call's
 * existing LiveKit room. What differs is only (a) the grants baked into their
 * token and (b) who is subscribed to their tracks:
 *
 *   MONITOR — `canPublish:false, hidden:true`. Genuinely silent: they cannot
 *             physically publish audio even if a client tried, and `hidden`
 *             keeps them out of the participant list, so the agent's UI does
 *             not render them at all. This is deliberate — a monitoring
 *             supervisor whose presence pops up on the agent's screen is not
 *             monitoring, it is announcing. The audit trail for a silent join
 *             is the SUPERVISION_ATTACHED compliance event on the Call, not
 *             the agent's screen.
 *   WHISPER — publishes, but the customer's SIP leg is explicitly
 *             unsubscribed from the supervisor's tracks, so coaching reaches
 *             the agent only.
 *   BARGE   — publishes to everyone (LiveKit auto-subscribe does the rest).
 *
 * There is no second conference, no mixer and no extra carrier leg, which is
 * why mode changes are instant and cost nothing.
 */
@Injectable()
export class SupervisionService {
  private readonly logger = new Logger(SupervisionService.name);

  constructor(
    @InjectModel(Call.name) private readonly callModel: Model<CallDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
    @InjectModel(Campaign.name) private readonly campaignModel: Model<CampaignDocument>,
    private readonly livekit: LivekitService,
    private readonly gateway: RealtimeGateway,
  ) {}

  /**
   * Every live call in the tenant, joined to the names a supervisor actually
   * needs to choose one. Without the join this list is a wall of ObjectIds.
   *
   * The three lookups are batched rather than per-call so a 40-seat floor
   * costs four queries, not 120.
   */
  async listSupervisable(tenantId: string): Promise<SupervisableCall[]> {
    const calls = await this.callModel
      .find({ tenantId: new Types.ObjectId(tenantId), state: { $in: [...LIVE_CALL_STATES] } })
      .sort({ startedAt: -1 })
      .lean()
      .exec();
    if (calls.length === 0) return [];

    const agentIds = [...new Set(calls.map((c) => c.agentId?.toString()).filter((id): id is string => Boolean(id)))];
    const leadIds = [...new Set(calls.map((c) => c.leadId.toString()))];
    const campaignIds = [...new Set(calls.map((c) => c.campaignId.toString()))];

    const [agents, leads, campaigns] = await Promise.all([
      agentIds.length
        ? this.userModel
            .find({ _id: { $in: agentIds.map((id) => new Types.ObjectId(id)) } }, { name: 1 })
            .lean()
            .exec()
        : Promise.resolve([]),
      this.leadModel
        .find({ _id: { $in: leadIds.map((id) => new Types.ObjectId(id)) } }, { firstName: 1, lastName: 1, phone: 1 })
        .lean()
        .exec(),
      this.campaignModel
        .find({ _id: { $in: campaignIds.map((id) => new Types.ObjectId(id)) } }, { name: 1 })
        .lean()
        .exec(),
    ]);

    const agentNames = new Map(agents.map((a) => [a._id.toString(), a.name]));
    const leadNames = new Map(
      leads.map((l) => [l._id.toString(), [l.firstName, l.lastName].filter(Boolean).join(' ') || l.phone]),
    );
    const campaignNames = new Map(campaigns.map((c) => [c._id.toString(), c.name]));

    return calls.map((call) => {
      const agentId = call.agentId?.toString() ?? null;
      return {
        callId: call._id.toString(),
        agentId,
        agentName: agentId ? (agentNames.get(agentId) ?? null) : null,
        // A live call always has a lead and a campaign; the fallbacks exist
        // only so a deleted record cannot blank the whole supervisor list.
        leadName: leadNames.get(call.leadId.toString()) ?? 'Unknown lead',
        campaignName: campaignNames.get(call.campaignId.toString()) ?? 'Unknown campaign',
        state: call.state,
        startedAt: call.startedAt.getTime(),
        manual: call.manual,
        supervised: call.supervisionMode ?? null,
      } satisfies SupervisableCall;
    });
  }

  /**
   * Attach a supervisor to a live call and hand back room credentials scoped
   * to the requested mode.
   *
   * Ordering matters: the compliance event and the persisted
   * `supervisorId`/`supervisionMode` are written *before* the credentials are
   * returned, so a supervisor can never be in the room without the Call
   * document recording that they are. A silent join on a recorded call that
   * leaves no trace is the exact failure mode a regulator asks about.
   */
  async attach(
    tenantId: string,
    supervisor: { userId: string; name?: string },
    callId: string,
    mode: SupervisionMode,
  ): Promise<SupervisionSession> {
    if (!this.livekit.isConfigured()) {
      throw new BadRequestException('LiveKit is not configured — supervision needs a live media plane');
    }
    const call = await this.loadLiveCall(tenantId, callId);

    // One supervisor per call. Two supervisors publishing into the same room
    // is not "two coaches", it is two voices in the agent's ear, and the
    // whisper isolation below only tracks one identity.
    const existing = call.supervisorId?.toString();
    if (existing && existing !== supervisor.userId) {
      throw new ConflictException('Another supervisor is already attached to this call');
    }

    const supervisorName = supervisor.name ?? (await this.supervisorName(supervisor.userId));
    const minted = await this.livekit.mintSupervisorToken(callId, supervisor.userId, supervisorName, mode);

    call.supervisorId = new Types.ObjectId(supervisor.userId);
    call.supervisionMode = mode;
    call.complianceEvents.push({
      atMs: Date.now() - call.startedAt.getTime(),
      kind: 'SUPERVISION_ATTACHED',
      detail: `${supervisorName} (${supervisor.userId}) attached in ${mode} mode`,
    });
    await call.save();

    if (mode === 'WHISPER') {
      // Fire-and-forget: the HTTP response must not wait ~3s for the
      // supervisor's browser to finish publishing. `void` + `.catch` so an
      // unhandled rejection can never take the process down.
      void this.isolateWhisperWhenTracksAppear(callId, minted.identity).catch((err) => {
        this.logger.error(`whisper isolation crashed on call ${callId}: ${(err as Error).message}`);
      });
    }
    // BARGE needs no subscription work on attach: LiveKit auto-subscribes new
    // participants to new tracks, so the customer hears the supervisor as soon
    // as they publish. Only the whisper→barge transition has to *undo* an
    // earlier explicit unsubscribe — see changeMode().

    this.announce(call, mode, supervisorName);

    this.logger.log(`supervisor ${supervisor.userId} attached to call ${callId} in ${mode}`);
    return this.session(callId, mode, minted, await this.subscribeTargets(callId, minted.identity));
  }

  /**
   * Switch an attached supervisor between modes.
   *
   * WHISPER ↔ BARGE is purely a subscription change: both tokens carry
   * `canPublish:true`, so the supervisor stays connected and the returned
   * credentials can be ignored by the client — no rejoin, no gap in audio.
   *
   * Crossing the MONITOR boundary is different: MONITOR's token has
   * `canPublish:false` and `hidden:true`, which are baked into the JWT and
   * cannot be changed on a live connection. The client MUST reconnect with the
   * token returned here for those transitions — hence a session is returned in
   * every case rather than a bare ok.
   */
  async changeMode(
    tenantId: string,
    supervisorId: string,
    callId: string,
    mode: SupervisionMode,
  ): Promise<SupervisionSession & { rejoinRequired: boolean }> {
    const call = await this.loadLiveCall(tenantId, callId);
    if (call.supervisorId?.toString() !== supervisorId) {
      throw new ConflictException('You are not the supervisor attached to this call');
    }
    const previous: SupervisionMode = call.supervisionMode ?? 'MONITOR';
    if (previous === mode) {
      const same = await this.livekit.mintSupervisorToken(callId, supervisorId, await this.supervisorName(supervisorId), mode);
      return {
        ...this.session(callId, mode, same, await this.subscribeTargets(callId, same.identity)),
        rejoinRequired: false,
      };
    }

    const identity = this.livekit.supervisorIdentity(supervisorId);
    const supervisorName = await this.supervisorName(supervisorId);
    const minted = await this.livekit.mintSupervisorToken(callId, supervisorId, supervisorName, mode);

    if (mode === 'WHISPER') {
      // Coming from BARGE the supervisor is already publishing, so isolation
      // can usually be applied on the first attempt — but the retry loop is
      // reused because coming from MONITOR the track genuinely does not exist
      // until the client reconnects with the new token.
      void this.isolateWhisperWhenTracksAppear(callId, identity).catch((err) => {
        this.logger.error(`whisper isolation crashed on call ${callId}: ${(err as Error).message}`);
      });
    } else if (mode === 'BARGE') {
      // Undo the whisper unsubscribe so the customer hears the supervisor.
      await this.livekit.applyBargeSubscriptions(callId, identity);
    }

    call.supervisionMode = mode;
    await call.save();
    this.announce(call, mode, supervisorName);

    // Publish rights differ between MONITOR and the other two, and those live
    // in the signed token — so only a mode change that touches MONITOR forces
    // the client to reconnect.
    const rejoinRequired = previous === 'MONITOR' || mode === 'MONITOR';
    this.logger.log(`call ${callId} supervision ${previous} → ${mode} (rejoin=${rejoinRequired})`);
    return {
      ...this.session(callId, mode, minted, await this.subscribeTargets(callId, identity)),
      rejoinRequired,
    };
  }

  /**
   * Detach: evict the supervisor's participant, clear the call fields, tell
   * the floor.
   *
   * The participant is removed server-side rather than trusting the client to
   * disconnect — a supervisor who closes their laptop lid mid-barge would
   * otherwise stay in the room, still audible, with the Call document claiming
   * nobody is supervising.
   */
  async detach(tenantId: string, supervisorId: string, callId: string): Promise<{ ok: true }> {
    const call = await this.callModel
      .findOne({ _id: new Types.ObjectId(callId), tenantId: new Types.ObjectId(tenantId) })
      .exec();
    if (!call) throw new NotFoundException('Call not found');

    const attached = call.supervisorId?.toString();
    if (attached && attached !== supervisorId) {
      throw new ConflictException('You are not the supervisor attached to this call');
    }

    const previous: SupervisionMode | null = call.supervisionMode ?? null;
    await this.livekit.removeParticipant(callId, this.livekit.supervisorIdentity(supervisorId));

    // $unset rather than assigning undefined: mongoose skips undefined on
    // save(), which would silently leave the old supervisor on the document.
    await this.callModel
      .updateOne({ _id: call._id }, { $unset: { supervisorId: '', supervisionMode: '' } })
      .exec();

    call.supervisorId = undefined;
    call.supervisionMode = undefined;
    // A MONITOR session the agent was never told about must not announce its
    // own ending — a "supervision ended" toast is exactly as revealing as a
    // "supervision started" one.
    this.announce(call, null, null, { notifyAgent: previous !== 'MONITOR' });

    this.logger.log(`supervisor ${supervisorId} detached from call ${callId}`);
    return { ok: true };
  }

  // ── internals ───────────────────────────────────────────────────────────

  private async loadLiveCall(tenantId: string, callId: string): Promise<CallDocument> {
    if (!Types.ObjectId.isValid(callId)) throw new NotFoundException('Call not found');
    const call = await this.callModel
      .findOne({ _id: new Types.ObjectId(callId), tenantId: new Types.ObjectId(tenantId) })
      .exec();
    if (!call) throw new NotFoundException('Call not found');
    if (!LIVE_CALL_STATES.includes(call.state)) {
      throw new BadRequestException(`Call is ${call.state} — only a live call can be supervised`);
    }
    return call;
  }

  private async supervisorName(supervisorId: string): Promise<string> {
    const user = await this.userModel.findById(new Types.ObjectId(supervisorId), { name: 1 }).lean().exec();
    return user?.name ?? 'Supervisor';
  }

  private session(
    callId: string,
    mode: SupervisionMode,
    minted: { url: string; token: string; roomName: string; identity: string },
    subscribeTo: string[],
  ): SupervisionSession {
    return {
      callId,
      mode,
      livekitUrl: minted.url,
      livekitToken: minted.token,
      roomName: minted.roomName,
      subscribeTo,
    };
  }

  /**
   * Who the supervisor should listen to — everyone else in the room.
   *
   * This is the same in all three modes: a whispering supervisor still needs to
   * hear the customer, otherwise they are coaching blind. Whisper isolation is
   * enforced on the *customer's* subscriptions (the customer stops hearing the
   * supervisor), never on the supervisor's.
   */
  private async subscribeTargets(callId: string, supervisorIdentity: string): Promise<string[]> {
    const participants = await this.livekit.listParticipants(callId);
    return participants.map((p) => p.identity).filter((identity) => identity !== supervisorIdentity);
  }

  /**
   * Poll until the supervisor has actually published a track, then unsubscribe
   * the customer from it.
   *
   * Retrying is not optional. `applyWhisperSubscriptions` is a no-op when the
   * supervisor has no tracks yet, and the supervisor's browser typically takes
   * several hundred milliseconds after receiving the token to connect and
   * publish. Applying once at attach time therefore silently does nothing, and
   * the first thing the supervisor says is heard by the customer — a live
   * compliance incident, not a cosmetic bug.
   *
   * If every attempt fails we log at error level: the safe assumption is that
   * the customer CAN hear the supervisor, and the floor needs to know.
   */
  private async isolateWhisperWhenTracksAppear(callId: string, supervisorIdentity: string): Promise<void> {
    for (let attempt = 1; attempt <= WHISPER_ISOLATION_ATTEMPTS; attempt += 1) {
      await sleep(WHISPER_ISOLATION_DELAY_MS);

      // The supervisor may have switched to BARGE (or detached) while we were
      // sleeping. Applying the unsubscribe now would silently mute a barge —
      // the supervisor would be talking to a customer who cannot hear them —
      // so re-read the authoritative mode before touching subscriptions.
      const current = await this.callModel
        .findById(new Types.ObjectId(callId), { supervisionMode: 1 })
        .lean()
        .exec();
      if (current?.supervisionMode !== 'WHISPER') {
        this.logger.log(`whisper isolation on call ${callId} abandoned — mode is now ${current?.supervisionMode ?? 'none'}`);
        return;
      }

      const participants = await this.livekit.listParticipants(callId);
      const supervisor = participants.find((p) => p.identity === supervisorIdentity);
      // Not in the room yet / no published track yet — this is the normal case
      // on the first attempt or two, so keep waiting rather than giving up.
      if (!supervisor || supervisor.tracks.length === 0) continue;

      await this.livekit.applyWhisperSubscriptions(callId, supervisorIdentity);
      this.logger.log(`whisper isolation applied on call ${callId} after ${attempt} attempt(s)`);
      return;
    }
    this.logger.error(
      `whisper isolation NEVER took on call ${callId} after ${WHISPER_ISOLATION_ATTEMPTS} attempts — ` +
        'assume the customer can hear the supervisor',
    );
  }

  /**
   * Broadcast the supervision state change.
   *
   * Tenant-wide always, so every supervisor console sees the call is taken.
   *
   * The *agent* is told only for WHISPER and BARGE. That asymmetry is
   * deliberate and is the whole point of MONITOR: the token already hides the
   * supervisor from the participant list, so pushing an event that renders
   * "Alice is monitoring you" would defeat it. Whisper and barge are audible,
   * so the agent must know whose voice just appeared. The auditable record of
   * a silent join is the SUPERVISION_ATTACHED compliance event on the Call.
   */
  private announce(
    call: CallDocument,
    mode: SupervisionMode | null,
    supervisorName: string | null,
    options?: { notifyAgent?: boolean },
  ): void {
    const payload = { callId: call._id.toString(), mode, supervisorName };
    const agentId = call.agentId?.toString();

    // The tenant-wide emit is what supervisors and wallboards listen on — but
    // the monitored agent is in `tenant:<id>` too, so broadcasting a MONITOR
    // attach there would put "Alice is monitoring you" on their socket and
    // defeat the hidden grant entirely. Relying on the client to drop it is
    // not a control: anyone with devtools sees it.
    //
    // So MONITOR is fanned out per-recipient, skipping the agent on the call.
    // Whisper and barge are audible by definition, so there is nothing to
    // conceal and the cheap broadcast is correct.
    if (mode === 'MONITOR') {
      this.gateway.emitToTenantExcept(call.tenantId.toString(), agentId ?? null, 'supervision.changed', payload);
      return;
    }

    this.gateway.emitToTenant(call.tenantId.toString(), 'supervision.changed', payload);
    if (!agentId) return;
    if (options?.notifyAgent === false) return;
    this.gateway.emitToUser(agentId, 'supervision.changed', payload);
  }
}
