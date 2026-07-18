import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { DISPOSITIONS, redactPii, type Disposition } from '@cocally/shared';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { Model, Types } from 'mongoose';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { Call, CallDocument } from '../../schemas/call.schema';
import { Campaign, CampaignDocument } from '../../schemas/campaign.schema';
import { Lead, LeadDocument } from '../../schemas/lead.schema';
import { LeadsService } from '../leads/leads.service';
import { RecordingsService } from '../recordings/recordings.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { PresenceService } from '../workspace/presence.service';
import { CallOrchestratorService } from './call-orchestrator.service';

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

@Controller('calls')
export class CallsController {
  constructor(
    @InjectModel(Call.name) private readonly callModel: Model<CallDocument>,
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
    @InjectModel(Campaign.name) private readonly campaignModel: Model<CampaignDocument>,
    private readonly leads: LeadsService,
    private readonly recordings: RecordingsService,
    private readonly webhooks: WebhooksService,
    private readonly presence: PresenceService,
    private readonly orchestrator: CallOrchestratorService,
  ) {}

  @Get()
  @Roles('ADMIN', 'SUPERVISOR', 'QA')
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('campaignId') campaignId?: string,
    @Query('limit') limit?: string,
  ) {
    const filter: Record<string, unknown> = { tenantId: new Types.ObjectId(user.tenantId) };
    if (campaignId) filter.campaignId = new Types.ObjectId(campaignId);
    const calls = await this.callModel
      .find(filter)
      .sort({ startedAt: -1 })
      .limit(Math.min(Number(limit ?? 50), 200))
      .select('-transcript')
      .lean()
      .exec();
    return calls;
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
        case 'BOOKED':
          this.leads.transition(lead, 'BOOKED', `Booked by ${user.email}`);
          await this.webhooks.dispatch(user.tenantId, 'appointment.booked', {
            leadId: lead._id.toString(),
            callId: call._id.toString(),
            scheduledFor: dto.scheduledFor,
          });
          break;
        case 'CALLBACK':
          this.leads.transition(lead, 'CALLBACK', `Callback requested via ${user.email}`);
          lead.nextAttemptAt = dto.scheduledFor ? new Date(dto.scheduledFor) : new Date(Date.now() + 24 * 3600 * 1000);
          break;
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
}
