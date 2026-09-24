import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { LIVE_CALL_STATES } from '@cocally/shared';
import { Model, Types } from 'mongoose';
import { config } from '../../common/config';
import { Call, CallDocument } from '../../schemas/call.schema';
import { Campaign, CampaignDocument } from '../../schemas/campaign.schema';
import { Lead, LeadDocument } from '../../schemas/lead.schema';
import { Tenant, TenantDocument } from '../../schemas/tenant.schema';
import { User, UserDocument } from '../../schemas/user.schema';
import { CountryPacksService } from '../country-packs/country-packs.service';
import { isWithinCallingWindow, nextWindowOpen } from '../country-packs/calling-windows';
import { AssignmentService } from '../leads/assignment.service';
import { SuppressionService } from '../leads/suppression.service';
import { PresenceService } from '../workspace/presence.service';
import { RealtimeGateway } from '../workspace/realtime.gateway';
import { CliService } from './cli.service';
import { LivekitService } from './livekit.service';

const DIALABLE_STATES = ['FRESH', 'ATTEMPTED', 'CONTACTED', 'CALLBACK'];

export interface ManualDialResult {
  callId: string;
  leadName: string;
  phone: string;
  cli: string | null;
  /** LiveKit room join details for the agent's browser — see `connect()`. */
  livekitUrl: string;
  livekitToken: string;
  roomName: string;
}

export interface ManualLeadRow {
  id: string;
  name: string;
  phone: string;
  location: string;
  state_: string;
  score: number;
  attempts: number;
  campaignId: string;
  campaignName: string;
  claimedByMe: boolean;
  claimedByOther: boolean;
  callableNow: boolean;
  blockReason: string | null;
  resumesAt: string | null;
}

/**
 * Human-driven ("preview"/manual) dialing per XFER-01 / ViciDial-style flow.
 * A human agent picks a specific lead and places the call themselves; the AI
 * auto-dialer never touches a claimed lead (see DialerService.dialableFilter).
 *
 * Compliance is NOT skipped: the same legal gates the auto-dialer enforces
 * (tenant kill switch, per-lead legal calling window, DNC/suppression stack)
 * are checked here. Only the *operational* gates (pacing, agent-availability)
 * are skipped — a human manually dialing is present by definition.
 *
 * `dial()` + `connect()` place a real carrier call over whichever outbound SIP
 * trunk `LIVEKIT_SIP_TRUNK_ID` points at: the agent's browser joins the
 * LiveKit room first (dial()), then `connect()` sends the SIP INVITE with the
 * selected CLI on `From` — see claude-dev/2026-07-23-human-dialing-requirements.md
 * R1/R2. The agent dispositions the call exactly as they would a bridged AI
 * transfer once it ends.
 */
@Injectable()
export class ManualDialService {
  private readonly logger = new Logger(ManualDialService.name);

  constructor(
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
    @InjectModel(Campaign.name) private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(Call.name) private readonly callModel: Model<CallDocument>,
    @InjectModel(Tenant.name) private readonly tenantModel: Model<TenantDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly packs: CountryPacksService,
    private readonly suppression: SuppressionService,
    private readonly presence: PresenceService,
    private readonly gateway: RealtimeGateway,
    private readonly assignment: AssignmentService,
    private readonly cli: CliService,
    private readonly livekit: LivekitService,
  ) {}

  /** Campaign ids this agent may manually dial (skill match, or unrestricted). */
  private async allowedCampaigns(tenantId: string, agentId: string): Promise<CampaignDocument[]> {
    const agent = await this.userModel.findById(agentId).select('skills').lean().exec();
    if (!agent) return [];
    const campaigns = await this.campaignModel
      .find({ tenantId: new Types.ObjectId(tenantId), status: { $ne: 'COMPLETED' } })
      .exec();
    // No skills = unrestricted (eligible for every campaign), matching XFER-01.
    if (agent.skills.length === 0) return campaigns;
    return campaigns.filter((c) => agent.skills.includes(c._id.toString()));
  }

  /**
   * The agent's PERSONAL manual worklist.
   *
   * Previously this returned the same score-sorted head of the campaign to every
   * agent, so a 15-seat floor had 15 people racing for the same records and 14
   * losing every click. Now the worklist is partitioned by lead ownership: the
   * agent is topped up from the unowned pool, then sees only what they own.
   *
   * `topUp` is what keeps the queue full, so an agent who works through their
   * book simply draws more instead of running dry or reaching into someone
   * else's. Ownership is not a lock on dialing — the legal gates below still
   * decide whether any given lead is callable right now.
   */
  async queue(tenantId: string, agentId: string, campaignId?: string): Promise<ManualLeadRow[]> {
    const campaigns = (await this.allowedCampaigns(tenantId, agentId)).filter(
      (c) => !campaignId || c._id.toString() === campaignId,
    );
    if (campaigns.length === 0) return [];
    const byId = new Map(campaigns.map((c) => [c._id.toString(), c]));
    const tenant = await this.tenantModel.findById(tenantId).lean().exec();
    const killed = !tenant || tenant.paused || !tenant.active;

    // Draw fresh work into this agent's book before rendering it.
    await this.assignment.topUp(
      tenantId,
      agentId,
      campaigns.map((c) => c._id),
    );

    const leads = await this.leadModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        campaignId: { $in: campaigns.map((c) => c._id) },
        state_: { $in: DIALABLE_STATES },
        ownerId: new Types.ObjectId(agentId),
      })
      .sort({ score: -1, nextAttemptAt: 1 })
      .limit(200)
      .exec();

    // Country packs are per-campaign, not per-lead — resolve once instead of
    // once per row (this was 200 awaits on every worklist refresh, per agent).
    const packByCode = new Map(
      await Promise.all(
        [...new Set(campaigns.map((c) => c.countryPackCode))].map(
          async (code) => [code, await this.packs.getByCode(code)] as const,
        ),
      ),
    );

    const rows: ManualLeadRow[] = [];
    for (const lead of leads) {
      const campaign = byId.get(lead.campaignId?.toString() ?? '');
      if (!campaign) continue;
      const pack = packByCode.get(campaign.countryPackCode);
      if (!pack) continue;

      let callableNow = true;
      let blockReason: string | null = null;
      let resumesAt: string | null = null;
      if (killed) {
        callableNow = false;
        blockReason = 'Dialing is halted by the account kill switch.';
      } else if (!isWithinCallingWindow(pack, lead.timezone)) {
        callableNow = false;
        blockReason = `Outside legal calling hours (${lead.timezone}).`;
        resumesAt = nextWindowOpen(pack, lead.timezone)?.toISOString() ?? null;
      } else if (lead.nextAttemptAt && lead.nextAttemptAt.getTime() > Date.now()) {
        // The retry matrix is still holding this lead back.
        callableNow = false;
        blockReason = 'Scheduled for a later retry.';
        resumesAt = lead.nextAttemptAt.toISOString();
      }

      const claimedBy = lead.manualClaimedBy?.toString();
      rows.push({
        id: lead._id.toString(),
        name: [lead.firstName, lead.lastName].filter(Boolean).join(' ') || 'Unknown',
        phone: lead.phone,
        location: [lead.suburb, lead.state].filter(Boolean).join(', '),
        state_: lead.state_,
        score: lead.score,
        attempts: lead.attempts,
        campaignId: campaign._id.toString(),
        campaignName: campaign.name,
        claimedByMe: claimedBy === agentId,
        claimedByOther: Boolean(claimedBy) && claimedBy !== agentId,
        callableNow: callableNow && (!claimedBy || claimedBy === agentId),
        blockReason,
        resumesAt,
      });
    }
    return rows;
  }

  private async loadClaimable(tenantId: string, agentId: string, leadId: string): Promise<LeadDocument> {
    if (!Types.ObjectId.isValid(leadId)) throw new NotFoundException('Lead not found');
    const lead = await this.leadModel
      .findOne({ _id: new Types.ObjectId(leadId), tenantId: new Types.ObjectId(tenantId) })
      .exec();
    if (!lead) throw new NotFoundException('Lead not found');
    const allowed = await this.allowedCampaigns(tenantId, agentId);
    if (!allowed.some((c) => c._id.toString() === lead.campaignId?.toString())) {
      throw new ForbiddenException('This lead is not in one of your campaigns.');
    }
    // Ownership is the floor's anti-collision guarantee, so enforce it server-side
    // too — a stale worklist tab must not let one agent dial another's lead.
    const owner = lead.ownerId?.toString();
    if (owner && owner !== agentId) {
      throw new ForbiddenException('This lead is assigned to another agent.');
    }
    return lead;
  }

  /** Claim a lead for manual dialing — hides it from the auto-dialer. */
  async claim(tenantId: string, agentId: string, leadId: string): Promise<{ ok: true }> {
    const lead = await this.loadClaimable(tenantId, agentId, leadId);
    const claimedBy = lead.manualClaimedBy?.toString();
    if (claimedBy && claimedBy !== agentId) throw new BadRequestException('Lead is already claimed by another agent.');
    lead.manualClaimedBy = new Types.ObjectId(agentId);
    lead.manualClaimedAt = new Date();
    lead.timeline.push({ at: new Date(), kind: 'MANUAL_CLAIM', detail: 'Claimed for manual dialing' });
    await lead.save();
    return { ok: true };
  }

  /** Release a claim without dialing. */
  async release(tenantId: string, agentId: string, leadId: string): Promise<{ ok: true }> {
    const lead = await this.loadClaimable(tenantId, agentId, leadId);
    if (lead.manualClaimedBy?.toString() === agentId) {
      lead.manualClaimedBy = undefined;
      lead.manualClaimedAt = undefined;
      lead.timeline.push({ at: new Date(), kind: 'MANUAL_RELEASE', detail: 'Manual claim released' });
      await lead.save();
    }
    return { ok: true };
  }

  /**
   * Step 1 of 2: claims the lead, opens the LiveKit room, and hands the agent's
   * browser a join token — but does NOT dial the carrier yet.
   *
   * The actual SIP leg is placed by `connect()`, called once the agent's
   * browser has confirmed it is in the room with its mic published. Dialling
   * before the agent joins risks the customer answering to silence; see
   * claude-dev/2026-07-23-human-dialing-requirements.md R1.
   */
  async dial(
    tenantId: string,
    agent: { id: string; email: string },
    leadId: string,
  ): Promise<ManualDialResult> {
    const lead = await this.loadClaimable(tenantId, agent.id, leadId);
    if (lead.manualClaimedBy && lead.manualClaimedBy.toString() !== agent.id) {
      throw new BadRequestException('Lead is claimed by another agent.');
    }
    if (!DIALABLE_STATES.includes(lead.state_)) {
      throw new BadRequestException(`This lead is ${lead.state_} and cannot be dialed.`);
    }
    // The AI dialer may be talking to this person right now (its lock is
    // refreshed at placement); a stale worklist tab must not ring them twice.
    const liveCall = await this.callModel
      .findOne({ leadId: lead._id, state: { $in: [...LIVE_CALL_STATES] } })
      .select('_id')
      .lean()
      .exec();
    if (liveCall) throw new BadRequestException('This lead is on a call right now.');
    const campaign = await this.campaignModel.findById(lead.campaignId).exec();
    if (!campaign) throw new NotFoundException('Campaign not found for lead.');

    // ── Legal gates (never skipped) ──────────────────────────────────────
    const tenant = await this.tenantModel.findById(tenantId).lean().exec();
    if (!tenant || tenant.paused || !tenant.active) {
      throw new BadRequestException('Dialing is halted by the account kill switch.');
    }
    const pack = await this.packs.getByCode(campaign.countryPackCode);
    if (!isWithinCallingWindow(pack, lead.timezone)) {
      throw new BadRequestException(`Outside legal calling hours for ${lead.timezone}.`);
    }
    const verdict = await this.suppression.checkAtDialTime({
      tenantId,
      clientId: lead.clientId.toString(),
      phone: lead.phone,
      countryPackCode: campaign.countryPackCode,
      dncEnforced: pack.dnc.enforced,
      frequencyCapDays: campaign.frequencyCapDays,
      skipFrequencyCap: lead.state_ === 'CALLBACK',
    });
    if (!verdict.allowed) {
      throw new BadRequestException(`Blocked by compliance: ${verdict.reason}.`);
    }

    // One live call per agent. Only a call that is actually live blocks — an
    // orphaned WRAP_UP/FAILED record (browser closed, trunk error) used to
    // lock the agent out of dialing until someone edited the database.
    const existing = await this.callModel
      .findOne({
        tenantId: new Types.ObjectId(tenantId),
        agentId: new Types.ObjectId(agent.id),
        state: { $in: [...LIVE_CALL_STATES] },
      })
      .select('_id manual')
      .lean()
      .exec();
    if (existing) {
      throw new BadRequestException(
        existing.manual ? 'You are already on a manual call — hang it up first.' : 'You are on a call — finish it first.',
      );
    }

    // Claim + lock so neither the auto-dialer nor a second manual dial races us.
    lead.manualClaimedBy = new Types.ObjectId(agent.id);
    lead.manualClaimedAt = new Date();
    lead.lockedAt = new Date();
    lead.preferredAgentId = new Types.ObjectId(agent.id);
    // Dialing a pool lead takes ownership of it, so follow-ups stay with the
    // agent who has the relationship rather than scattering across the floor.
    if (!lead.ownerId) {
      lead.ownerId = new Types.ObjectId(agent.id);
      lead.assignedAt = new Date();
    }
    lead.attempts += 1;
    // `lastContactedAt` is stamped on disposition, once we know someone answered —
    // stamping it here made every unanswered manual dial trip the frequency cap.
    lead.timeline.push({ at: new Date(), kind: 'MANUAL_DIAL', detail: `Manual dial by ${agent.email}` });
    await lead.save();

    const cliNumber = await this.cli.selectCli({
      tenantId,
      poolIds: campaign.cliPool,
      leadState: lead.state,
      geoMatch: campaign.cliRules.geoMatch,
    });

    const now = new Date();
    const call = await this.callModel.create({
      tenantId: campaign.tenantId,
      campaignId: campaign._id,
      leadId: lead._id,
      cli: cliNumber?.number,
      state: 'DIALING',
      agentId: new Types.ObjectId(agent.id),
      manual: true,
      // `amdClass` is deliberately NOT set here. It used to be stamped 'HUMAN'
      // at creation, before the phone had even rung — so every manual dial
      // counted as a human answer in the CLI answer-rate aggregation, whether
      // or not anyone picked up. That made number-health blind to exactly the
      // burn it exists to detect. It stays unset until the call is answered
      // and something actually classifies the far end.
      startedAt: now,
    });
    const callId = call._id.toString();

    // Open the room and mint the agent's token BEFORE dialling the carrier —
    // `connect()` places the SIP leg only once the browser confirms it has
    // joined, so the customer never answers to an empty room.
    await this.livekit.ensureRoom(callId);
    const { url, token, roomName } = await this.livekit.mintToken(callId, agent.id, agent.email);

    await this.presence.markOnCall(agent.id);
    this.gateway.emitToTenant(tenantId, 'presence.updated', { userId: agent.id, state: 'ON_CALL' });
    this.logger.log(`Manual dial staged: ${agent.email} → ${lead.phone} via ${cliNumber?.number ?? 'trunk default'} (call ${callId})`);

    return {
      callId,
      leadName: [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.phone,
      phone: lead.phone,
      cli: cliNumber?.number ?? null,
      livekitUrl: url,
      livekitToken: token,
      roomName,
    };
  }

  /** Load a manual call this agent owns and hasn't already dispositioned. */
  private async loadOwnedCall(tenantId: string, agentId: string, callId: string): Promise<CallDocument> {
    if (!Types.ObjectId.isValid(callId)) throw new NotFoundException('Call not found');
    const call = await this.callModel
      .findOne({ _id: new Types.ObjectId(callId), tenantId: new Types.ObjectId(tenantId), manual: true })
      .exec();
    if (!call) throw new NotFoundException('Call not found');
    if (call.agentId?.toString() !== agentId) throw new ForbiddenException('This call belongs to another agent.');
    if (call.disposition) throw new BadRequestException('This call has already been dispositioned.');
    return call;
  }

  /**
   * Step 2 of 2: the agent's browser has joined the LiveKit room and published
   * its mic — now actually ring the customer over the carrier trunk,
   * presenting the CLI selected in `dial()`.
   *
   * `dial()` has already burned an attempt on the lead and pinned the agent to
   * ON_CALL. If the INVITE then fails — no trunk configured, carrier auth
   * rejected, bad destination — the agent used to be stranded: presence stuck
   * ON_CALL with no call to hang up, and the lead one attempt closer to
   * EXHAUSTED for a call that never left the building.
   *
   * The fix is a rollback here rather than a pre-flight check in `dial()`,
   * because a pre-flight check can only cover the *configuration* failure
   * (`LIVEKIT_SIP_TRUNK_ID` missing). Every other way this call can fail —
   * carrier 403, blocked destination, trunk out of credit — only shows up at
   * INVITE time, and those are the failures that actually happen on a live
   * floor. One recovery path covering all of them beats a check that covers
   * the easiest one.
   */
  async connect(tenantId: string, agentId: string, callId: string): Promise<{ ok: true }> {
    const call = await this.loadOwnedCall(tenantId, agentId, callId);
    // Exactly one INVITE per call: a double-click or a client retry after a
    // timeout must not dial the customer twice or, worse, fail and tear down
    // a call that is already ringing.
    const claimed = await this.callModel
      .updateOne({ _id: call._id, state: 'DIALING' }, { $set: { state: 'CONNECTING' } })
      .exec();
    if (claimed.modifiedCount === 0) {
      if (LIVE_CALL_STATES.includes(call.state)) return { ok: true };
      throw new BadRequestException(`This call is ${call.state}; it cannot be connected.`);
    }
    const lead = await this.leadModel.findById(call.leadId).lean().exec();
    if (!lead) throw new NotFoundException('Lead not found for this call.');

    // Recording starts BEFORE the INVITE. The room already exists and the
    // agent is already in it, so starting here is the only way to capture the
    // customer's first words — an egress started after "hello" misses the
    // disclosure, which is the one part of the call compliance cares about.
    // `startRecording` returns null (never throws) when recording is off.
    const recording = await this.livekit.startRecording(callId, tenantId);
    if (recording) {
      call.recordingEgressId = recording.egressId;
      call.recordingUri = recording.uri;
      await call.save();
    }

    try {
      await this.livekit.dialOut(callId, lead.phone, { from: call.cli });
    } catch (err) {
      await this.rollbackFailedConnect(tenantId, agentId, call, err as Error);
      throw new BadRequestException(`Could not place the call: ${(err as Error).message}`);
    }

    // The customer's leg may already have joined and been finalised by the
    // webhook in the meantime; only advance a call that is still ours to advance.
    await this.callModel.updateOne({ _id: call._id, state: 'CONNECTING' }, { $set: { state: 'RINGING' } }).exec();
    return { ok: true };
  }

  /**
   * Undo everything `dial()` optimistically did, so a trunk failure costs the
   * agent a click rather than a lead and a stuck seat.
   *
   * `lastContactedAt` is intentionally NOT restored — we cannot know its
   * previous value, and leaving it slightly fresh only delays a retry, whereas
   * leaving `attempts` inflated permanently shortens the lead's life.
   */
  private async rollbackFailedConnect(
    tenantId: string,
    agentId: string,
    call: CallDocument,
    err: Error,
  ): Promise<void> {
    const callId = call._id.toString();
    this.logger.error(`Manual connect failed for call ${callId}: ${err.message}`);

    if (call.recordingEgressId) {
      await this.livekit.stopRecording(call.recordingEgressId);
      call.recordingEgressId = undefined;
      call.recordingUri = undefined;
    }
    // Tear down the room the agent's browser joined in `dial()`, otherwise it
    // sits there publishing into nothing until the empty timeout.
    await this.livekit.hangup(callId);

    call.state = 'FAILED';
    call.outcome = 'FAILED';
    // TRUNK_ERROR rather than a SIP-derived reason: we never got far enough to
    // see a SIP response, so the failure is ours (or the carrier's), not the
    // callee's — and it must not feed the retry matrix as a NO_ANSWER.
    call.endReason = 'TRUNK_ERROR';
    call.endedAt = new Date();
    await call.save();

    await this.leadModel
      .updateOne(
        { _id: call.leadId },
        {
          $inc: { attempts: -1 },
          $unset: { lockedAt: '' },
          $push: {
            timeline: { at: new Date(), kind: 'MANUAL_DIAL', detail: `Dial failed before ringing: ${err.message}` },
          },
        },
      )
      .exec();

    await this.presence.release(agentId, 'AVAILABLE');
    this.gateway.emitToTenant(tenantId, 'presence.updated', { userId: agentId, state: 'AVAILABLE' });
    this.gateway.emitToTenant(tenantId, 'call.state.changed', {
      callId,
      state: 'FAILED',
      endReason: 'TRUNK_ERROR',
    });
    this.gateway.emitToUser(agentId, 'call.ended', { callId, reason: err.message, outcome: 'FAILED' });
  }

  /**
   * Agent-initiated hangup: drops the SIP leg and tears down the room. The
   * call record stays open for disposition — hanging up is a call-control
   * action, not the end of the workflow (see manual-dial.controller.ts).
   *
   * Hanging up now also *starts the clock*: the agent is released from ON_CALL
   * into WRAP_UP with a deadline the sweep enforces. Before this, hanging up
   * left the agent pinned ON_CALL until they dispositioned — so an agent who
   * forgot took themselves off the floor indefinitely, and no dial or transfer
   * could reach them.
   */
  async hangup(tenantId: string, agentId: string, callId: string): Promise<{ ok: true }> {
    const call = await this.loadOwnedCall(tenantId, agentId, callId);
    // Persist the terminal state BEFORE dropping the leg: the carrier's
    // `participant_left` webhook races us, and if it wins it would record an
    // AI_HANGUP end reason on a call the agent ended.
    if (call.state !== 'COMPLETED' && call.state !== 'FAILED' && call.state !== 'WRAP_UP') {
      // Hanging up while parked would otherwise lose the open hold interval.
      if (call.heldSince) {
        call.heldMs += Math.max(0, Date.now() - call.heldSince.getTime());
        call.heldSince = undefined;
      }
      const deadline = new Date(Date.now() + config.floor.wrapUpMaxSeconds * 1000);
      call.state = 'WRAP_UP';
      call.wrapUpDeadline = deadline;
      if (!call.endReason) call.endReason = 'AGENT_HANGUP';
      if (!call.endedAt) call.endedAt = new Date();
      await call.save();

      await this.presence.release(agentId, 'WRAP_UP');
      this.gateway.emitToTenant(tenantId, 'presence.updated', { userId: agentId, state: 'WRAP_UP' });
      this.gateway.emitToTenant(tenantId, 'call.state.changed', { callId, state: 'WRAP_UP' });
      this.gateway.emitToUser(agentId, 'wrapup.started', { callId, deadline: deadline.getTime() });
    }
    if (call.recordingEgressId) await this.livekit.stopRecording(call.recordingEgressId);
    await this.livekit.hangup(callId);
    return { ok: true };
  }
}
