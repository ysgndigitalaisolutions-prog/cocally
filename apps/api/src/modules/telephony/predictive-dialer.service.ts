import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Interval } from '@nestjs/schedule';
import type { CallOutcome } from '@cocally/shared';
import { FilterQuery, Model, Types } from 'mongoose';
import { isLiveTelephony } from '../../common/config';
import { Call, CallDocument } from '../../schemas/call.schema';
import { Campaign, CampaignDocument } from '../../schemas/campaign.schema';
import { CliNumber, CliNumberDocument } from '../../schemas/cli-number.schema';
import { Lead, LeadDocument } from '../../schemas/lead.schema';
import { Tenant, TenantDocument } from '../../schemas/tenant.schema';
import { User, UserDocument } from '../../schemas/user.schema';
import { SimulationRuntime } from '../engine/simulation.runtime';
import { CountryPacksService } from '../country-packs/country-packs.service';
import { isWithinCallingWindow, nextWindowOpen } from '../country-packs/calling-windows';
import { LeadsService } from '../leads/leads.service';
import { SuppressionService } from '../leads/suppression.service';
import { PresenceService } from '../workspace/presence.service';
import { RealtimeGateway } from '../workspace/realtime.gateway';
import { CliService } from './cli.service';

export type PredictiveBlockReason =
  | 'DISABLED'
  | 'TENANT_PAUSED'
  | 'DAILY_BUDGET_REACHED'
  | 'NO_AGENTS_LOGGED_IN'
  | 'AT_PACING_CAP'
  | 'NO_DIALABLE_LEADS'
  | 'OUTSIDE_CALLING_WINDOW';

export interface PredictiveDialStatus {
  campaignId: string;
  campaignName: string;
  dialing: boolean;
  reason: PredictiveBlockReason | null;
  detail: string;
  ratio: number;
  method: 'FIXED_RATIO' | 'ADAPT_HARD_LIMIT';
  metrics: {
    eligibleAgents: number;
    availableAgentsNow: number;
    activeLines: number;
    dialsToday: number;
    dailyDialBudget: number;
    abandonRatePercent: number | null;
    abandonSampleSize: number;
    maxAbandonRatePercent: number;
    dialableLeads: number;
  };
}

type CapacityVerdict =
  | { blocked: PredictiveBlockReason; detail: string; capacity: 0 }
  | { blocked: null; detail: string; capacity: number };

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Ratio / adaptive dialing for the HUMAN-agent floor — ViciDial's actual
 * predictive dialer, as distinct from `DialerService` (which fronts calls
 * with the AI and warm-transfers). The system dials AHEAD of agent
 * availability (ratio > 1 lines per logged-in agent); a human who answers is
 * bridged to the next free agent immediately (no offer/countdown — the
 * customer is already live). If nobody is free inside the legal window
 * (`abandonTimeoutSeconds`, the FCC/TCPA-style ≤2s rule), the call is
 * ABANDONED and the ratio governor (`adjustRatio`) pulls back.
 *
 * A campaign runs in exactly one dialing mode: `DialerService` refuses to
 * touch a campaign with `predictiveDialing.enabled` (see PREDICTIVE_MODE_ACTIVE),
 * and this service only ever touches campaigns with it enabled — so the two
 * lock-and-place loops never race the same lead pool.
 */
@Injectable()
export class PredictiveDialerService {
  private readonly logger = new Logger(PredictiveDialerService.name);
  private ticking = false;
  enabled = true;

  /** In-flight predictive lines, keyed by callId — this tick's concurrency truth. */
  private readonly activeCalls = new Map<string, { campaignId: string; tenantId: string }>();
  /** Throttles the ratio governor to ~15s cadence (ViciDial's AST_VDadapt interval) even though the tick itself runs every 5s. */
  private readonly lastAdjustedAt = new Map<string, number>();
  /** Campaigns already warned about the live-trunk guard, so the log is one line per campaign, not one per 5s tick. */
  private readonly liveTrunkWarned = new Set<string>();

  constructor(
    @InjectModel(Campaign.name) private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
    @InjectModel(Tenant.name) private readonly tenantModel: Model<TenantDocument>,
    @InjectModel(Call.name) private readonly callModel: Model<CallDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(CliNumber.name) private readonly cliNumberModel: Model<CliNumberDocument>,
    private readonly packs: CountryPacksService,
    private readonly suppression: SuppressionService,
    private readonly leads: LeadsService,
    private readonly presence: PresenceService,
    private readonly gateway: RealtimeGateway,
    private readonly cli: CliService,
  ) {}

  @Interval(5000)
  async tick(): Promise<void> {
    if (!this.enabled || this.ticking) return;
    this.ticking = true;
    try {
      const campaigns = await this.campaignModel
        .find({ status: 'ACTIVE', 'predictiveDialing.enabled': true })
        .exec();
      for (const campaign of campaigns) {
        await this.adjustRatio(campaign).catch((err) =>
          this.logger.error(`ratio governor failed for ${campaign.name}: ${(err as Error).message}`),
        );
        await this.dialCampaign(campaign).catch((err) =>
          this.logger.error(`predictive tick failed for ${campaign.name}: ${(err as Error).message}`),
        );
      }
    } finally {
      this.ticking = false;
    }
  }

  private activeCallCount(campaignId: string): number {
    return [...this.activeCalls.values()].filter((c) => c.campaignId === campaignId).length;
  }

  private static dialableFilter(campaignId: Types.ObjectId): FilterQuery<LeadDocument> {
    return {
      campaignId,
      state_: { $in: ['FRESH', 'ATTEMPTED', 'CONTACTED', 'CALLBACK'] },
      $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: null }, { nextAttemptAt: { $lte: new Date() } }],
      manualClaimedBy: null,
    };
  }

  /**
   * Agents counted toward the ratio: logged into the floor and eligible for
   * this campaign, whether idle right now or mid-call — ViciDial's ratio is
   * against agents in READY+INCALL, not just idle ones, since busy agents
   * free up while lines are still ringing out.
   */
  private async eligibleAgentCount(tenantId: string, campaignId: string): Promise<number> {
    return this.userModel
      .countDocuments({
        tenantId: new Types.ObjectId(tenantId),
        active: true,
        roles: 'AGENT',
        presence: { $in: ['AVAILABLE', 'ON_CALL', 'WRAP_UP', 'RESERVED'] },
        $or: [{ skills: { $size: 0 } }, { skills: campaignId }],
      })
      .exec();
  }

  /** Rolling operational abandon rate — short window, minimum sample size, used to steer the ratio in near-real-time. Compliance reporting over the true 30-day window is a separate concern (see the reporting endpoints). */
  private async abandonRate(campaignId: Types.ObjectId): Promise<{ ratePercent: number | null; sample: number }> {
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const [connected, abandoned] = await Promise.all([
      this.callModel
        .countDocuments({ campaignId, predictive: true, startedAt: { $gte: since }, outcome: { $in: ['ANSWERED_HUMAN', 'ABANDONED'] } })
        .exec(),
      this.callModel.countDocuments({ campaignId, predictive: true, startedAt: { $gte: since }, outcome: 'ABANDONED' }).exec(),
    ]);
    if (connected < 10) return { ratePercent: null, sample: connected };
    return { ratePercent: (abandoned / connected) * 100, sample: connected };
  }

  /**
   * The governor: ADAPT_HARD_LIMIT pulls the ratio down whenever the abandon
   * rate is over the legal cap, and lets it drift up toward maxRatio when
   * there is clear headroom — mirroring ViciDial's AST_VDadapt process.
   * FIXED_RATIO campaigns are left exactly as the operator set them.
   */
  private async adjustRatio(campaign: CampaignDocument): Promise<void> {
    const cfg = campaign.predictiveDialing;
    if (cfg.method !== 'ADAPT_HARD_LIMIT') return;

    const key = campaign._id.toString();
    const last = this.lastAdjustedAt.get(key) ?? 0;
    if (Date.now() - last < 15_000) return;
    this.lastAdjustedAt.set(key, Date.now());

    const { ratePercent, sample } = await this.abandonRate(campaign._id);
    if (ratePercent === null) return; // not enough data to trust yet

    const step = 0.1;
    let nextRatio = cfg.ratio;
    if (ratePercent > cfg.maxAbandonRatePercent) {
      nextRatio = Math.max(cfg.minRatio, +(cfg.ratio - step).toFixed(2));
    } else if (ratePercent < cfg.maxAbandonRatePercent * 0.5) {
      nextRatio = Math.min(cfg.maxRatio, +(cfg.ratio + step).toFixed(2));
    }
    if (nextRatio !== cfg.ratio) {
      await this.campaignModel.updateOne({ _id: campaign._id }, { 'predictiveDialing.ratio': nextRatio }).exec();
      this.logger.log(
        `${campaign.name}: ratio ${cfg.ratio} → ${nextRatio} (abandon ${ratePercent.toFixed(1)}%, n=${sample})`,
      );
      campaign.predictiveDialing.ratio = nextRatio; // keep this tick's in-memory doc consistent for dialCampaign()
    }
  }

  private async assessCapacity(campaign: CampaignDocument): Promise<CapacityVerdict> {
    const blocked = (reason: PredictiveBlockReason, detail: string): CapacityVerdict => ({ blocked: reason, detail, capacity: 0 });

    if (!campaign.predictiveDialing?.enabled || campaign.status !== 'ACTIVE') {
      return blocked('DISABLED', 'Predictive dialing is not enabled for this campaign.');
    }

    const tenant = await this.tenantModel.findById(campaign.tenantId).lean().exec();
    if (!tenant || tenant.paused || !tenant.active) {
      return blocked('TENANT_PAUSED', 'All dialing is halted by the account kill switch.');
    }

    const since = startOfToday();
    const dialsToday = await this.callModel.countDocuments({ campaignId: campaign._id, startedAt: { $gte: since } }).exec();
    if (dialsToday >= campaign.dailyDialBudget) {
      return blocked('DAILY_BUDGET_REACHED', `Daily dial budget spent (${dialsToday}/${campaign.dailyDialBudget}).`);
    }

    const eligible = await this.eligibleAgentCount(campaign.tenantId.toString(), campaign._id.toString());
    if (eligible === 0) {
      return blocked('NO_AGENTS_LOGGED_IN', 'No agent is logged into the floor for this campaign.');
    }

    const active = this.activeCallCount(campaign._id.toString());
    const ratioLines = Math.ceil(campaign.predictiveDialing.ratio * eligible);
    const capacity = Math.min(campaign.maxConcurrentCalls - active, ratioLines - active, campaign.dailyDialBudget - dialsToday);
    if (capacity <= 0) {
      return blocked(
        'AT_PACING_CAP',
        `Pacing cap reached — ${active} live lines for ${eligible} logged-in agent(s) at ${campaign.predictiveDialing.ratio}× ratio.`,
      );
    }

    return { blocked: null, detail: 'Dialing.', capacity };
  }

  async describeStatus(campaign: CampaignDocument): Promise<PredictiveDialStatus> {
    const verdict = await this.assessCapacity(campaign);
    const dialableLeads = await this.leadModel.countDocuments(PredictiveDialerService.dialableFilter(campaign._id)).exec();
    const { ratePercent, sample } = await this.abandonRate(campaign._id);
    const eligibleAgents = await this.eligibleAgentCount(campaign.tenantId.toString(), campaign._id.toString());
    const availableAgentsNow = await this.presence.availableAgentCount(campaign.tenantId.toString(), campaign._id.toString());
    const dialsToday = await this.callModel.countDocuments({ campaignId: campaign._id, startedAt: { $gte: startOfToday() } }).exec();

    const base = {
      campaignId: campaign._id.toString(),
      campaignName: campaign.name,
      ratio: campaign.predictiveDialing.ratio,
      method: campaign.predictiveDialing.method,
      metrics: {
        eligibleAgents,
        availableAgentsNow,
        activeLines: this.activeCallCount(campaign._id.toString()),
        dialsToday,
        dailyDialBudget: campaign.dailyDialBudget,
        abandonRatePercent: ratePercent,
        abandonSampleSize: sample,
        maxAbandonRatePercent: campaign.predictiveDialing.maxAbandonRatePercent,
        dialableLeads,
      },
    };

    if (verdict.blocked) {
      return { ...base, dialing: false, reason: verdict.blocked, detail: verdict.detail };
    }
    if (dialableLeads === 0) {
      return { ...base, dialing: false, reason: 'NO_DIALABLE_LEADS', detail: 'No leads left to dial right now.' };
    }

    const pack = await this.packs.getByCode(campaign.countryPackCode);
    const timezones = (await this.leadModel.distinct('timezone', PredictiveDialerService.dialableFilter(campaign._id)).exec()) as string[];
    const open = timezones.filter((tz) => tz && isWithinCallingWindow(pack, tz));
    if (open.length === 0 && timezones.length > 0) {
      return { ...base, dialing: false, reason: 'OUTSIDE_CALLING_WINDOW', detail: 'Outside legal calling hours for every due lead’s timezone.' };
    }

    return { ...base, dialing: true, reason: null, detail: `Dialing — capacity for ${verdict.capacity} more line(s).` };
  }

  async statusForTenant(tenantId: string): Promise<PredictiveDialStatus[]> {
    const campaigns = await this.campaignModel
      .find({ tenantId: new Types.ObjectId(tenantId), 'predictiveDialing.enabled': true })
      .exec();
    return Promise.all(campaigns.map((c) => this.describeStatus(c)));
  }

  private async dialCampaign(campaign: CampaignDocument): Promise<void> {
    // This dialer still fakes its calls with SimulationRuntime — it never
    // sends an INVITE, and `amdClassify()` invents an answer. Against a live
    // trunk that is worse than doing nothing: it would burn through the lead
    // pool placing no calls at all while bridging agents to nobody and
    // reporting healthy connect rates. Refuse to run until it has a real
    // media path (LiveCallDriver + CallProgressService cover the AI dialer;
    // the human-agent predictive path is a separate piece of work).
    if (isLiveTelephony()) {
      const key = campaign._id.toString();
      if (!this.liveTrunkWarned.has(key)) {
        this.liveTrunkWarned.add(key);
        this.logger.warn(
          `predictive dialing is not implemented against a live trunk — campaign ${campaign.name} left idle`,
        );
      }
      return;
    }

    const verdict = await this.assessCapacity(campaign);
    if (verdict.blocked) return;

    const pack = await this.packs.getByCode(campaign.countryPackCode);

    for (let i = 0; i < verdict.capacity; i += 1) {
      const lead = await this.leadModel
        .findOneAndUpdate(
          {
            ...PredictiveDialerService.dialableFilter(campaign._id),
            $and: [{ $or: [{ lockedAt: { $exists: false } }, { lockedAt: null }, { lockedAt: { $lte: new Date(Date.now() - 10 * 60 * 1000) } }] }],
          },
          { lockedAt: new Date() },
          { sort: { nextAttemptAt: 1 }, new: true },
        )
        .exec();
      if (!lead) break;

      if (!isWithinCallingWindow(pack, lead.timezone)) {
        lead.nextAttemptAt = nextWindowOpen(pack, lead.timezone) ?? new Date(Date.now() + 60 * 60 * 1000);
        lead.lockedAt = undefined;
        await lead.save();
        continue;
      }

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
          lead.nextAttemptAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
          lead.timeline.push({ at: new Date(), kind: 'SUPPRESSION', detail: 'Held: DNC wash missing or stale' });
        } else {
          lead.nextAttemptAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
          lead.timeline.push({ at: new Date(), kind: 'SUPPRESSION', detail: `Held: ${verdictSuppression.reason}` });
        }
        await lead.save();
        continue;
      }

      const cliNumber = await this.cli.selectCli({
        tenantId: campaign.tenantId.toString(),
        poolIds: campaign.cliPool,
        leadState: lead.state,
        geoMatch: campaign.cliRules.geoMatch,
      });

      void this.placeCall(campaign, lead, cliNumber).catch((err) => this.logger.error(`predictive call failed: ${(err as Error).message}`));
    }
  }

  private async placeCall(campaign: CampaignDocument, lead: LeadDocument, cliNumber: CliNumberDocument | null): Promise<void> {
    const call = await this.callModel.create({
      tenantId: campaign.tenantId,
      campaignId: campaign._id,
      leadId: lead._id,
      cli: cliNumber?.number,
      state: 'DIALING',
      predictive: true,
      startedAt: new Date(),
    });
    const callId = call._id.toString();
    this.activeCalls.set(callId, { campaignId: campaign._id.toString(), tenantId: campaign.tenantId.toString() });

    try {
      // AMD only — no AI conversation on this leg. The SIP runtime slots in
      // behind the same amdClassify() call once the carrier is wired; see
      // claude-dev/2026-07-23-human-dialing-requirements.md.
      const runtime = new SimulationRuntime({});
      const { amdClass, latencyMs } = await runtime.amdClassify();
      call.amdClass = amdClass;
      call.amdLatencyMs = latencyMs;
      call.answeredAt = new Date();
      await call.save();

      if (amdClass === 'HUMAN') {
        await this.connectHuman(call, lead, campaign);
      } else {
        await this.finishNonHuman(call, lead, campaign, amdClass);
      }

      if (cliNumber) await this.cli.recordDial(cliNumber._id, amdClass === 'HUMAN');
    } finally {
      this.activeCalls.delete(callId);
    }
  }

  /**
   * A human answered — bridge to the next free agent right now, with no
   * offer/accept dance (unlike TransfersService's AI-warm-transfer cascade):
   * the customer is already live, so every extra second here is dead air
   * that counts against the abandon-rate cap. One shot, not a cascade — if
   * the single best-eligible agent isn't actually free, this is abandoned.
   */
  private async connectHuman(call: CallDocument, lead: LeadDocument, campaign: CampaignDocument): Promise<void> {
    const agent = await this.presence.selectAgent({
      tenantId: campaign.tenantId.toString(),
      campaignId: campaign._id.toString(),
      strategy: campaign.routingStrategy,
      excludeIds: [],
      stickyAgentId: lead.preferredAgentId?.toString(),
    });
    const reserved = agent ? await this.presence.reserve(agent._id) : false;

    if (!agent || !reserved) {
      await this.abandon(call, lead, campaign);
      return;
    }

    await this.presence.markOnCall(agent._id.toString());
    call.agentId = agent._id;
    call.state = 'BRIDGED';
    call.bridgedAt = new Date();
    call.outcome = 'ANSWERED_HUMAN';
    await call.save();

    lead.preferredAgentId = agent._id;
    lead.timeline.push({ at: new Date(), kind: 'TRANSFER', detail: `Predictive-dial bridged to agent ${agent.name}`, callId: call._id.toString() });
    await lead.save();

    this.gateway.emitToUser(agent._id.toString(), 'predictive.call.bridged', {
      callId: call._id.toString(),
      leadId: lead._id.toString(),
      leadName: [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.phone,
      phone: lead.phone,
      location: [lead.suburb, lead.state].filter(Boolean).join(', '),
      campaignId: campaign._id.toString(),
      campaignName: campaign.name,
    });
  }

  /** No agent was free within the legal window — FCC/TCPA-style abandoned call: drop it, log the compliance event, and feed the fast-retry path (not the generic no-answer matrix). */
  private async abandon(call: CallDocument, lead: LeadDocument, campaign: CampaignDocument): Promise<void> {
    call.state = 'COMPLETED';
    call.outcome = 'ABANDONED';
    call.endedAt = new Date();
    call.complianceEvents.push({
      atMs: 0,
      kind: 'ABANDONED_CALL_NOTICE',
      detail: 'Connected but no agent was free within the legal window — dropped per the abandoned-call rule.',
    });
    await call.save();
    await this.leads.applyOutcome(lead._id.toString(), 'ABANDONED', call._id.toString());
    this.gateway.emitToTenant(campaign.tenantId.toString(), 'predictive.call.ended', { callId: call._id.toString() });
  }

  private async finishNonHuman(call: CallDocument, lead: LeadDocument, campaign: CampaignDocument, amdClass: string): Promise<void> {
    const outcome: CallOutcome = amdClass === 'VOICEMAIL' ? 'ANSWERED_VOICEMAIL' : amdClass === 'IVR' ? 'ANSWERED_IVR' : 'NO_ANSWER';
    call.state = 'COMPLETED';
    call.outcome = outcome;
    call.endedAt = new Date();
    await call.save();
    await this.leads.applyOutcome(lead._id.toString(), outcome, call._id.toString());
  }
}
