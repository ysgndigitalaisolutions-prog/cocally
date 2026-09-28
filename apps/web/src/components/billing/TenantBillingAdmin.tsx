'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import BillSummary from '@/components/billing/BillSummary';
import LedgerTable from '@/components/billing/LedgerTable';
import { api } from '@/lib/api';
import {
  inr,
  monthLabel,
  recentPeriods,
  statusColor,
  STATUS_LABEL,
  type BillingTier,
  type Invoice,
  type LedgerEntry,
  type MonthSummary,
  type TenantBilling,
} from '@/lib/billing';

interface BillingPayload {
  summary: MonthSummary;
  ledger: LedgerEntry[];
  invoices: Invoice[];
}

function errorMessage(err: unknown, fallback: string): string {
  const detail = (err as { response?: { data?: { message?: string | string[] } } }).response?.data?.message;
  if (Array.isArray(detail)) return detail.join(', ');
  return typeof detail === 'string' ? detail : fallback;
}

/** CoCally's billing desk for one tenant: the month's bill, invoices, advance and terms. */
export default function TenantBillingAdmin({ tenantId, onChanged }: { tenantId: string; onChanged: () => void }) {
  const periods = recentPeriods(12);
  const [period, setPeriod] = useState(periods[0]!);
  const [data, setData] = useState<BillingPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);

  const load = useCallback(async () => {
    const r = await api.get<BillingPayload>(`/platform/tenants/${tenantId}/billing?month=${period}`);
    setData(r.data);
  }, [tenantId, period]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setNote(null);
    try {
      await fn();
      setNote({ text: label });
      await load();
      onChanged();
    } catch (err) {
      setNote({ text: errorMessage(err, 'That did not work.'), bad: true });
    } finally {
      setBusy(false);
    }
  }

  const summary = data?.summary;
  const inv = summary?.invoice ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <select className="input max-w-[12rem]" value={period} onChange={(e) => setPeriod(e.target.value)}>
          {periods.map((p) => (
            <option key={p} value={p}>{monthLabel(p)}</option>
          ))}
        </select>
        {note && (
          <span className="text-sm" style={{ color: note.bad ? 'var(--bad)' : 'var(--good)' }}>{note.text}</span>
        )}
      </div>

      {summary && <BillSummary summary={summary} />}

      {summary && (
        <section className="card space-y-3 p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-semibold">Invoice for {monthLabel(period)}</h2>
            {inv && (
              <span className="text-sm">
                {inv.number ?? 'Draft'} ·{' '}
                <span className="font-semibold" style={{ color: statusColor(inv.status) }}>{STATUS_LABEL[inv.status]}</span>
                {inv.status !== 'DRAFT' && <> · {inr(inv.totalInr)}</>}
              </span>
            )}
          </div>
          <InvoiceActions
            tenantId={tenantId}
            period={period}
            invoice={inv}
            busy={busy}
            act={act}
          />
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card space-y-4 p-5">
          <h2 className="font-semibold">Advance &amp; credit</h2>
          {summary && (
            <MoneyForms
              tenantId={tenantId}
              defaultAdvance={summary.billing.monthlyAdvanceInr}
              busy={busy}
              act={act}
            />
          )}
          {data && data.ledger.length > 0 ? (
            <LedgerTable entries={data.ledger} />
          ) : (
            <p className="text-sm" style={{ color: 'var(--text-dim)' }}>Nothing recorded yet.</p>
          )}
        </section>

        <section className="card p-5">
          <h2 className="mb-3 font-semibold">All invoices</h2>
          {data && data.invoices.length > 0 ? (
            <ul className="divide-y text-sm" style={{ borderColor: 'var(--border)' }}>
              {data.invoices.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-3 py-2">
                  <Link href={`/platform/invoices/${i.id}`} className="font-semibold hover:underline">
                    {i.number ?? 'Draft'} · {monthLabel(i.period)}
                  </Link>
                  <span className="flex items-center gap-3">
                    <span className="tabular-nums">{inr(i.totalInr)}</span>
                    <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: statusColor(i.status), color: '#0b1220' }}>
                      {STATUS_LABEL[i.status]}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm" style={{ color: 'var(--text-dim)' }}>No invoices yet.</p>
          )}
        </section>
      </div>

      {summary && (
        <BillingTerms
          key={JSON.stringify(summary.billing)}
          tenantId={tenantId}
          billing={summary.billing}
          billingSet={summary.billingSet}
          busy={busy}
          act={act}
        />
      )}
    </div>
  );
}

type Act = (label: string, fn: () => Promise<unknown>) => Promise<void>;

function InvoiceActions({
  tenantId,
  period,
  invoice,
  busy,
  act,
}: {
  tenantId: string;
  period: string;
  invoice: Invoice | null;
  busy: boolean;
  act: Act;
}) {
  const [dueDays, setDueDays] = useState(7);
  const [invNotes, setInvNotes] = useState('');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');

  if (!invoice) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void act('Draft created from this month’s calls.', () => api.post(`/platform/tenants/${tenantId}/invoices`, { month: period }))}
        >
          Create draft invoice
        </button>
        <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
          Builds the bill from this month’s calls. Nothing is sent until you issue it.
        </p>
      </div>
    );
  }

  const view = (
    <Link href={`/platform/invoices/${invoice.id}`} className="btn btn-ghost">
      View / print
    </Link>
  );

  if (invoice.status === 'DRAFT') {
    return (
      <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-[8rem_minmax(0,1fr)]">
          <label className="block text-xs" style={{ color: 'var(--text-dim)' }}>
            Due in (days)
            <input type="number" min={0} className="input mt-1" value={dueDays} onChange={(e) => setDueDays(Number(e.target.value))} />
          </label>
          <label className="block text-xs" style={{ color: 'var(--text-dim)' }}>
            Note on the invoice (optional)
            <input className="input mt-1" value={invNotes} onChange={(e) => setInvNotes(e.target.value)} placeholder="e.g. Thank you for the pilot month" />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() =>
              void act('Invoice issued. The client can now see it on Usage & billing.', () =>
                api.post(`/platform/invoices/${invoice.id}/issue`, { dueDays, notes: invNotes || undefined }),
              )
            }
          >
            Issue invoice
          </button>
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => void act('Draft refreshed from the latest calls.', () => api.post(`/platform/tenants/${tenantId}/invoices`, { month: period }))}
          >
            Refresh draft
          </button>
          {view}
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => void act('Draft deleted.', () => api.post(`/platform/invoices/${invoice.id}/void`, { reason: 'draft discarded' }))}
          >
            Delete draft
          </button>
        </div>
        <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
          Issuing numbers the invoice, draws the advance down by up to the subtotal, and freezes it. Refresh first if more calls came in.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {invoice.status === 'ISSUED' && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="block flex-1 text-xs" style={{ color: 'var(--text-dim)' }}>
            Payment reference (UTR / cheque)
            <input className="input mt-1" value={reference} onChange={(e) => setReference(e.target.value)} />
          </label>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void act('Marked paid.', () => api.post(`/platform/invoices/${invoice.id}/paid`, { reference: reference || undefined }))}
          >
            Mark paid
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        {view}
        <label className="block flex-1 text-xs" style={{ color: 'var(--text-dim)' }}>
          Reason to void
          <input className="input mt-1" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. wrong rate" />
        </label>
        <button
          className="btn btn-danger"
          disabled={busy || !reason.trim()}
          onClick={() =>
            void act('Invoice voided; any advance it used is back on the balance.', () =>
              api.post(`/platform/invoices/${invoice.id}/void`, { reason }),
            )
          }
        >
          Void
        </button>
      </div>
    </div>
  );
}

function MoneyForms({ tenantId, defaultAdvance, busy, act }: { tenantId: string; defaultAdvance: number; busy: boolean; act: Act }) {
  const today = new Date().toISOString().slice(0, 10);
  const [amount, setAmount] = useState(defaultAdvance);
  const [date, setDate] = useState(today);
  const [ref, setRef] = useState('');
  const [adj, setAdj] = useState(0);
  const [adjNote, setAdjNote] = useState('');

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>Record advance received</p>
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="block text-xs" style={{ color: 'var(--text-dim)' }}>
            Amount ₹ (before GST)
            <input type="number" min={0} step={1000} className="input mt-1" value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
          </label>
          <label className="block text-xs" style={{ color: 'var(--text-dim)' }}>
            Received on
            <input type="date" className="input mt-1" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="block text-xs" style={{ color: 'var(--text-dim)' }}>
            Reference (UTR)
            <input className="input mt-1" value={ref} onChange={(e) => setRef(e.target.value)} />
          </label>
        </div>
        <button
          className="btn btn-primary"
          disabled={busy || !(amount > 0)}
          onClick={() =>
            void act(`Advance of ${inr(amount, 0)} recorded.`, () =>
              api.post(`/platform/tenants/${tenantId}/advances`, {
                amountInr: amount,
                at: new Date(`${date}T12:00:00+05:30`).toISOString(),
                note: ref || undefined,
              }),
            )
          }
        >
          Record advance
        </button>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>Adjustment</p>
        <div className="grid gap-2 sm:grid-cols-[8rem_minmax(0,1fr)]">
          <label className="block text-xs" style={{ color: 'var(--text-dim)' }}>
            ₹ (+ credit / − debit)
            <input type="number" step={100} className="input mt-1" value={adj} onChange={(e) => setAdj(Number(e.target.value))} />
          </label>
          <label className="block text-xs" style={{ color: 'var(--text-dim)' }}>
            Why (shown to the client)
            <input className="input mt-1" value={adjNote} onChange={(e) => setAdjNote(e.target.value)} placeholder="e.g. goodwill credit for outage on 3 Oct" />
          </label>
        </div>
        <button
          className="btn btn-ghost"
          disabled={busy || !adj || !adjNote.trim()}
          onClick={() =>
            void act('Adjustment recorded.', () => api.post(`/platform/tenants/${tenantId}/adjustments`, { amountInr: adj, note: adjNote }))
          }
        >
          Record adjustment
        </button>
      </div>
    </div>
  );
}

function BillingTerms({
  tenantId,
  billing,
  billingSet,
  busy,
  act,
}: {
  tenantId: string;
  billing: TenantBilling;
  billingSet: boolean;
  busy: boolean;
  act: Act;
}) {
  const [tiers, setTiers] = useState<BillingTier[]>(billing.tiers);
  const [advance, setAdvance] = useState(billing.monthlyAdvanceInr);
  const [rule, setRule] = useState(billing.advanceRule);
  const [gst, setGst] = useState(billing.gstPercent);
  const [billTo, setBillTo] = useState(billing.billTo ?? {});

  const setTier = (i: number, patch: Partial<BillingTier>) => setTiers(tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)));

  return (
    <details className="card p-5" open={!billingSet}>
      <summary className="cursor-pointer select-none font-semibold">
        Billing terms{!billingSet && ' — currently the pilot quote defaults; save to confirm'}
      </summary>
      <div className="mt-4 space-y-4">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
            Rate bands (the month&apos;s total AI minutes picks the band; it applies to all minutes and dials)
          </p>
          <div className="space-y-2">
            {tiers.map((t, i) => (
              <div key={i} className="grid grid-cols-[repeat(3,minmax(0,1fr))_auto] items-end gap-2">
                <label className="block text-xs" style={{ color: 'var(--text-dim)' }}>
                  From AI minutes
                  <input type="number" min={0} className="input mt-1" value={t.fromMinutes} disabled={i === 0} onChange={(e) => setTier(i, { fromMinutes: Number(e.target.value) })} />
                </label>
                <label className="block text-xs" style={{ color: 'var(--text-dim)' }}>
                  ₹ per AI minute
                  <input type="number" min={0} step={0.05} className="input mt-1" value={t.aiPerMinInr} onChange={(e) => setTier(i, { aiPerMinInr: Number(e.target.value) })} />
                </label>
                <label className="block text-xs" style={{ color: 'var(--text-dim)' }}>
                  ₹ per dial
                  <input type="number" min={0} step={0.05} className="input mt-1" value={t.perDialInr} onChange={(e) => setTier(i, { perDialInr: Number(e.target.value) })} />
                </label>
                <button className="btn btn-ghost text-xs" disabled={i === 0} onClick={() => setTiers(tiers.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </div>
            ))}
          </div>
          <button
            className="btn btn-ghost mt-2 text-xs"
            disabled={tiers.length >= 6}
            onClick={() => {
              const last = tiers[tiers.length - 1]!;
              setTiers([...tiers, { fromMinutes: last.fromMinutes + 10_000, aiPerMinInr: last.aiPerMinInr, perDialInr: last.perDialInr }]);
            }}
          >
            + Add band
          </button>
        </div>

        <div className="grid gap-2 sm:grid-cols-3">
          <label className="block text-xs" style={{ color: 'var(--text-dim)' }}>
            Monthly advance ₹
            <input type="number" min={0} step={1000} className="input mt-1" value={advance} onChange={(e) => setAdvance(Number(e.target.value))} />
          </label>
          <label className="block text-xs" style={{ color: 'var(--text-dim)' }}>
            Unused advance
            <select className="input mt-1" value={rule} onChange={(e) => setRule(e.target.value as TenantBilling['advanceRule'])}>
              <option value="CARRY_FORWARD">Carries forward</option>
              <option value="MONTHLY">Lapses at month end</option>
            </select>
          </label>
          <label className="block text-xs" style={{ color: 'var(--text-dim)' }}>
            GST %
            <input type="number" min={0} max={28} className="input mt-1" value={gst} onChange={(e) => setGst(Number(e.target.value))} />
          </label>
        </div>

        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>Bill to (printed on invoices)</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <input className="input" placeholder="Legal name" value={billTo.name ?? ''} onChange={(e) => setBillTo({ ...billTo, name: e.target.value })} />
            <input className="input" placeholder="GSTIN" value={billTo.gstin ?? ''} onChange={(e) => setBillTo({ ...billTo, gstin: e.target.value })} />
            <input className="input" placeholder="Billing email" value={billTo.email ?? ''} onChange={(e) => setBillTo({ ...billTo, email: e.target.value })} />
            <textarea className="input h-16" placeholder="Address" value={billTo.address ?? ''} onChange={(e) => setBillTo({ ...billTo, address: e.target.value })} />
          </div>
        </div>

        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() =>
            void act('Billing terms saved. They apply to drafts and the running bill from now on.', () =>
              api.patch(`/platform/tenants/${tenantId}`, {
                billing: {
                  tiers: [...tiers].sort((a, b) => a.fromMinutes - b.fromMinutes),
                  monthlyAdvanceInr: advance,
                  advanceRule: rule,
                  gstPercent: gst,
                  billTo: Object.fromEntries(Object.entries(billTo).filter(([, v]) => v && String(v).trim())),
                },
              }),
            )
          }
        >
          Save billing terms
        </button>
      </div>
    </details>
  );
}
