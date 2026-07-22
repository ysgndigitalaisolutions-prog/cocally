import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { DISPOSITIONS, redactPii, type Disposition } from '@cocally/shared';
import { IsIn, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
import { Model, Types } from 'mongoose';
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
import { RecordingsService } from '../recordings/recordings.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { PresenceService } from '../workspace/presence.service';
import { RealtimeGateway } from '../workspace/realtime.gateway';
import { CallOrchestratorService } from './call-orchestrator.service';
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
    private readonly recordings: RecordingsService,
    private readonly webhooks: WebhooksService,
    private readonly presence: PresenceService,
    private readonly orchestrator: CallOrchestratorService,
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

  /** Agent disposition closes the loop into retry/suppression per XFER-06. */
  @Post(':id/disposition')
  @Roles('AGENT', 'SUPERVISOR', 'ADMIN')
  async setDisposition(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: DispositionDto) {
    const call = await this.callModel
      .findOne({ _id: new Types.ObjectId(id), tenantId: new Types.ObjectId(user.tenantId) })
      .exec();
    if (!call) throw new NotFoundException('Call not found');
    if (call.disposition) throw new BadRequestException('Call already dispositioned');

    call.disposition = dto.disposition;
    call.dispositionNotes = dto.notes;
    call.state = 'COMPLETED';
    call.endedAt = new Date();
    await call.save();

    const lead = await this.leadModel.findById(call.leadId).exec();
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
          // Create the actual appointment record — previously a BOOKED call only
          // flipped lead state and fired a webhook, so the booking existed
          // nowhere in the system that a client could be shown or billed for.
          if (dto.scheduledFor) {
            await this.scheduling.bookAppointment({
              tenantId: user.tenantId,
              clientId: lead.clientId.toString(),
              leadId: lead._id.toString(),
              callId: call._id.toString(),
              startsAt: new Date(dto.scheduledFor),
              durationMinutes: dto.durationMinutes,
              slotKey: dto.slotKey,
              notes: dto.notes,
            });
          }
          await this.webhooks.dispatch(user.tenantId, 'appointment.booked', {
            leadId: lead._id.toString(),
            callId: call._id.toString(),
            scheduledFor: dto.scheduledFor,
          });
          break;
        }
        case 'CALLBACK': {
          const dueAt = dto.scheduledFor ? new Date(dto.scheduledFor) : new Date(Date.now() + 24 * 3600 * 1000);
          // Creates a real Callback task (agent worklist + overdue reporting) and
          // sets lead state/nextAttemptAt in one place.
          await this.scheduling.scheduleCallback({
            tenantId: user.tenantId,
            leadId: lead._id.toString(),
            campaignId: call.campaignId.toString(),
            dueAt,
            handler: 'HUMAN',
            preferredAgentId: call.agentId?.toString() ?? user.userId,
            notes: dto.notes,
          });
          // scheduleCallback already persisted state/nextAttemptAt; refresh the
          // in-memory doc so the save below doesn't write them back stale.
          lead.state_ = 'CALLBACK';
          lead.nextAttemptAt = dueAt;
          break;
        }
        case 'DO_NOT_CALL':
          this.leads.transition(lead, 'DNC', `Marked DNC by ${user.email}`);
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
          break;
      }
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

    // Wrap-up presence per WS-01 + talk-time accounting for routing.
    if (call.agentId) {
      const talkSeconds = call.bridgedAt ? Math.round((Date.now() - call.bridgedAt.getTime()) / 1000) : 0;
      await this.presence.addTalkTime(call.agentId.toString(), talkSeconds);
      await this.presence.release(call.agentId.toString(), 'WRAP_UP');
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

  /** Public join token for the browser-simulated "lead" side (no login). */
  @Public()
  @Get(':id/lead-token')
  async leadToken(@Param('id') id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Call not found');
    const call = await this.callModel.findById(new Types.ObjectId(id)).lean().exec();
    if (!call) throw new NotFoundException('Call not found');
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
