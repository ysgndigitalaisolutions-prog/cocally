import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { DISPOSITIONS, LIVE_CALL_STATES, redactPii, type Disposition } from '@cocally/shared';
import { IsIn, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
import { Model, Types } from 'mongoose';
import { config } from '../../common/config';
import { presignS3Get } from '../../common/s3-presign';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Public } from '../../common/auth/public.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { Call, CallDocument } from '../../schemas/call.schema';
import { Campaign, CampaignDocument } from '../../schemas/campaign.schema';
import { Lead, LeadDocument } from '../../schemas/lead.schema';
import { User, UserDocument } from '../../schemas/user.schema';
import { LeadsService } from '../leads/leads.service';
import { SchedulingService } from '../leads/scheduling.service';
import { SuppressionService } from '../leads/suppression.service';
import { RecordingsService } from '../recordings/recordings.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { PresenceService } from '../workspace/presence.service';
import { RealtimeGateway } from '../workspace/realtime.gateway';
import { CallOrchestratorService } from './call-orchestrator.service';
import { CallProgressService } from './call-progress.service';
import { LivekitService } from './livekit.service';

class DispositionDto {
  @IsIn(DISPOSITIONS)
  disposition: Disposition;

  @IsOptional()
  @IsString()
  notes?: string;

  /** ISO datetime for BOOKED/CALLBACK dispositions. */
  @IsOptional()
  @IsString()
  scheduledFor?: string;

  /** BOOKED only: appointment length. */
  @IsOptional()
  @IsNumber()
  durationMinutes?: number;

  /** BOOKED only: slot-inventory key, enforcing single-occupancy. */
  @IsOptional()
  @IsString()
  slotKey?: string;
}

class DevDialDto {
  @IsString()
  @IsNotEmpty()
  campaignId: string;

  @IsString()
  @IsNotEmpty()
  leadId: string;

  @IsOptional()
  @IsString()
  personaPrompt?: string;

  @IsOptional()
  scriptedReplies?: string[];
}

class LiveDemoDialDto {
  @IsString()
  @IsNotEmpty()
  campaignId: string;

  @IsString()
  @IsNotEmpty()
  leadId: string;

  /** 'phone' places a real PSTN call via the Twilio<->LiveKit SIP trunk instead of returning a browser join link. */
  @IsOptional()
  @IsIn(['browser', 'phone'])
  dialMode?: 'browser' | 'phone';

  /** E.164 number to dial when dialMode is 'phone'. On a Twilio Trial account this must be a Verified Caller ID. */
  @IsOptional()
  @IsString()
  phoneNumber?: string;

  /** Overrides the seeded lead's first name for this call (e.g. whoever is actually answering the demo call). */
  @IsOptional()
  @IsString()
  leadFirstName?: string;
}

@Controller('calls')
export class CallsController {
  constructor(
    @InjectModel(Call.name) private readonly callModel: Model<CallDocument>,
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
    @InjectModel(Campaign.name) private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly leads: LeadsService,
    private readonly scheduling: SchedulingService,
    private readonly suppression: SuppressionService,
    private readonly recordings: RecordingsService,
    private readonly webhooks: WebhooksService,
    private readonly presence: PresenceService,
    private readonly orchestrator: CallOrchestratorService,
    private readonly progress: CallProgressService,
    private readonly livekit: LivekitService,
    private readonly gateway: RealtimeGateway,
  ) {}

  @Get()
  @Roles('ADMIN', 'SUPERVISOR', 'QA')
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('campaignId') campaignId?: string,
    @Query('leadId') leadId?: string,
    @Query('agentId') agentId?: string,
    @Query('outcome') outcome?: string,
    @Query('disposition') disposition?: string,
    @Query('amdClass') amdClass?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    const filter: Record<string, unknown> = { tenantId: new Types.ObjectId(user.tenantId) };
    if (campaignId && Types.ObjectId.isValid(campaignId)) filter.campaignId = new Types.ObjectId(campaignId);
    // Per-lead call history for the lead drawer — covered by the {leadId, startedAt} index.
    if (leadId && Types.ObjectId.isValid(leadId)) filter.leadId = new Types.ObjectId(leadId);
    // "unassigned" = AI-only calls that never reached a human.
    if (agentId === 'unassigned') filter.agentId = { $in: [null, undefined] };
    else if (agentId && Types.ObjectId.isValid(agentId)) filter.agentId = new Types.ObjectId(agentId);
    if (outcome) filter.outcome = outcome;
    if (disposition) filter.disposition = disposition;
    if (amdClass) filter.amdClass = amdClass;

    const startedAt: Record<string, Date> = {};
    if (from && !Number.isNaN(Date.parse(from))) startedAt.$gte = new Date(from);
    // A bare date means "to the end of that day", not midnight at its start.
    if (to && !Number.isNaN(Date.parse(to))) {
      const end = new Date(to);
      if (/^\d{4}-\d{2}-\d{2}$/.test(to)) end.setHours(23, 59, 59, 999);
      startedAt.$lte = end;
    }
    if (Object.keys(startedAt).length > 0) filter.startedAt = startedAt;

    const calls = await this.callModel
      .find(filter)
      .sort({ startedAt: -1 })
      .limit(Math.min(Number(limit ?? 50), 200))
      .select('-transcript')
      .lean()
      .exec();

    // Resolve the human agent who took each transfer, for display and filtering.
    const agentIds = [...new Set(calls.map((c) => c.agentId?.toString()).filter((id): id is string => Boolean(id)))];
    const agents = agentIds.length
      ? await this.userModel
          .find({ _id: { $in: agentIds.map((id) => new Types.ObjectId(id)) } })
          .select('name email')
          .lean()
          .exec()
      : [];
    const agentById = new Map(agents.map((a) => [a._id.toString(), a.name || a.email]));

    return calls.map((call) => ({
      ...call,
      agentName: call.agentId ? (agentById.get(call.agentId.toString()) ?? null) : null,
    }));
  }

  /** Call deep-dive per DASH-07: replay with score-over-time, signals, compliance events. */
  @Get(':id')
  @Roles('ADMIN', 'SUPERVISOR', 'QA', 'AGENT')
  async deepDive(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    const call = await this.callModel
      .findOne({ _id: new Types.ObjectId(id), tenantId: new Types.ObjectId(user.tenantId) })
      .lean()
      .exec();
    if (!call) throw new NotFoundException('Call not found');
    // Transcript is served redacted by default per REC-04.
    return {
      ...call,
      transcript: call.transcript.map((t) => ({ ...t, text: t.redactedText || redactPii(t.text) })),
    };
  }

  /**
   * Playback link for the call's audio. The egress writes to S3 (or an
   * S3-compatible bucket); a short-lived presigned URL is minted per request
   * so QA can listen without the bucket being public. 404 when the call has
   * no recording (recording off, simulation, or the egress never started).
   */
  @Get(':id/recording')
  @Roles('ADMIN', 'SUPERVISOR', 'QA', 'OWNER')
  async recording(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Call not found');
    const call = await this.callModel
      .findOne({ _id: new Types.ObjectId(id), tenantId: new Types.ObjectId(user.tenantId) })
      .select('recordingUri recordingEgressId endedAt')
      .lean()
      .exec();
    if (!call) throw new NotFoundException('Call not found');
    if (!call.recordingUri) throw new NotFoundException('No recording for this call');
    const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(call.recordingUri);
    const { bucket, s3Region, s3AccessKey, s3Secret, s3Endpoint } = config.recording;
    if (!m || !bucket || !s3AccessKey || !s3Secret) {
      throw new NotFoundException('Recording is stored outside the configured bucket');
    }
    const url = presignS3Get({
      bucket: m[1]!,
      key: m[2]!,
      region: s3Region ?? 'ap-southeast-2',
      accessKey: s3AccessKey,
      secret: s3Secret,
      endpoint: s3Endpoint,
      expiresSeconds: 15 * 60,
    });
    return { url, expiresInSeconds: 15 * 60, contentType: 'audio/ogg', ready: Boolean(call.endedAt) };
  }

  /**
   * Agent briefing for a bridged call per XFER-05: the AI-built summary plus the
   * campaign playbook (rebuttals), call-scoped so a just-bridged agent has both
   * the context and the script without a socket race or broad campaign access.
   */
  @Get(':id/briefing')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN', 'QA')
  async briefing(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    const call = await this.callModel
      .findOne({ _id: new Types.ObjectId(id), tenantId: new Types.ObjectId(user.tenantId) })
      .lean()
      .exec();
    if (!call) throw new NotFoundException('Call not found');
    const [lead, campaign] = await Promise.all([
      this.leadModel.findById(call.leadId).lean().exec(),
      this.campaignModel.findById(call.campaignId).lean().exec(),
    ]);
    const factLabels: Record<string, string> = {
      owner: 'Owns home',
      noPanels: 'No existing panels',
      billHigh: 'High power bill',
      dwellingHouse: 'House (not unit)',
      roofSuitable: 'Roof suitable',
      appointmentInterest: 'Wants appointment',
    };
    const facts = Object.entries(lead?.facts ?? {}).map(([key, value]) => ({
      label: factLabels[key] ?? key,
      value: String(value),
      confirmed: Boolean(value),
    }));
    const objection = call.objections?.find((o) => !o.recovered)?.label ?? null;
    return {
      callId: call._id.toString(),
      leadName: [lead?.firstName, lead?.lastName].filter(Boolean).join(' ') || 'Unknown',
      location: [lead?.suburb, lead?.state].filter(Boolean).join(', ') || '',
      score: call.finalScore,
      summary: call.summary || '',
      facts,
      objection,
      campaignName: campaign?.name ?? '',
      rebuttals: campaign?.rebuttals ?? [],
    };
  }

  /**
   * Agent disposition closes the loop into retry/suppression per XFER-06.
   *
   * Order matters: every input is validated and every side effect that can
   * legitimately be refused (invalid or past appointment time, a slot already
   * taken) runs BEFORE the call is marked dispositioned. Previously the call
   * was saved first, so a rejected booking left a call that could never be
   * dispositioned again, a lead stuck in TRANSFERRED, no appointment, and the
   * agent pinned ON_CALL with no wrap-up window — all from one typo in a date.
   */
  @Post(':id/disposition')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN')
  async setDisposition(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: DispositionDto) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Call not found');
    const call = await this.callModel
      .findOne({ _id: new Types.ObjectId(id), tenantId: new Types.ObjectId(user.tenantId) })
      .exec();
    if (!call) throw new NotFoundException('Call not found');
    if (call.disposition) throw new BadRequestException('Call already dispositioned');
    // A supervisor/admin may close out any call; an agent only their own.
    if (user.roles.includes('AGENT') && !user.roles.some((r) => r === 'SUPERVISOR' || r === 'ADMIN' || r === 'OWNER')) {
      if (call.agentId && call.agentId.toString() !== user.userId) {
        throw new ForbiddenException('This call belongs to another agent.');
      }
    }

    // ── Validate everything up front ──────────────────────────────────────
    let scheduledAt: Date | undefined;
    if (dto.scheduledFor !== undefined && dto.scheduledFor !== null && dto.scheduledFor !== '') {
      scheduledAt = new Date(dto.scheduledFor);
      if (Number.isNaN(scheduledAt.getTime())) throw new BadRequestException('Invalid date/time for scheduledFor');
    }
    if (dto.disposition === 'BOOKED' && scheduledAt && scheduledAt.getTime() < Date.now() - 60_000) {
      throw new BadRequestException('Appointment time is in the past');
    }
    if (dto.disposition === 'CALLBACK' && scheduledAt && scheduledAt.getTime() < Date.now() - 60_000) {
      throw new BadRequestException('Callback time is in the past');
    }
    if (dto.durationMinutes !== undefined && (dto.durationMinutes < 5 || dto.durationMinutes > 8 * 60)) {
      throw new BadRequestException('durationMinutes must be between 5 and 480');
    }

    const lead = await this.leadModel.findById(call.leadId).exec();

    // ── Refusable side effects first (booking / callback) ─────────────────
    if (lead && dto.disposition === 'BOOKED' && scheduledAt) {
      await this.scheduling.bookAppointment({
        tenantId: user.tenantId,
        clientId: lead.clientId.toString(),
        leadId: lead._id.toString(),
        callId: call._id.toString(),
        startsAt: scheduledAt,
        durationMinutes: dto.durationMinutes,
        slotKey: dto.slotKey,
        notes: dto.notes,
      });
    }
    let callbackDueAt: Date | undefined;
    if (lead && dto.disposition === 'CALLBACK') {
      callbackDueAt = scheduledAt ?? new Date(Date.now() + 24 * 3600 * 1000);
      // Creates a real Callback task (agent worklist + overdue reporting) and
      // sets lead state/nextAttemptAt in one place.
      await this.scheduling.scheduleCallback({
        tenantId: user.tenantId,
        leadId: lead._id.toString(),
        campaignId: call.campaignId.toString(),
        dueAt: callbackDueAt,
        handler: 'HUMAN',
        preferredAgentId: call.agentId?.toString() ?? user.userId,
        notes: dto.notes,
      });
    }

    // ── Commit the call ───────────────────────────────────────────────────
    // The disposition is how an AI-transferred call ends: drop the customer
    // leg, stop the recording and free the pacing slot, otherwise the SIP leg
    // and the egress run on in an empty room until LiveKit's timeout.
    const wasLive = LIVE_CALL_STATES.includes(call.state);
    call.disposition = dto.disposition;
    call.dispositionNotes = dto.notes;
    call.state = 'COMPLETED';
    if (!call.endedAt) call.endedAt = new Date();
    if (!call.outcome) call.outcome = call.answeredAt || call.bridgedAt ? 'ANSWERED_HUMAN' : 'NO_ANSWER';
    if (wasLive && !call.endReason) call.endReason = 'AGENT_HANGUP';
    await call.save();
    await this.progress.releaseResources(call);

    if (lead) {
      // Human leg recorded under the same lead timeline per REC-01/XFER-06.
      await this.recordings.captureLeg({
        tenantId: user.tenantId,
        callId: call._id.toString(),
        leadId: lead._id.toString(),
        leg: 'HUMAN',
        startedAt: call.bridgedAt ?? new Date(),
        transcript: call.transcript.filter((t) => t.leg === 'HUMAN').map((t) => ({ speaker: t.speaker, text: t.text, startMs: t.startMs })),
      });

      switch (dto.disposition) {
        case 'BOOKED': {
          this.leads.transition(lead, 'BOOKED', `Booked by ${user.email}`);
          await this.webhooks.dispatch(user.tenantId, 'appointment.booked', {
            leadId: lead._id.toString(),
            callId: call._id.toString(),
            scheduledFor: scheduledAt?.toISOString(),
          });
          break;
        }
        case 'CALLBACK': {
          // scheduleCallback already persisted state/nextAttemptAt; refresh the
          // in-memory doc so the save below doesn't write them back stale.
          lead.state_ = 'CALLBACK';
          lead.nextAttemptAt = callbackDueAt;
          break;
        }
        case 'DO_NOT_CALL':
          this.leads.transition(lead, 'DNC', `Marked DNC by ${user.email}`);
          // A DNC disposition must also suppress the number, not only flip the
          // lead state — otherwise a re-import of the same list dials them again.
          await this.suppression.optOut(user.tenantId, lead.phone, `Agent disposition DO_NOT_CALL (by ${user.email})`);
          break;
        case 'NOT_INTERESTED':
        case 'NOT_QUALIFIED':
          this.leads.transition(lead, 'NURTURE', `${dto.disposition} by ${user.email}`);
          break;
        case 'WRONG_NUMBER':
          this.leads.transition(lead, 'EXHAUSTED', 'Wrong number');
          break;
        case 'FOLLOW_UP':
        default:
          // Keep the lead with the agent but do not let the AI dialer grab it
          // five seconds after they hang up: hold it for the follow-up time or a day.
          lead.nextAttemptAt = scheduledAt ?? new Date(Date.now() + 24 * 3600 * 1000);
          break;
      }
      if (call.answeredAt || call.bridgedAt) lead.lastContactedAt = new Date();
      // Any outstanding promise is now settled — a re-promise was already
      // recreated above for CALLBACK, so clearing here can't orphan the new one.
      if (dto.disposition !== 'CALLBACK') {
        await this.scheduling.resolveOpenCallbacks(user.tenantId, lead._id.toString());
      }

      // Manual claim is released once the call is closed, so the lead can flow
      // back to the auto-dialer (or be re-claimed) per its new state.
      lead.manualClaimedBy = undefined;
      lead.manualClaimedAt = undefined;
      lead.lockedAt = undefined;
      // Terminal outcomes hand the record back to the pool so it stops occupying
      // a seat's worklist; workable outcomes stay with the agent who owns it.
      if (['BOOKED', 'DNC', 'EXHAUSTED', 'NURTURE'].includes(lead.state_)) {
        lead.ownerId = undefined;
        lead.assignedAt = undefined;
      }
      lead.timeline.push({ at: new Date(), kind: 'DISPOSITION', detail: dto.disposition, callId: call._id.toString() });
      await lead.save();
    }

    // Wrap-up presence per WS-01 + talk-time accounting for routing. The agent
    // dispositioned, so their wrap-up is over: hand them straight back to the
    // floor (or leave them where they put themselves — release() only moves
    // RESERVED/ON_CALL/WRAP_UP).
    // Only touch the agent's presence if this is still the call they are on —
    // a late disposition must not knock them off a newer call.
    const agentOnAnotherCall = call.agentId
      ? await this.callModel.exists({ agentId: call.agentId, _id: { $ne: call._id }, state: { $in: [...LIVE_CALL_STATES] } })
      : null;
    if (call.agentId && !agentOnAnotherCall) {
      const talkSeconds = call.bridgedAt
        ? Math.max(0, Math.round(((call.endedAt ?? new Date()).getTime() - call.bridgedAt.getTime()) / 1000))
        : 0;
      if (talkSeconds > 0) await this.presence.addTalkTime(call.agentId.toString(), talkSeconds);
      await this.callModel.updateOne({ _id: call._id }, { $unset: { wrapUpDeadline: '' } }).exec();
      await this.presence.release(call.agentId.toString(), 'AVAILABLE');
      const now = await this.presence.getPresence(call.agentId.toString());
      this.gateway.emitToTenant(user.tenantId, 'presence.updated', { userId: call.agentId.toString(), state: now ?? 'OFFLINE' });
      this.gateway.emitToUser(call.agentId.toString(), 'wrapup.finished', { callId: call._id.toString() });
    }

    await this.webhooks.dispatch(user.tenantId, 'call.completed', {
      callId: call._id.toString(),
      leadId: call.leadId.toString(),
      campaignId: call.campaignId.toString(),
      outcome: call.outcome,
      disposition: dto.disposition,
      score: call.finalScore,
    });

    // Idempotent no-op if the simulation runtime already removed this call's
    // floor card in its own `finally`; a live-voice-demo call has no such
    // runtime, so this is the only place its card is cleared.
    this.gateway.removeFloorCall(user.tenantId, call._id.toString());
    this.gateway.emitToTenant(user.tenantId, 'call.state.changed', { callId: call._id.toString(), state: 'COMPLETED' });

    return { ok: true };
  }

  /**
   * Dev/simulation dial: place one simulated call immediately (bypasses the
   * scheduler). Drives demos, tests, and the pilot rehearsal loop.
   */
  @Post('dev-dial')
  @Roles('ADMIN', 'SUPERVISOR')
  async devDial(@CurrentUser() user: AuthenticatedUser, @Body() dto: DevDialDto) {
    const campaign = await this.campaignModel
      .findOne({ _id: new Types.ObjectId(dto.campaignId), tenantId: new Types.ObjectId(user.tenantId) })
      .exec();
    if (!campaign) throw new NotFoundException('Campaign not found');
    const lead = await this.leadModel
      .findOne({ _id: new Types.ObjectId(dto.leadId), tenantId: new Types.ObjectId(user.tenantId) })
      .exec();
    if (!lead) throw new NotFoundException('Lead not found');

    void this.orchestrator.placeCall(campaign, lead, undefined, {
      personaPrompt: dto.personaPrompt,
      scriptedReplies: dto.scriptedReplies,
    });
    return { ok: true, message: 'Simulated call started' };
  }

  /**
   * Real-voice demo dial with no SIP/telephony: creates a Call + a LiveKit
   * room the registered AI worker auto-joins (per-room dispatch, no explicit
   * `AgentDispatchClient` call needed), fetches its brief from
   * `GET /engine/calls/:id/brief`, and speaks it. A person plays the "lead"
   * by opening the returned join link in a browser (mic, no login) — see
   * claude-dev/2026-07-22-live-voice-build-progress.md for why this stands
   * in for a real PSTN dial-out.
   */
  @Post('live-demo')
  @Roles('ADMIN', 'OWNER')
  async liveDemoDial(@CurrentUser() user: AuthenticatedUser, @Body() dto: LiveDemoDialDto) {
    const campaign = await this.campaignModel
      .findOne({ _id: new Types.ObjectId(dto.campaignId), tenantId: new Types.ObjectId(user.tenantId) })
      .exec();
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (!campaign.activeFlowVersionId) throw new BadRequestException('Campaign has no active flow version');
    const lead = await this.leadModel
      .findOne({ _id: new Types.ObjectId(dto.leadId), tenantId: new Types.ObjectId(user.tenantId) })
      .exec();
    if (!lead) throw new NotFoundException('Lead not found');
    if (dto.leadFirstName?.trim()) {
      lead.firstName = dto.leadFirstName.trim();
      await lead.save();
    }

    const call = await this.callModel.create({
      tenantId: new Types.ObjectId(user.tenantId),
      campaignId: campaign._id,
      leadId: lead._id,
      flowVersionId: campaign.activeFlowVersionId,
      state: 'IN_CONVERSATION',
      startedAt: new Date(),
      answeredAt: new Date(),
    });
    const callId = call._id.toString();
    await this.livekit.ensureRoom(callId);

    this.gateway.updateFloorCall(user.tenantId, {
      callId,
      leadId: lead._id.toString(),
      campaignId: campaign._id.toString(),
      leadName: [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.phone,
      state: call.state,
      currentStage: 'live-voice-demo',
      score: 0,
      startedAt: call.startedAt.getTime(),
      claimable: false,
    });

    if (dto.dialMode === 'phone') {
      if (!dto.phoneNumber) throw new BadRequestException('phoneNumber is required for dialMode "phone"');
      await this.livekit.dialOut(callId, dto.phoneNumber);
      return { callId, leadJoinPath: null, dialed: dto.phoneNumber };
    }

    return { callId, leadJoinPath: `/demo/lead/${callId}` };
  }

  /**
   * Public join token for the browser-simulated "lead" side of the live-voice
   * demo (no login). Disabled unless DEMO_LEAD_TOKEN_ENABLED is set (refused in
   * production by config), and only for a call that is still live and less
   * than 30 minutes old, so a leaked or guessed id cannot join a real customer
   * conversation.
   */
  @Public()
  @Get(':id/lead-token')
  async leadToken(@Param('id') id: string) {
    if (!config.demoLeadTokenEnabled) throw new NotFoundException('Not found');
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Call not found');
    const call = await this.callModel.findById(new Types.ObjectId(id)).lean().exec();
    if (!call) throw new NotFoundException('Call not found');
    const ageMs = Date.now() - new Date(call.startedAt).getTime();
    if (call.endedAt || ageMs > 30 * 60_000) throw new NotFoundException('Call not found');
    await this.livekit.ensureRoom(id);
    return this.livekit.mintToken(id, `lead-${id}`, 'Lead');
  }

  /** Join token for the human agent's browser to bridge real audio into a live-voice-demo call. */
  @Get(':id/agent-token')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN')
  async agentToken(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    const call = await this.callModel
      .findOne({ _id: new Types.ObjectId(id), tenantId: new Types.ObjectId(user.tenantId) })
      .lean()
      .exec();
    if (!call) throw new NotFoundException('Call not found');
    await this.livekit.ensureRoom(id);
    return this.livekit.mintToken(id, user.userId, user.email);
  }
}
