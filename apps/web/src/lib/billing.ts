/** Shapes returned by /billing/* (tenant) and /platform/tenants/:id/billing (CoCally). */

export interface Usage {
  dials: number;
  answered: number;
  voicemail: number;
  transfers: number;
  manualDials: number;
  ringSeconds: number;
  aiSeconds: number;
  humanSeconds: number;
  recordedSeconds: number;
  ttsChars: number;
}

export interface BillingTier {
  fromMinutes: number;
  aiPerMinInr: number;
  perDialInr: number;
}

export interface TenantBilling {
  tiers: BillingTier[];
  monthlyAdvanceInr: number;
  advanceRule: 'CARRY_FORWARD' | 'MONTHLY';
  gstPercent: number;
  billTo?: { name?: string; address?: string; gstin?: string; email?: string };
}

export interface InvoiceLine {
  label: string;
  quantity: number;
  unit: string;
  rateInr: number;
  amountInr: number;
}

export interface Invoice {
  id: string;
  tenantId: string;
  period: string;
  status: 'DRAFT' | 'ISSUED' | 'PAID' | 'VOID';
  number: string | null;
  lines: InvoiceLine[];
  tierLabel: string | null;
  subtotalInr: number;
  advanceAppliedInr: number;
  taxableInr: number;
  gstPercent: number;
  gstInr: number;
  totalInr: number;
  usage: Record<string, number>;
  billTo: { name?: string; address?: string; gstin?: string; email?: string };
  seller: { name?: string; address?: string; gstin?: string; email?: string; phone?: string; paymentDetails?: string };
  issuedAt: string | null;
  dueAt: string | null;
  paidAt: string | null;
  paymentReference: string | null;
  notes: string | null;
}

export interface MonthSummary {
  period: string;
  billing: TenantBilling;
  billingSet: boolean;
  usage: Usage;
  tier: BillingTier & { index: number; label: string };
  nextTier: (BillingTier & { label: string; minutesToGo: number }) | null;
  lines: InvoiceLine[];
  subtotalInr: number;
  creditBalanceInr: number;
  advanceAppliedInr: number;
  taxableInr: number;
  gstInr: number;
  totalInr: number;
  byCampaign: Array<{ campaignId: string; name: string; usage: Usage; aiMinutes: number; amountInr: number }>;
  invoice: Invoice | null;
}

export interface LedgerEntry {
  id: string;
  kind: 'ADVANCE' | 'USAGE' | 'EXPIRY' | 'ADJUSTMENT' | 'REVERSAL';
  amountInr: number;
  at: string;
  period: string | null;
  invoiceId: string | null;
  note: string | null;
  createdBy: string | null;
}

export const LEDGER_LABEL: Record<LedgerEntry['kind'], string> = {
  ADVANCE: 'Advance received',
  USAGE: 'Used on invoice',
  EXPIRY: 'Unused advance expired',
  ADJUSTMENT: 'Adjustment',
  REVERSAL: 'Invoice voided — credit returned',
};

export const STATUS_LABEL: Record<Invoice['status'], string> = {
  DRAFT: 'Draft',
  ISSUED: 'Due',
  PAID: 'Paid',
  VOID: 'Void',
};

export function inr(n: number, digits = 2): string {
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function num(n: number, digits = 0): string {
  return n.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function minutes(seconds: number): string {
  return num(Math.round((seconds / 60) * 100) / 100, 2);
}

/** "2026-09" → "September 2026". */
export function monthLabel(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** This month and the previous `count - 1`, newest first (IST). */
export function recentPeriods(count = 12): string[] {
  const ist = new Date(Date.now() + 5.5 * 3600_000);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

export function statusColor(status: Invoice['status']): string {
  return status === 'PAID' ? 'var(--good)' : status === 'ISSUED' ? 'var(--accent)' : status === 'VOID' ? 'var(--bad)' : 'var(--text-dim)';
}
