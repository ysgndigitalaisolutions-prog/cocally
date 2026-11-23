/**
 * The contract's pricing, kept free of the database so it can be tested on its own.
 */
import type { InvoiceLine } from '../../schemas/billing.schema';
import type { BillingTier, TenantBilling } from '../../schemas/tenant.schema';
import type { TenantUsage } from './usage.service';

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

export const TIER_NAMES = ['Standard', 'Growth', 'Scale', 'Enterprise'];

const round2 = (n: number) => Math.round(n * 100) / 100;

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
  const aiMinutes = round2(u.billableAiSeconds / 60);
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
