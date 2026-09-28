'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Stat, tenantStatus, fmtDateTime } from '@/components/ops/ui';
import { inr, num } from '@/lib/billing';
import { opsApi, opsError } from '@/lib/ops-api';

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  paused: boolean;
  users: number;
  lastCallAt: string | null;
  monthDials: number;
  monthAiMinutes: number;
  monthBilledInr: number;
  creditBalanceInr: number;
}

interface CostRow {
  tenantId: string;
  costInr: number;
  billedInr: number;
  marginInr: number;
}

interface Overview {
  totals: { dials: number; aiMinutes: number; humanMinutes: number; costInr: number; billedInr: number; fixedInr: number; marginInr: number };
  rows: CostRow[];
  tenants: TenantRow[];
  alerts: Array<{ level: 'bad' | 'warn' | 'info'; tenantId?: string; text: string }>;
}

const RANGES = [
  { key: 'month', label: 'This month' },
  { key: '30d', label: 'Last 30 days' },
  { key: '7d', label: 'Last 7 days' },
  { key: 'today', label: 'Today' },
] as const;
type RangeKey = (typeof RANGES)[number]['key'];

function rangeQuery(range: RangeKey): string {
  const to = new Date();
  const from = new Date();
  if (range === 'month') from.setDate(1);
  if (range === '30d') from.setDate(from.getDate() - 30);
  if (range === '7d') from.setDate(from.getDate() - 7);
  if (range === 'month' || range === 'today') from.setHours(0, 0, 0, 0);
  return `from=${from.toISOString()}&to=${to.toISOString()}`;
}

export default function OpsOverviewPage() {
  const [range, setRange] = useState<RangeKey>('month');
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await opsApi.get<Overview>(`/overview?${rangeQuery(range)}`);
      setData(r.data);
      setError('');
    } catch (err) {
      setError(opsError(err, 'Could not load the overview.'));
    }
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);

  const cost = new Map((data?.rows ?? []).map((r) => [r.tenantId, r]));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Overview</h1>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>Every tenant, what they used, what it cost us and what we bill.</p>
        </div>
        <div className="flex items-center gap-2">
          <select className="input max-w-[11rem]" value={range} onChange={(e) => setRange(e.target.value as RangeKey)}>
            {RANGES.map((r) => (
              <option key={r.key} value={r.key}>{r.label}</option>
            ))}
          </select>
          <Link href="/ops/tenants/new" className="btn btn-primary whitespace-nowrap">New tenant</Link>
        </div>
      </div>

      {error && <p className="text-sm" style={{ color: 'var(--bad)' }}>{error}</p>}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
            <Stat label="Dials" value={num(data.totals.dials)} />
            <Stat label="AI minutes" value={num(data.totals.aiMinutes, 1)} />
            <Stat label="Agent minutes" value={num(data.totals.humanMinutes, 1)} hint="Not billed" />
            <Stat label="Our usage cost" value={inr(data.totals.costInr, 0)} />
            <Stat label="Billed (usage)" value={inr(data.totals.billedInr, 0)} hint="Before GST" />
            <Stat
              label="Margin after fixed"
              value={inr(data.totals.marginInr, 0)}
              hint={`Fixed ${inr(data.totals.fixedInr, 0)} this period`}
              tone={data.totals.marginInr >= 0 ? 'good' : 'bad'}
            />
          </div>

          {data.alerts.length > 0 && (
            <section className="card space-y-2 p-4">
              <h2 className="font-semibold">Needs attention</h2>
              <ul className="space-y-1 text-sm">
                {data.alerts.map((a, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span aria-hidden style={{ color: a.level === 'bad' ? 'var(--bad)' : a.level === 'warn' ? 'var(--accent)' : 'var(--text-dim)' }}>●</span>
                    {a.tenantId ? (
                      <Link href={`/ops/tenants/${a.tenantId}`} className="hover:underline">{a.text}</Link>
                    ) : (
                      a.text
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="card overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                  <th className="px-4 py-3">Tenant</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3 text-right">Users</th>
                  <th className="px-3 py-3 text-right">Dials (month)</th>
                  <th className="px-3 py-3 text-right">AI min (month)</th>
                  <th className="px-3 py-3 text-right">Cost (range)</th>
                  <th className="px-3 py-3 text-right">Billed (range)</th>
                  <th className="px-3 py-3 text-right">Margin</th>
                  <th className="px-3 py-3 text-right">Advance left</th>
                  <th className="px-4 py-3">Last call</th>
                </tr>
              </thead>
              <tbody>
                {data.tenants.map((t) => {
                  const c = cost.get(t.id);
                  return (
                    <tr key={t.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                      <td className="px-4 py-3">
                        <Link href={`/ops/tenants/${t.id}`} className="font-semibold hover:underline">{t.name}</Link>
                        <span className="block text-xs" style={{ color: 'var(--text-dim)' }}>{t.slug}</span>
                      </td>
                      <td className="px-3 py-3">{tenantStatus(t)}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{t.users}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{num(t.monthDials)}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{num(t.monthAiMinutes, 1)}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{inr(c?.costInr ?? 0, 0)}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{inr(c?.billedInr ?? 0, 0)}</td>
                      <td className="px-3 py-3 text-right font-semibold tabular-nums" style={{ color: (c?.marginInr ?? 0) >= 0 ? 'var(--good)' : 'var(--bad)' }}>
                        {inr(c?.marginInr ?? 0, 0)}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">{inr(t.creditBalanceInr, 0)}</td>
                      <td className="px-4 py-3" style={{ color: 'var(--text-dim)' }}>{fmtDateTime(t.lastCallAt)}</td>
                    </tr>
                  );
                })}
                {data.tenants.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-4 py-6 text-center" style={{ color: 'var(--text-dim)' }}>
                      No tenants yet — <Link href="/ops/tenants/new" className="underline">create the first one</Link>.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
