import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Interval } from '@nestjs/schedule';
import { FilterQuery, Model, Types } from 'mongoose';
import { Call, CallDocument } from '../../schemas/call.schema';
import { Campaign, CampaignDocument } from '../../schemas/campaign.schema';
import { Lead, LeadDocument } from '../../schemas/lead.schema';
import { Tenant, TenantDocument } from '../../schemas/tenant.schema';
import { CountryPacksService } from '../country-packs/country-packs.service';
import { isWithinCallingWindow, nextWindowOpen } from '../country-packs/calling-windows';
import { SuppressionService } from '../leads/suppression.service';
import { PresenceService } from '../workspace/presence.service';
import { CallOrchestratorService } from './call-orchestrator.service';
import { CliService } from './cli.service';

/** Why a campaign that looks "on" is not placing calls right now. */
export type DialBlockReason =
  | 'CAMPAIGN_NOT_ACTIVE'
  | 'TENANT_PAUSED'
  | 'NO_FLOW_VERSION'
  | 'DAILY_BUDGET_REACHED'
  | 'TENANT_QUOTA_REACHED'
  | 'AT_CONCURRENCY_CAP'
  | 'NO_AGENTS_AVAILABLE'
  | 'AT_PACING_CAP'
  | 'NO_DIALABLE_LEADS'
  | 'OUTSIDE_CALLING_WINDOW';

export interface DialStatus {
  campaignId: string;
  campaignName: string;
  status: string;
  dialing: boolean;
  reason: DialBlockReason | null;
  detail: string;
  /** When the block clears by itself (ISO); null when it needs a human to act. */
  resumesAt: string | null;
  /** IANA zone `resumesAt` is meaningful in (the leads'), so the UI can show
   *  both "9:00 am Melbourne" and the viewer's own local time. */
  resumesAtTimezone: string | null;
  metrics: {
    dialsToday: number;
    dailyDialBudget: number;
    activeCalls: number;
    maxConcurrentCalls: number;
    availableAgents: number;
    dialsPerAvailableAgent: number;
    dialableLeads: number;
  };
}

/** Capacity verdict shared by the live tick and the read-only status view. */
type CapacityVerdict =
  | { blocked: DialBlockReason; detail: string; resumesAt: Date | null; capacity: 0 }
  | { blocked: null; detail: string; resumesAt: null; capacity: number };

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function nextMidnight(): Date {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d;
}

/**
 * Outbound dial scheduler: every tick, for each ACTIVE campaign, dials as
 * many due leads as pacing allows. Enforces (in order): tenant kill switch
 * (PLAT-08), daily dial budget (ADM-03), channel caps (TEL-08),
 * availability-aware pacing (XFER-03), per-lead legal calling windows
 * (LEAD-06), and the dial-time suppression stack (LEAD-05). Leads are
 * locked atomically so two ticks can never double-dial (the PRD's observed
 * failure #1).
 *
 * `describeStatus` reports the *same* gates read-only, so the UI can explain
 * why an ACTIVE campaign is idle without duplicating (and drifting from) the
 * rules enforced here.
 */
@Injectable()
export class DialerService {
  private readonly logger = new Logger(DialerService.name);
  private ticking = false;
  /** Dev control: dialer only runs when enabled to keep tests deterministic. */
  enabled = true;

  constructor(
    @InjectModel(Campaign.name) private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
    @InjectModel(Tenant.name) private readonly tenantModel: Model<TenantDocument>,
    @InjectModel(Call.name) private readonly callModel: Model<CallDocument>,
    private readonly orchestrator: CallOrchestratorService,
    private readonly suppression: SuppressionService,
    private readonly packs: CountryPacksService,
    private readonly presence: PresenceService,
    private readonly cli: CliService,
  ) {}

  @Interval(5000)
  async tick(): Promise<void> {
    if (!this.enabled || this.ticking) return;
    this.ticking = true;
    try {
      const campaigns = await this.campaignModel.find({ status: 'ACTIVE' }).exec();
      for (const campaign of campaigns) {
        await this.dialCampaign(campaign).catch((err) =>
          this.logger.error(`dial tick failed for campaign ${campaign.name}: ${(err as Error).message}`),
        );
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Leads eligible to be dialed now, ignoring the transient dial lock. */
  private static dialableFilter(campaignId: Types.ObjectId): FilterQuery<LeadDocument> {
    return {
      campaignId,
      state_: { $in: ['FRESH', 'ATTEMPTED', 'CONTACTED', 'CALLBACK'] },
      $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: null }, { nextAttemptAt: { $lte: new Date() } }],
      // A lead a human has claimed for manual dialing is off-limits to the AI
      // dialer — this is what stops manual and auto from double-dialing a lead.
      manualClaimedBy: null,
    };
  }

  /**
   * Tenant/budget/concurrency/pacing gates — everything decidable before we
   * look at an individual lead. Used by both the tick and `describeStatus`.
   */
  private async assessCapacity(campaign: CampaignDocument): Promise<CapacityVerdict> {
    const blocked = (blockedBy: DialBlockReason, detail: string, resumesAt: Date | null = null): CapacityVerdict => ({
      blocked: blockedBy,
      detail,
      resumesAt,
      capacity: 0,
    });

    if (campaign.status !== 'ACTIVE') {
      return blocked('CAMPAIGN_NOT_ACTIVE', `Campaign is ${campaign.status} — press Start to begin dialing.`);
    }

    const tenant = await this.tenantModel.findById(campaign.tenantId).lean().exec();
    if (!tenant || tenant.paused || !tenant.active) {
      return blocked('TENANT_PAUSED', 'All dialing is halted by the account kill switch.');
    }

    if (!campaign.activeFlowVersionId && campaign.abSplits.length === 0) {
      return blocked('NO_FLOW_VERSION', 'No published flow version is assigned to this campaign.');
    }

    const since = startOfToday();
    const dialsToday = await this.callModel.countDocuments({ campaignId: campaign._id, startedAt: { $gte: since } }).exec();
    if (dialsToday >= campaign.dailyDialBudget) {
      return blocked(
        'DAILY_BUDGET_REACHED',
        `Daily dial budget spent (${dialsToday}/${campaign.dailyDialBudget}) — resets at midnight.`,
        nextMidnight(),
      );
    }

    if (tenant.dailyDialQuota > 0) {
      const tenantDials = await this.callModel
        .countDocuments({ tenantId: campaign.tenantId, startedAt: { $gte: since } })
        .exec();
      if (tenantDials >= tenant.dailyDialQuota) {
        return blocked(
          'TENANT_QUOTA_REACHED',
          `Account-wide daily quota spent (${tenantDials}/${tenant.dailyDialQuota}) — resets at midnight.`,
          nextMidnight(),
        );
      }
    }

    const active = this.orchestrator.activeCallCount(campaign._id.toString());
    if (active >= campaign.maxConcurrentCalls) {
      return blocked('AT_CONCURRENCY_CAP', `At the channel cap (${active}/${campaign.maxConcurrentCalls} calls live).`);
    }

    const freeAgents = await this.presence.availableAgentCount(campaign.tenantId.toString(), campaign._id.toString());
    if (freeAgents === 0) {
      return blocked(
        'NO_AGENTS_AVAILABLE',
        'No agent is AVAILABLE — pacing holds dialing so hot leads always have someone to take the transfer.',
      );
    }

    const pacingCap = Math.max(freeAgents * campaign.dialsPerAvailableAgent, 1);
    const capacity = Math.min(
      campaign.maxConcurrentCalls - active,
      pacingCap - active,
      campaign.dailyDialBudget - dialsToday,
    );
    if (capacity <= 0) {
      return blocked(
        'AT_PACING_CAP',
        `Pacing cap reached — ${active} live for ${freeAgents} available agent(s) at ${campaign.dialsPerAvailableAgent}×.`,
      );
    }

    return { blocked: null, detail: 'Dialing.', resumesAt: null, capacity };
  }

  /**
   * Read-only explanation of what the dialer is doing for this campaign and,
   * when idle, exactly which gate is closed and when it reopens.
   */
  async describeStatus(campaign: CampaignDocument): Promise<DialStatus> {
    const verdict = await this.assessCapacity(campaign);
    const dialableLeads = await this.leadModel.countDocuments(DialerService.dialableFilter(campaign._id)).exec();
    const metrics = {
      dialsToday: await this.callModel
        .countDocuments({ campaignId: campaign._id, startedAt: { $gte: startOfToday() } })
        .exec(),
      dailyDialBudget: campaign.dailyDialBudget,
      activeCalls: this.orchestrator.activeCallCount(campaign._id.toString()),
      maxConcurrentCalls: campaign.maxConcurrentCalls,
      availableAgents: await this.presence.availableAgentCount(
        campaign.tenantId.toString(),
        campaign._id.toString(),
      ),
      dialsPerAvailableAgent: campaign.dialsPerAvailableAgent,
      dialableLeads,
    };

    const base = {
      campaignId: campaign._id.toString(),
      campaignName: campaign.name,
      status: campaign.status,
      metrics,
    };

    if (verdict.blocked) {
      return {
        ...base,
        dialing: false,
        reason: verdict.blocked,
        detail: verdict.detail,
        resumesAt: verdict.resumesAt?.toISOString() ?? null,
        resumesAtTimezone: null,
      };
    }

    // Capacity exists — the remaining gates are per-lead: is anything due, and
    // is any due lead inside its own legal calling window right now?
    if (dialableLeads === 0) {
      const soonest = await this.leadModel
        .findOne({ campaignId: campaign._id, state_: { $in: ['FRESH', 'ATTEMPTED', 'CONTACTED', 'CALLBACK'] } })
        .sort({ nextAttemptAt: 1 })
        .select('nextAttemptAt')
        .lean()
        .exec();
      return {
        ...base,
        dialing: false,
        reason: 'NO_DIALABLE_LEADS',
        detail: soonest?.nextAttemptAt
          ? 'Every remaining lead is held by the retry schedule.'
          : 'No leads left to dial — import more or check lead states.',
        resumesAt: soonest?.nextAttemptAt ? new Date(soonest.nextAttemptAt).toISOString() : null,
        resumesAtTimezone: null,
      };
    }

    const pack = await this.packs.getByCode(campaign.countryPackCode);
    const timezones = (await this.leadModel
      .distinct('timezone', DialerService.dialableFilter(campaign._id))
      .exec()) as string[];
    const open = timezones.filter((tz) => tz && isWithinCallingWindow(pack, tz));

    if (open.length === 0 && timezones.length > 0) {
      // Soonest reopening across every timezone present in the due leads.
      const opens = timezones
        .map((tz) => ({ tz, at: nextWindowOpen(pack, tz) }))
        .filter((o): o is { tz: string; at: Date } => o.at instanceof Date)
        .sort((a, b) => a.at.getTime() - b.at.getTime());
      const zoneLabel = timezones.length === 1 ? timezones[0] : `${timezones.length} timezones`;
      return {
        ...base,
        dialing: false,
        reason: 'OUTSIDE_CALLING_WINDOW',
        detail: `Outside legal calling hours for ${zoneLabel} (${campaign.countryPackCode} country pack). Dialing resumes automatically.`,
        resumesAt: opens[0]?.at.toISOString() ?? null,
        resumesAtTimezone: opens[0]?.tz ?? null,
      };
    }

    return {
      ...base,
      dialing: true,
      reason: null,
      detail: `Dialing — capacity for ${verdict.capacity} more call(s).`,
      resumesAt: null,
      resumesAtTimezone: null,
    };
  }

  /** Status for every campaign in a tenant, for the campaigns list view. */
  async statusForTenant(tenantId: string): Promise<DialStatus[]> {
    const campaigns = await this.campaignModel.find({ tenantId: new Types.ObjectId(tenantId) }).exec();
    return Promise.all(campaigns.map((c) => this.describeStatus(c)));
  }

  private async dialCampaign(campaign: CampaignDocument): Promise<void> {
    const verdict = await this.assessCapacity(campaign);
    if (verdict.blocked) return;

    const pack = await this.packs.getByCode(campaign.countryPackCode);

    for (let i = 0; i < verdict.capacity; i += 1) {
      // Atomic lead lock: state dialable, due, unlocked → locked.
      const lead = await this.leadModel
        .findOneAndUpdate(
          {
            ...DialerService.dialableFilter(campaign._id),
            $and: [
              { $or: [{ lockedAt: { $exists: false } }, { lockedAt: null }, { lockedAt: { $lte: new Date(Date.now() - 10 * 60 * 1000) } }] },
            ],
          },
          { lockedAt: new Date() },
          { sort: { nextAttemptAt: 1 }, new: true },
        )
        .exec();
      if (!lead) break;

      // Legal calling window in the lead's local timezone per LEAD-06.
      if (!isWithinCallingWindow(pack, lead.timezone)) {
        lead.nextAttemptAt = nextWindowOpen(pack, lead.timezone) ?? new Date(Date.now() + 60 * 60 * 1000);
        lead.lockedAt = undefined;
        await lead.save();
        continue;
      }

      // Dial-time suppression stack per LEAD-05.
      const verdictSuppression = await this.suppression.checkAtDialTime({
        tenantId: campaign.tenantId.toString(),
        clientId: lead.clientId.toString(),
        phone: lead.phone,
        countryPackCode: campaign.countryPackCode,
        dncEnforced: pack.dnc.enforced,
        frequencyCapDays: campaign.frequencyCapDays,
      });
      if (!verdictSuppression.allowed) {
        lead.lockedAt = undefined;
        if (verdictSuppression.reason === 'DNC_LISTED' || verdictSuppression.reason === 'OPT_OUT') {
          lead.state_ = 'DNC';
          lead.timeline.push({ at: new Date(), kind: 'SUPPRESSION', detail: `Blocked at dial time: ${verdictSuppression.reason}` });
        } else if (verdictSuppression.reason === 'DNC_WASH_STALE') {
          // Hold until re-washed; the wash scheduler owns the retry.
          lead.nextAttemptAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
          lead.timeline.push({ at: new Date(), kind: 'SUPPRESSION', detail: 'Held: DNC wash missing or stale' });
        } else {
          lead.nextAttemptAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
          lead.timeline.push({ at: new Date(), kind: 'SUPPRESSION', detail: `Held: ${verdictSuppression.reason}` });
        }
        await lead.save();
        continue;
      }

      const cli = await this.cli.selectCli({
        tenantId: campaign.tenantId.toString(),
        poolIds: campaign.cliPool,
        leadState: lead.state,
        geoMatch: campaign.cliRules.geoMatch,
      });

      // Fire the call without blocking the tick loop.
      void this.orchestrator
        .placeCall(campaign, lead, cli?.number)
        // Feed the real answer result into CLI health so a number whose answer
        // rate collapses actually gets rested.
        .then((result) => cli && this.cli.recordDial(cli._id, result.answered))
        .catch(async (err) => {
          this.logger.error(`call failed: ${(err as Error).message}`);
          if (cli) await this.cli.recordDial(cli._id, false);
        });
    }
  }
}
