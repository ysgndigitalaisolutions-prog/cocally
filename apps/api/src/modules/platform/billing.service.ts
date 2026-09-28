import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  CreditEntry,
  CreditEntryDocument,
  Invoice,
  InvoiceDocument,
  type CreditKind,
  type InvoiceLine,
} from '../../schemas/billing.schema';
import { Campaign, CampaignDocument } from '../../schemas/campaign.schema';
import {
  DEFAULT_SELLER,
  PlatformSettings,
  PlatformSettingsDocument,
  type SellerDetails,
} from '../../schemas/platform-settings.schema';
import { Tenant, TenantDocument, type BillingTier, type TenantBilling } from '../../schemas/tenant.schema';
import { EMPTY_USAGE, UsageService, type TenantUsage } from './usage.service';

/** The pilot quote (Shubham Mantri, July 2026): used until a tenant's billing is set. */
export const DEFAULT_BILLING: TenantBilling = {
  tiers: [
    { fromMinutes: 0, aiPerMinInr: 8.5, perDialInr: 0.8 },
    { fromMinutes: 10_000, aiPerMinInr: 8.0, perDialInr: 0.7 },
  ],
  monthlyAdvanceInr: 50_000,
  advanceRule: 'CARRY_FORWARD',
  gstPercent: 18,
};

const TIER_NAMES = ['Standard', 'Growth', 'Scale', 'Enterprise'];

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Billing months are IST calendar months: the client and CoCally are both in India. */
const IST_OFFSET_MS = 5.5 * 3600_000;

export function monthBounds(period: string): { from: Date; to: Date } {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) throw new BadRequestException('month must be YYYY-MM');
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) throw new BadRequestException('month must be YYYY-MM');
  return {
    from: new Date(Date.UTC(y, mo - 1, 1) - IST_OFFSET_MS),
    to: new Date(Date.UTC(y, mo, 1) - IST_OFFSET_MS),
  };
}

export function currentPeriod(now = new Date()): string {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Old single-rate billing ({aiPerMinInr, perDialInr, monthlyAdvanceInr}) read as one band. */
export function normaliseBilling(raw: unknown): TenantBilling {
  const b = (raw ?? {}) as Partial<TenantBilling> & { aiPerMinInr?: number; perDialInr?: number };
  const tiers: BillingTier[] =
    Array.isArray(b.tiers) && b.tiers.length > 0
      ? [...b.tiers].sort((x, y) => x.fromMinutes - y.fromMinutes)
      : b.aiPerMinInr !== undefined
        ? [{ fromMinutes: 0, aiPerMinInr: b.aiPerMinInr, perDialInr: b.perDialInr ?? 0 }]
        : DEFAULT_BILLING.tiers;
  return {
    tiers,
    monthlyAdvanceInr: b.monthlyAdvanceInr ?? DEFAULT_BILLING.monthlyAdvanceInr,
    advanceRule: b.advanceRule ?? DEFAULT_BILLING.advanceRule,
    gstPercent: b.gstPercent ?? DEFAULT_BILLING.gstPercent,
    ...(b.billTo ? { billTo: b.billTo } : {}),
  };
}

export interface PricedUsage {
  aiMinutes: number;
  tierIndex: number;
  tierLabel: string;
  tier: BillingTier;
  lines: InvoiceLine[];
  subtotalInr: number;
}

/**
 * Price a month's usage. The month's total AI minutes pick the band, and that
 * band's rates apply to all of the month's minutes and dials (the quote's
 * "as your usage scales, the per-minute rate steps down automatically").
 * AI time is billed per second, shown in minutes to two decimals.
 */
export function priceUsage(u: TenantUsage, billing: TenantBilling): PricedUsage {
  const aiMinutes = round2(u.aiSeconds / 60);
  let tierIndex = 0;
  billing.tiers.forEach((t, i) => {
    if (aiMinutes >= t.fromMinutes) tierIndex = i;
  });
  const tier = billing.tiers[tierIndex] ?? DEFAULT_BILLING.tiers[0]!;
  const lines: InvoiceLine[] = [
    {
      label: 'AI conversation (live AI-to-customer talk time)',
      quantity: aiMinutes,
      unit: 'min',
      rateInr: tier.aiPerMinInr,
      amountInr: round2(aiMinutes * tier.aiPerMinInr),
    },
    {
      label: 'Dialled attempts (screening, AMD, voicemail detection, transfer hold)',
      quantity: u.dials,
      unit: 'dial',
      rateInr: tier.perDialInr,
      amountInr: round2(u.dials * tier.perDialInr),
    },
  ];
  return {
    aiMinutes,
    tierIndex,
    tierLabel: TIER_NAMES[tierIndex] ?? `Band ${tierIndex + 1}`,
    tier,
    lines,
    subtotalInr: round2(lines.reduce((a, l) => a + l.amountInr, 0)),
  };
}

@Injectable()
export class BillingService {
  constructor(
    private readonly usage: UsageService,
    @InjectModel(Tenant.name) private readonly tenantModel: Model<TenantDocument>,
    @InjectModel(Campaign.name) private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(CreditEntry.name) private readonly creditModel: Model<CreditEntryDocument>,
    @InjectModel(Invoice.name) private readonly invoiceModel: Model<InvoiceDocument>,
    @InjectModel(PlatformSettings.name) private readonly settingsModel: Model<PlatformSettingsDocument>,
  ) {}

  private async tenant(tenantId: string) {
    if (!Types.ObjectId.isValid(tenantId)) throw new NotFoundException('Tenant not found');
    const t = await this.tenantModel.findById(tenantId).lean().exec();
    if (!t) throw new NotFoundException('Tenant not found');
    return t;
  }

  async billingFor(tenantId: string): Promise<{ billing: TenantBilling; billingSet: boolean }> {
    const t = await this.tenant(tenantId);
    return { billing: normaliseBilling(t.billing), billingSet: Boolean(t.billing) };
  }

  async seller(): Promise<SellerDetails> {
    const doc = await this.settingsModel.findOne({ key: 'default' }).lean().exec();
    return { ...DEFAULT_SELLER, ...(doc?.seller ?? {}) };
  }

  async updateSeller(patch: SellerDetails): Promise<SellerDetails> {
    const next = { ...(await this.seller()), ...patch };
    await this.settingsModel.updateOne({ key: 'default' }, { $set: { seller: next } }, { upsert: true }).exec();
    return next;
  }

  // ── Credit ledger ──────────────────────────────────────────────────────

  async balance(tenantId: string): Promise<number> {
    const [row] = await this.creditModel
      .aggregate<{ total: number }>([
        { $match: { tenantId: new Types.ObjectId(tenantId) } },
        { $group: { _id: null, total: { $sum: '$amountInr' } } },
      ])
      .exec();
    return round2(row?.total ?? 0);
  }

  async ledger(tenantId: string, limit = 50) {
    const entries = await this.creditModel
      .find({ tenantId: new Types.ObjectId(tenantId) })
      .sort({ at: -1, createdAt: -1 })
      .limit(limit)
      .lean()
      .exec();
    return entries.map((e) => ({
      id: e._id.toString(),
      kind: e.kind,
      amountInr: e.amountInr,
      at: e.at,
      period: e.period ?? null,
      invoiceId: e.invoiceId?.toString() ?? null,
      note: e.note ?? null,
      createdBy: e.createdBy ?? null,
    }));
  }

  private async addEntry(
    tenantId: string,
    kind: CreditKind,
    amountInr: number,
    extra: { at?: Date; period?: string; invoiceId?: Types.ObjectId; note?: string; createdBy?: string } = {},
  ) {
    if (!amountInr) return null;
    return this.creditModel.create({
      tenantId: new Types.ObjectId(tenantId),
      kind,
      amountInr: round2(amountInr),
      at: extra.at ?? new Date(),
      period: extra.period,
      invoiceId: extra.invoiceId,
      note: extra.note,
      createdBy: extra.createdBy,
    });
  }

  async recordAdvance(tenantId: string, amountInr: number, opts: { receivedAt?: Date; reference?: string; by: string }) {
    await this.tenant(tenantId);
    if (!(amountInr > 0)) throw new BadRequestException('Advance must be more than ₹0');
    const at = opts.receivedAt ?? new Date();
    await this.addEntry(tenantId, 'ADVANCE', amountInr, {
      at,
      period: currentPeriod(at),
      note: opts.reference,
      createdBy: opts.by,
    });
    return { balanceInr: await this.balance(tenantId) };
  }

  async recordAdjustment(tenantId: string, amountInr: number, note: string, by: string) {
    await this.tenant(tenantId);
    if (!amountInr) throw new BadRequestException('Adjustment cannot be ₹0');
    if (!note?.trim()) throw new BadRequestException('Say why (shown on the ledger)');
    await this.addEntry(tenantId, 'ADJUSTMENT', amountInr, { note: note.trim(), createdBy: by });
    return { balanceInr: await this.balance(tenantId) };
  }

  // ── Month summary (the running bill) ────────────────────────────────────

  /**
   * The month as it stands: usage, priced lines, per-campaign breakdown, and
   * what the bill would be if issued now. Used by both screens; the tenant's
   * copy never includes CoCally's costs.
   */
  async monthSummary(tenantId: string, period: string) {
    const { from, to } = monthBounds(period);
    const [{ billing, billingSet }, usageMap, byCampaignMap, balanceInr, invoice] = await Promise.all([
      this.billingFor(tenantId),
      this.usage.usage({ from, to, tenantId }),
      this.usage.usage({ from, to, tenantId, groupBy: 'campaignId' }),
      this.balance(tenantId),
      this.invoiceModel
        .findOne({ tenantId: new Types.ObjectId(tenantId), period, status: { $ne: 'VOID' } })
        .lean()
        .exec(),
    ]);
    const usage = usageMap.get(tenantId) ?? { ...EMPTY_USAGE };
    const priced = priceUsage(usage, billing);

    const campaignIds = [...byCampaignMap.keys()].filter((id) => Types.ObjectId.isValid(id));
    const campaigns = await this.campaignModel
      .find({ _id: { $in: campaignIds.map((id) => new Types.ObjectId(id)) } })
      .select('name')
      .lean()
      .exec();
    const nameOf = new Map(campaigns.map((c) => [c._id.toString(), c.name]));
    const byCampaign = [...byCampaignMap.entries()]
      .map(([id, u]) => {
        const aiMinutes = round2(u.aiSeconds / 60);
        const amountInr = round2(aiMinutes * priced.tier.aiPerMinInr + u.dials * priced.tier.perDialInr);
        return { campaignId: id, name: nameOf.get(id) ?? 'Manual / no campaign', usage: u, aiMinutes, amountInr };
      })
      .sort((a, b) => b.amountInr - a.amountInr);

    // What issuing now would do (an issued invoice has already drawn the advance).
    const pendingIssue = !invoice || invoice.status === 'DRAFT';
    const advanceAppliedInr = pendingIssue ? round2(Math.max(0, Math.min(balanceInr, priced.subtotalInr))) : invoice.advanceAppliedInr;
    const taxableInr = round2(priced.subtotalInr - advanceAppliedInr);
    const gstInr = round2((taxableInr * billing.gstPercent) / 100);

    const nextTier = billing.tiers[priced.tierIndex + 1];
    return {
      period,
      from: from.toISOString(),
      to: to.toISOString(),
      billing,
      billingSet,
      usage,
      tier: { index: priced.tierIndex, label: priced.tierLabel, ...priced.tier },
      nextTier: nextTier
        ? { label: TIER_NAMES[priced.tierIndex + 1] ?? `Band ${priced.tierIndex + 2}`, ...nextTier, minutesToGo: round2(nextTier.fromMinutes - priced.aiMinutes) }
        : null,
      lines: priced.lines,
      subtotalInr: priced.subtotalInr,
      creditBalanceInr: balanceInr,
      advanceAppliedInr,
      taxableInr,
      gstInr,
      totalInr: round2(taxableInr + gstInr),
      byCampaign,
      invoice: invoice ? this.invoiceView(invoice) : null,
    };
  }

  // ── Invoices ───────────────────────────────────────────────────────────

  invoiceView(inv: Invoice & { _id: Types.ObjectId; createdAt?: Date }) {
    return {
      id: inv._id.toString(),
      tenantId: inv.tenantId.toString(),
      period: inv.period,
      status: inv.status,
      number: inv.number ?? null,
      lines: inv.lines,
      tierLabel: inv.tierLabel ?? null,
      subtotalInr: inv.subtotalInr,
      advanceAppliedInr: inv.advanceAppliedInr,
      taxableInr: inv.taxableInr,
      gstPercent: inv.gstPercent,
      gstInr: inv.gstInr,
      totalInr: inv.totalInr,
      usage: inv.usage,
      billTo: inv.billTo,
      seller: inv.seller,
      issuedAt: inv.issuedAt ?? null,
      dueAt: inv.dueAt ?? null,
      paidAt: inv.paidAt ?? null,
      paymentReference: inv.paymentReference ?? null,
      notes: inv.notes ?? null,
      createdAt: inv.createdAt ?? null,
    };
  }

  async listInvoices(tenantId: string, opts: { includeDrafts: boolean }) {
    const invoices = await this.invoiceModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        ...(opts.includeDrafts ? {} : { status: { $in: ['ISSUED', 'PAID'] } }),
      })
      .sort({ period: -1, createdAt: -1 })
      .lean()
      .exec();
    return invoices.map((i) => this.invoiceView(i));
  }

  /** Invoices across tenants for the ops console, newest first, with the tenant's name. */
  async listAllInvoices(opts: { status?: string; tenantId?: string; overdueOnly?: boolean } = {}) {
    const q: Record<string, unknown> = {};
    if (opts.status) q.status = opts.status;
    if (opts.tenantId) q.tenantId = new Types.ObjectId(opts.tenantId);
    if (opts.overdueOnly) {
      q.status = 'ISSUED';
      q.dueAt = { $lt: new Date() };
    }
    const invoices = await this.invoiceModel.find(q).sort({ period: -1, createdAt: -1 }).limit(500).lean().exec();
    const tenants = await this.tenantModel
      .find({ _id: { $in: [...new Set(invoices.map((i) => i.tenantId.toString()))].map((id) => new Types.ObjectId(id)) } })
      .select('name')
      .lean()
      .exec();
    const nameOf = new Map(tenants.map((t) => [t._id.toString(), t.name]));
    const now = Date.now();
    return invoices.map((i) => ({
      ...this.invoiceView(i),
      tenantName: nameOf.get(i.tenantId.toString()) ?? '—',
      overdue: i.status === 'ISSUED' && Boolean(i.dueAt) && i.dueAt!.getTime() < now,
    }));
  }

  async getInvoice(id: string, tenantId?: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Invoice not found');
    const inv = await this.invoiceModel.findById(id).lean().exec();
    if (!inv || (tenantId && inv.tenantId.toString() !== tenantId)) throw new NotFoundException('Invoice not found');
    // Tenants only ever see what was sent to them.
    if (tenantId && !['ISSUED', 'PAID'].includes(inv.status)) throw new NotFoundException('Invoice not found');
    return this.invoiceView(inv);
  }

  /** Create or refresh the month's draft from its calls. Issued invoices are frozen. */
  async generateDraft(tenantId: string, period: string) {
    const t = await this.tenant(tenantId);
    const summary = await this.monthSummary(tenantId, period);
    if (summary.invoice && summary.invoice.status !== 'DRAFT') {
      throw new BadRequestException(`${period} is already ${summary.invoice.status.toLowerCase()} — void it first to rebuild`);
    }
    const billing = summary.billing;
    const doc = {
      tenantId: new Types.ObjectId(tenantId),
      period,
      status: 'DRAFT' as const,
      lines: summary.lines,
      tierLabel: summary.tier.label,
      subtotalInr: summary.subtotalInr,
      advanceAppliedInr: summary.advanceAppliedInr,
      taxableInr: summary.taxableInr,
      gstPercent: billing.gstPercent,
      gstInr: summary.gstInr,
      totalInr: summary.totalInr,
      usage: { ...summary.usage, aiMinutes: round2(summary.usage.aiSeconds / 60) },
      billTo: { name: t.name, ...(billing.billTo ?? {}) },
      seller: { ...(await this.seller()) },
    };
    const inv = await this.invoiceModel
      .findOneAndUpdate({ tenantId: doc.tenantId, period, status: 'DRAFT' }, { $set: doc }, { upsert: true, new: true })
      .lean()
      .exec();
    return this.invoiceView(inv!);
  }

  private async nextNumber(at: Date): Promise<string> {
    const year = String(new Date(at.getTime() + IST_OFFSET_MS).getUTCFullYear());
    const doc = await this.settingsModel
      .findOneAndUpdate({ key: 'default' }, { $inc: { [`invoiceSeq.${year}`]: 1 } }, { upsert: true, new: true })
      .lean()
      .exec();
    const n = doc?.invoiceSeq?.[year] ?? 1;
    return `CC-${year}-${String(n).padStart(4, '0')}`;
  }

  /**
   * Freeze, number and send. The advance is drawn down at the balance as it
   * is NOW (the draft's figure may be stale), and under the MONTHLY rule the
   * unused rest of the credit expires with the month.
   */
  async issue(id: string, by: string, opts: { dueDays?: number; notes?: string } = {}) {
    const inv = await this.invoiceModel.findById(id).exec();
    if (!inv) throw new NotFoundException('Invoice not found');
    if (inv.status !== 'DRAFT') throw new BadRequestException(`Invoice is ${inv.status.toLowerCase()}, not a draft`);
    const tenantId = inv.tenantId.toString();
    const { billing } = await this.billingFor(tenantId);

    const balance = await this.balance(tenantId);
    const applied = round2(Math.max(0, Math.min(balance, inv.subtotalInr)));
    inv.advanceAppliedInr = applied;
    inv.taxableInr = round2(inv.subtotalInr - applied);
    inv.gstInr = round2((inv.taxableInr * inv.gstPercent) / 100);
    inv.totalInr = round2(inv.taxableInr + inv.gstInr);

    const now = new Date();
    inv.number = await this.nextNumber(now);
    inv.issuedAt = now;
    inv.dueAt = new Date(now.getTime() + (opts.dueDays ?? 7) * 86_400_000);
    if (opts.notes !== undefined) inv.notes = opts.notes;
    inv.status = inv.totalInr === 0 ? 'PAID' : 'ISSUED';
    if (inv.status === 'PAID') {
      inv.paidAt = now;
      inv.paymentReference = 'Covered by advance';
    }
    await inv.save();

    await this.addEntry(tenantId, 'USAGE', -applied, {
      period: inv.period,
      invoiceId: inv._id,
      note: `Invoice ${inv.number}`,
      createdBy: by,
    });
    if (billing.advanceRule === 'MONTHLY') {
      const left = round2(balance - applied);
      if (left > 0) {
        await this.addEntry(tenantId, 'EXPIRY', -left, {
          period: inv.period,
          invoiceId: inv._id,
          note: `Unused ${inv.period} advance (monthly rule)`,
          createdBy: by,
        });
      }
    }
    return this.invoiceView(inv.toObject());
  }

  async markPaid(id: string, opts: { paidAt?: Date; reference?: string }) {
    const inv = await this.invoiceModel.findById(id).exec();
    if (!inv) throw new NotFoundException('Invoice not found');
    if (inv.status !== 'ISSUED') throw new BadRequestException(`Only an issued invoice can be marked paid (this one is ${inv.status.toLowerCase()})`);
    inv.status = 'PAID';
    inv.paidAt = opts.paidAt ?? new Date();
    inv.paymentReference = opts.reference?.trim() || undefined;
    await inv.save();
    return this.invoiceView(inv.toObject());
  }

  /** Cancel a draft or issued invoice; any credit it used goes back. The number is not reused. */
  async void(id: string, by: string, reason: string) {
    const inv = await this.invoiceModel.findById(id).exec();
    if (!inv) throw new NotFoundException('Invoice not found');
    if (inv.status === 'VOID') return this.invoiceView(inv.toObject());
    if (inv.status === 'DRAFT') {
      await inv.deleteOne();
      return { ...this.invoiceView(inv.toObject()), status: 'VOID' as const };
    }
    const used = await this.creditModel.find({ invoiceId: inv._id, kind: { $in: ['USAGE', 'EXPIRY'] } }).lean().exec();
    const restore = round2(-used.reduce((a, e) => a + e.amountInr, 0));
    await this.addEntry(inv.tenantId.toString(), 'REVERSAL', restore, {
      period: inv.period,
      invoiceId: inv._id,
      note: `Voided ${inv.number ?? 'invoice'}: ${reason || 'no reason given'}`,
      createdBy: by,
    });
    inv.status = 'VOID';
    inv.notes = [inv.notes, `Voided: ${reason || 'no reason given'}`].filter(Boolean).join(' · ');
    await inv.save();
    return this.invoiceView(inv.toObject());
  }
}
