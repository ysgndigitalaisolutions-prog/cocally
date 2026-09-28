'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { fmtDate, Pill } from '@/components/ops/ui';
import { inr, monthLabel, STATUS_LABEL, type Invoice } from '@/lib/billing';
import { opsApi, opsError } from '@/lib/ops-api';

type Row = Invoice & { tenantName: string; overdue: boolean };

const FILTERS = [
  ['', 'All'],
  ['overdue', 'Overdue'],
  ['ISSUED', 'Due'],
  ['PAID', 'Paid'],
  ['DRAFT', 'Drafts'],
  ['VOID', 'Void'],
] as const;

export default function OpsInvoicesPage() {
  const [filter, setFilter] = useState<string>('');
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    const qs = filter === 'overdue' ? 'overdue=true' : filter ? `status=${filter}` : '';
    opsApi
      .get<Row[]>(`/invoices?${qs}`)
      .then((r) => setRows(r.data))
      .catch((err) => setError(opsError(err, 'Could not load invoices.')));
  }, [filter]);

  const outstanding = rows.filter((r) => r.status === 'ISSUED').reduce((a, r) => a + r.totalInr, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Invoices</h1>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
            Across all tenants. Create and issue them from each tenant&apos;s Billing tab.
            {outstanding > 0 && <> Outstanding in this view: <span className="font-semibold" style={{ color: 'var(--text)' }}>{inr(outstanding)}</span>.</>}
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          {FILTERS.map(([key, label]) => (
            <button
              key={key}
              className="btn text-sm"
              onClick={() => setFilter(key)}
              style={filter === key ? { background: 'var(--accent)', color: '#0b1220' } : { border: '1px solid var(--border)' }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="text-sm" style={{ color: 'var(--bad)' }}>{error}</p>}
      <section className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
              <th className="px-4 py-3">Invoice</th>
              <th className="px-3 py-3">Tenant</th>
              <th className="px-3 py-3">Period</th>
              <th className="px-3 py-3">Status</th>
              <th className="px-3 py-3">Issued</th>
              <th className="px-3 py-3">Due</th>
              <th className="px-3 py-3 text-right">Subtotal</th>
              <th className="px-3 py-3 text-right">From advance</th>
              <th className="px-4 py-3 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                <td className="px-4 py-2">
                  <Link href={`/ops/invoices/${i.id}`} className="font-semibold hover:underline">{i.number ?? 'Draft'}</Link>
                </td>
                <td className="px-3 py-2">
                  <Link href={`/ops/tenants/${i.tenantId}`} className="hover:underline">{i.tenantName}</Link>
                </td>
                <td className="px-3 py-2">{monthLabel(i.period)}</td>
                <td className="px-3 py-2">
                  {i.overdue ? (
                    <Pill text="Overdue" tone="bad" />
                  ) : (
                    <Pill text={STATUS_LABEL[i.status]} tone={i.status === 'PAID' ? 'good' : i.status === 'ISSUED' ? 'warn' : i.status === 'VOID' ? 'bad' : 'dim'} />
                  )}
                </td>
                <td className="px-3 py-2">{fmtDate(i.issuedAt)}</td>
                <td className="px-3 py-2">{fmtDate(i.dueAt)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{inr(i.subtotalInr)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{inr(i.advanceAppliedInr)}</td>
                <td className="px-4 py-2 text-right font-semibold tabular-nums">{inr(i.totalInr)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-6 text-center" style={{ color: 'var(--text-dim)' }}>No invoices.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
