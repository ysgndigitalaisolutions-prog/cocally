import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Interval } from '@nestjs/schedule';
import { Model, Types } from 'mongoose';
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

/**
 * Outbound dial scheduler: every tick, for each ACTIVE campaign, dials as
 * many due leads as pacing allows. Enforces (in order): tenant kill switch
 * (PLAT-08), daily dial budget (ADM-03), channel caps (TEL-08),
 * availability-aware pacing (XFER-03), per-lead legal calling windows
 * (LEAD-06), and the dial-time suppression stack (LEAD-05). Leads are
 * locked atomically so two ticks can never double-dial (the PRD's observed
 * failure #1).
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

  private async dialCampaign(campaign: CampaignDocument): Promise<void> {
    const tenant = await this.tenantModel.findById(campaign.tenantId).lean().exec();
    if (!tenant || tenant.paused || !tenant.active) return;

    // Daily dial budget per ADM-03 + tenant quota per PLAT-08.
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const dialsToday = await this.callModel
      .countDocuments({ campaignId: campaign._id, startedAt: { $gte: startOfDay } })
      .exec();
    if (dialsToday >= campaign.dailyDialBudget) return;
    if (tenant.dailyDialQuota > 0) {
      const tenantDials = await this.callModel
        .countDocuments({ tenantId: campaign.tenantId, startedAt: { $gte: startOfDay } })
        .exec();
      if (tenantDials >= tenant.dailyDialQuota) return;
    }

    // Concurrency cap per TEL-08 and availability-aware pacing per XFER-03.
    const active = this.orchestrator.activeCallCount(campaign._id.toString());
    const freeAgents = await this.presence.availableAgentCount(campaign.tenantId.toString(), campaign._id.toString());
    const pacingCap = Math.max(freeAgents * campaign.dialsPerAvailableAgent, freeAgents > 0 ? 1 : 0);
    const capacity = Math.min(campaign.maxConcurrentCalls - active, pacingCap - active, campaign.dailyDialBudget - dialsToday);
    if (capacity <= 0) return;

    const pack = await this.packs.getByCode(campaign.countryPackCode);

    for (let i = 0; i < capacity; i += 1) {
      // Atomic lead lock: state dialable, due, unlocked → locked.
      const lead = await this.leadModel
        .findOneAndUpdate(
          {
            campaignId: campaign._id,
            state_: { $in: ['FRESH', 'ATTEMPTED', 'CONTACTED', 'CALLBACK'] },
            $and: [
              { $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: null }, { nextAttemptAt: { $lte: new Date() } }] },
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
      const verdict = await this.suppression.checkAtDialTime({
        tenantId: campaign.tenantId.toString(),
        clientId: lead.clientId.toString(),
        phone: lead.phone,
        countryPackCode: campaign.countryPackCode,
        dncEnforced: pack.dnc.enforced,
        frequencyCapDays: campaign.frequencyCapDays,
      });
      if (!verdict.allowed) {
        lead.lockedAt = undefined;
        if (verdict.reason === 'DNC_LISTED' || verdict.reason === 'OPT_OUT') {
          lead.state_ = 'DNC';
          lead.timeline.push({ at: new Date(), kind: 'SUPPRESSION', detail: `Blocked at dial time: ${verdict.reason}` });
        } else if (verdict.reason === 'DNC_WASH_STALE') {
          // Hold until re-washed; the wash scheduler owns the retry.
          lead.nextAttemptAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
          lead.timeline.push({ at: new Date(), kind: 'SUPPRESSION', detail: 'Held: DNC wash missing or stale' });
        } else {
          lead.nextAttemptAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
          lead.timeline.push({ at: new Date(), kind: 'SUPPRESSION', detail: `Held: ${verdict.reason}` });
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
        .then(() => cli && this.cli.recordDial(cli._id, true))
        .catch((err) => this.logger.error(`call failed: ${(err as Error).message}`));
    }
  }
}
