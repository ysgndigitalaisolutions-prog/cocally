'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import BillSummary from '@/components/billing/BillSummary';
import LedgerTable from '@/components/billing/LedgerTable';
import { api } from '@/lib/api';
import {
  inr,
  monthLabel,
  recentPeriods,
  statusColor,
  STATUS_LABEL,
  type Invoice,
  type LedgerEntry,
  type MonthSummary,
} from '@/lib/billing';

/** The tenant admin's view of what CoCally charges them. */
export default function UsagePage() {
  const periods = recentPeriods(12);
  const [period, setPeriod] = useState(periods[0]!);
  const [summary, setSummary] = useState<MonthSummary | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    setSummary(null);
    api
      .get<MonthSummary>(`/billing/summary?month=${period}`)
      .then((r) => {
        setSummary(r.data);
        setError('');
      })
      .catch(() => setError('Could not load usage.'));
  }, [period]);

  useEffect(() => {
    void api.get<Invoice[]>('/billing/invoices').then((r) => setInvoices(r.data)).catch(() => undefined);
    void api
      .get<{ balanceInr: number; entries: LedgerEntry[] }>('/billing/ledger')
      .then((r) => setLedger(r.data.entries))
      .catch(() => undefined);
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Usage &amp; billing</h1>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
            What the AI did for you and what it costs. Prices exclude GST; your carrier bills calls separately.
          </p>
        </div>
        <select className="input max-w-[12rem]" value={period} onChange={(e) => setPeriod(e.target.value)}>
          {periods.map((p) => (
            <option key={p} value={p}>{monthLabel(p)}</option>
          ))}
        </select>
      </div>

      {error && <p className="text-sm" style={{ color: 'var(--bad)' }}>{error}</p>}
      {summary ? <BillSummary summary={summary} /> : !error && <p style={{ color: 'var(--text-dim)' }}>Loading…</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-5">
          <h2 className="mb-3 font-semibold">Invoices</h2>
          {invoices.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--text-dim)' }}>No invoices yet.</p>
          ) : (
            <ul className="divide-y text-sm" style={{ borderColor: 'var(--border)' }}>
              {invoices.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-3 py-2">
                  <Link href={`/usage/invoices/${i.id}`} className="font-semibold hover:underline">
                    {i.number} · {monthLabel(i.period)}
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
          )}
        </section>

        <section className="card p-5">
          <h2 className="mb-3 font-semibold">Advance history</h2>
          {ledger.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--text-dim)' }}>No advance payments recorded yet.</p>
          ) : (
            <LedgerTable entries={ledger} />
          )}
        </section>
      </div>
    </div>
  );
}
