import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
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

const DIALABLE_STATES = ['FRESH', 'ATTEMPTED', 'CONTACTED', 'CALLBACK'];

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
 * NOTE: with TELEPHONY_DRIVER=SIMULATION there is no real audio leg. The manual
 * call is created and attributed to the agent, who then dispositions it exactly
 * as they would a bridged AI transfer. When the SIP CallRuntime lands, the
 * agent's live audio leg bridges into this same call with no workflow change.
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
   * Place a manual call. Enforces the legal gates, claims the lead (so the AI
   * dialer can't grab it mid-call), attributes the call to the agent, and puts
   * the agent ON_CALL. The agent closes it via the normal disposition endpoint.
   */
  async dial(
    tenantId: string,
    agent: { id: string; email: string },
    leadId: string,
  ): Promise<{ callId: string; leadName: string; phone: string }> {
    const lead = await this.loadClaimable(tenantId, agent.id, leadId);
    if (lead.manualClaimedBy && lead.manualClaimedBy.toString() !== agent.id) {
      throw new BadRequestException('Lead is claimed by another agent.');
    }
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
    });
    if (!verdict.allowed) {
      throw new BadRequestException(`Blocked by compliance: ${verdict.reason}.`);
    }

    // One live manual call per agent.
    const existing = await this.callModel
      .findOne({ tenantId: new Types.ObjectId(tenantId), agentId: new Types.ObjectId(agent.id), manual: true, disposition: null })
      .lean()
      .exec();
    if (existing) throw new BadRequestException('Finish (disposition) your current manual call first.');

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
    lead.lastContactedAt = new Date();
    lead.timeline.push({ at: new Date(), kind: 'MANUAL_DIAL', detail: `Manual dial by ${agent.email}` });
    await lead.save();

    const now = new Date();
    const call = await this.callModel.create({
      tenantId: campaign.tenantId,
      campaignId: campaign._id,
      leadId: lead._id,
      cli: undefined,
      state: 'IN_CONVERSATION',
      agentId: new Types.ObjectId(agent.id),
      manual: true,
      amdClass: 'HUMAN',
      startedAt: now,
      answeredAt: now,
      // Talk time is counted from bridge; a manual call is "bridged" at dial.
      bridgedAt: now,
    });

    await this.presence.markOnCall(agent.id);
    this.gateway.emitToTenant(tenantId, 'presence.updated', { userId: agent.id, state: 'ON_CALL' });
    this.logger.log(`Manual dial: ${agent.email} → ${lead.phone} (call ${call._id.toString()})`);

    return {
      callId: call._id.toString(),
      leadName: [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.phone,
      phone: lead.phone,
    };
  }
}
