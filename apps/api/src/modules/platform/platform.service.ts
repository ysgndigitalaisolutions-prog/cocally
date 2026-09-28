import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  DEFAULT_RATE_CARD,
  PlatformSettings,
  PlatformSettingsDocument,
  type RateCard,
} from '../../schemas/platform-settings.schema';
import { Tenant, TenantDocument, type TenantBilling, type TenantVoice } from '../../schemas/tenant.schema';
import { BillingService, normaliseBilling, priceUsage } from './billing.service';
import { EMPTY_USAGE, UsageService, type TenantUsage } from './usage.service';
import { User, UserDocument } from '../../schemas/user.schema';

export interface CostBreakdown {
  aiAgent: number;
  phoneLine: number;
  agentBrowser: number;
  stt: number;
  llm: number;
  tts: number;
  recording: number;
  carrier: number;
  total: number;
}

export interface TenantOverviewRow {
  tenantId: string;
  name: string;
  slug: string;
  paused: boolean;
  usage: TenantUsage;
  /** US dollars. */
  costUsd: CostBreakdown;
  costInr: number;
  /** Rupees billed for usage (AI minutes + dials), before GST and advance. */
  billedInr: number;
  marginInr: number;
  billing: TenantBilling;
  billingSet: boolean;
  voice: TenantVoice | null;
  /** Prepaid advance left (₹, before GST). */
  creditBalanceInr: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class PlatformService {
  constructor(
    private readonly usageService: UsageService,
    private readonly billingService: BillingService,
    @InjectModel(Tenant.name) private readonly tenantModel: Model<TenantDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(PlatformSettings.name) private readonly settingsModel: Model<PlatformSettingsDocument>,
  ) {}

  async rateCard(): Promise<RateCard> {
    const doc = await this.settingsModel.findOne({ key: 'default' }).lean().exec();
    return { ...DEFAULT_RATE_CARD, ...(doc?.rateCard ?? {}) };
  }

  async updateRateCard(patch: Partial<RateCard>): Promise<RateCard> {
    const next = { ...(await this.rateCard()), ...patch };
    await this.settingsModel.updateOne({ key: 'default' }, { $set: { rateCard: next } }, { upsert: true }).exec();
    return next;
  }

  static cost(u: TenantUsage, rc: RateCard): CostBreakdown {
    const min = (s: number) => s / 60;
    const parts = {
      aiAgent: min(u.aiSeconds) * rc.livekitAgentPerMin,
      phoneLine: min(u.ringSeconds + u.aiSeconds + u.humanSeconds) * rc.livekitSipPerMin,
      agentBrowser: min(u.humanSeconds) * rc.livekitWebrtcPerMin,
      stt: min(u.aiSeconds) * rc.sttPerMin,
      llm: min(u.aiSeconds) * rc.llmPerMin,
      tts: (u.ttsChars / 1000) * rc.ttsPer1kChars,
      recording: min(u.recordedSeconds) * rc.recordingPerMin,
      carrier: min(u.aiSeconds + u.humanSeconds) * rc.telcoPerMin,
    };
    const total = Object.values(parts).reduce((a, b) => a + b, 0);
    return Object.fromEntries(
      Object.entries({ ...parts, total }).map(([k, v]) => [k, Math.round(v * 10_000) / 10_000]),
    ) as unknown as CostBreakdown;
  }

  /** Rupees for usage at the tenant's band for the period (before GST and advance). */
  static billed(u: TenantUsage, b: TenantBilling): number {
    return priceUsage(u, b).subtotalInr;
  }

  async overview(from: Date, to: Date) {
    const [rc, usage, tenants] = await Promise.all([
      this.rateCard(),
      this.usageService.usage({ from, to }),
      this.tenantModel.find().sort({ name: 1 }).lean().exec(),
    ]);
    const balances = await Promise.all(tenants.map((t) => this.billingService.balance(t._id.toString())));
    const rows: TenantOverviewRow[] = tenants.map((t, i) => {
      const u = usage.get(t._id.toString()) ?? { ...EMPTY_USAGE };
      const costUsd = PlatformService.cost(u, rc);
      const billing = normaliseBilling(t.billing);
      const costInr = round2(costUsd.total * rc.inrPerUsd);
      const billedInr = PlatformService.billed(u, billing);
      return {
        tenantId: t._id.toString(),
        name: t.name,
        slug: t.slug,
        paused: t.paused,
        usage: u,
        costUsd,
        costInr,
        billedInr,
        marginInr: round2(billedInr - costInr),
        billing,
        billingSet: Boolean(t.billing),
        voice: t.voice ?? null,
        creditBalanceInr: balances[i] ?? 0,
      };
    });
    const days = Math.max(1, (to.getTime() - from.getTime()) / 86_400_000);
    const fixedInr = round2(((rc.fixedMonthlyUsd * days) / 30) * rc.inrPerUsd);
    const sum = (f: (r: TenantOverviewRow) => number) => round2(rows.reduce((a, r) => a + f(r), 0));
    const totals = {
      dials: sum((r) => r.usage.dials),
      aiMinutes: round2(sum((r) => r.usage.aiSeconds) / 60),
      humanMinutes: round2(sum((r) => r.usage.humanSeconds) / 60),
      costInr: sum((r) => r.costInr),
      billedInr: sum((r) => r.billedInr),
      fixedInr,
    };
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      rateCard: rc,
      rows,
      totals: { ...totals, marginInr: round2(totals.billedInr - totals.costInr - fixedInr) },
    };
  }

  async tenantDetail(id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Tenant not found');
    const tenant = await this.tenantModel.findById(id).lean().exec();
    if (!tenant) throw new NotFoundException('Tenant not found');
    const users = await this.userModel.countDocuments({ tenantId: tenant._id, active: { $ne: false } }).exec();
    return {
      tenantId: tenant._id.toString(),
      name: tenant.name,
      slug: tenant.slug,
      paused: tenant.paused,
      dailyDialQuota: tenant.dailyDialQuota,
      voice: tenant.voice ?? null,
      billing: normaliseBilling(tenant.billing),
      billingSet: Boolean(tenant.billing),
      users,
    };
  }

  async updateTenant(
    id: string,
    patch: { voice?: TenantVoice | null; billing?: TenantBilling; paused?: boolean; dailyDialQuota?: number },
  ) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Tenant not found');
    const before = await this.tenantDetail(id);
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ''> = {};
    if (patch.voice === null) $unset.voice = '';
    else if (patch.voice) $set.voice = { provider: patch.voice.provider, voiceId: patch.voice.voiceId?.trim() || undefined };
    if (patch.billing) $set.billing = patch.billing;
    if (patch.paused !== undefined) $set.paused = patch.paused;
    if (patch.dailyDialQuota !== undefined) $set.dailyDialQuota = patch.dailyDialQuota;
    await this.tenantModel
      .updateOne({ _id: new Types.ObjectId(id) }, { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) })
      .exec();
    return { before, after: await this.tenantDetail(id) };
  }
}
