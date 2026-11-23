'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import BillSummary from '@/components/billing/BillSummary';
import LedgerTable from '@/components/billing/LedgerTable';
import { api } from '@/lib/api';
import { inr, monthLabel, statusColor, STATUS_LABEL, type Invoice, type LedgerEntry, type MonthSummary } from '@/lib/billing';

/** "2026-11" for this month in India, and the five before it. */
function recentMonths(): string[] {
  const ist = new Date(Date.now() + 5.5 * 3600_000);
  const out: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/**
 * The client's own bill, at the rates in their contract: this month so far,
 * their advance, and issued invoices. Owners and admins only. It shows what
 * the client is charged and why, never CoCally's own costs.
 */
export default function BillingPage() {
  const months = recentMonths();
  const [month, setMonth] = useState(months[0]!);
  const [summary, setSummary] = useState<MonthSummary | null>(null);
  const [ledger, setLedger] = useState<{ balanceInr: number; entries: LedgerEntry[] } | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    setSummary(null);
    setError('');
    api
      .get<MonthSummary>('/billing/summary', { params: { month } })
      .then((r) => setSummary(r.data))
      .catch(() => setError('Could not load the bill. Please try again.'));
  }, [month]);

  useEffect(() => {
    api.get('/billing/ledger').then((r) => setLedger(r.data)).catch(() => undefined);
    api.get<Invoice[]>('/billing/invoices').then((r) => setInvoices(r.data)).catch(() => undefined);
  }, []);

  const tiers = summary?.billing.tiers ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Billing</h1>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
            What you are charged, at the rates in your agreement. Amounts are before GST unless marked.
          </p>
        </div>
        <select className="input" style={{ width: 'auto' }} value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
          {months.map((m) => (
            <option key={m} value={m}>
              {monthLabel(m)}
            </option>
          ))}
        </select>
      </div>

      {error && <p style={{ color: 'var(--bad)' }}>{error}</p>}
      {!summary && !error && <p style={{ color: 'var(--text-dim)' }}>Loading…</p>}
      {summary && <BillSummary summary={summary} />}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card space-y-3 p-5">
          <h2 className="font-semibold">How you are charged</h2>
          <ul className="list-disc space-y-2 pl-5 text-sm">
            <li>
              <b>AI conversation</b>, per minute, billed by the second: only while the AI is talking with a person who
              answered. The meter starts when they pick up and stops when the call ends or is passed to your agent.
            </li>
            <li>
              <b>Per dial</b>: every number dialled. It covers ringing, voicemail and answering-machine detection, phone
              menus (&quot;press 1&quot;), spam checks, and holding the line during a transfer. Voicemail and calls where
              nobody speaks are charged only this, never per minute.
            </li>
            <li>
              <b>Your agents&apos; talk time</b> after a transfer is not charged. Your phone carrier bills its own minutes.
            </li>
            <li>
              <b>Monthly advance</b>: {summary ? inr(summary.billing.monthlyAdvanceInr, 0) : '—'} at the start of each
              month, used against that month&apos;s bill
              {summary?.billing.advanceRule === 'CARRY_FORWARD' ? '; anything unused carries forward.' : '; anything unused lapses at month end.'}
            </li>
          </ul>
          {tiers.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                  <th className="pb-2">AI minutes in the month</th>
                  <th className="pb-2 text-right">Per AI minute</th>
                  <th className="pb-2 text-right">Per dial</th>
                </tr>
              </thead>
              <tbody>
                {tiers.map((t, i) => (
                  <tr
                    key={t.fromMinutes}
                    className="border-t"
                    style={{ borderColor: 'var(--border)', fontWeight: summary?.tier.index === i ? 700 : undefined }}
                  >
                    <td className="py-2">
                      {tiers[i + 1] ? `${t.fromMinutes.toLocaleString('en-IN')} – ${tiers[i + 1]!.fromMinutes.toLocaleString('en-IN')}` : `${t.fromMinutes.toLocaleString('en-IN')} and above`}
                      {summary?.tier.index === i && <span className="ml-2 text-xs" style={{ color: 'var(--accent)' }}>this month</span>}
                    </td>
                    <td className="py-2 text-right tabular-nums">{inr(t.aiPerMinInr)}</td>
                    <td className="py-2 text-right tabular-nums">{inr(t.perDialInr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
            The band is set by the month&apos;s total AI minutes and applies to all of that month&apos;s minutes and dials. GST
            {summary ? ` ${summary.billing.gstPercent}%` : ''} is added to the amount after the advance.
          </p>
        </section>

        <section className="card p-5">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="font-semibold">Advance account</h2>
            {ledger && <span className="text-sm font-semibold tabular-nums">Balance {inr(ledger.balanceInr)}</span>}
          </div>
          {ledger && ledger.entries.length > 0 ? (
            <LedgerTable entries={ledger.entries} />
          ) : (
            <p className="text-sm" style={{ color: 'var(--text-dim)' }}>No advance payments or charges recorded yet.</p>
          )}
        </section>
      </div>

      <section className="card p-5">
        <h2 className="mb-2 font-semibold">Invoices</h2>
        {invoices.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>No invoices yet. Each month&apos;s invoice appears here once it is issued.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                <th className="pb-2">Invoice</th>
                <th className="pb-2">Month</th>
                <th className="pb-2">Status</th>
                <th className="pb-2 text-right">Total (incl. GST)</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="py-2 font-mono text-xs">{inv.number ?? '—'}</td>
                  <td className="py-2">{monthLabel(inv.period)}</td>
                  <td className="py-2">
                    <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: statusColor(inv.status), color: '#0b1220' }}>
                      {STATUS_LABEL[inv.status]}
                    </span>
                  </td>
                  <td className="py-2 text-right tabular-nums">{inr(inv.totalInr)}</td>
                  <td className="py-2 text-right">
                    <Link href={`/billing/invoices/${inv.id}`} className="text-sm hover:underline" style={{ color: 'var(--accent)' }}>
                      View / download
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
