'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { fmtDate, fmtDateTime, tenantStatus } from '@/components/ops/ui';
import { inr, num } from '@/lib/billing';
import { opsApi, opsError } from '@/lib/ops-api';

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  region: string;
  active: boolean;
  paused: boolean;
  createdAt: string | null;
  users: number;
  lastCallAt: string | null;
  monthDials: number;
  monthAiMinutes: number;
  monthBilledInr: number;
  creditBalanceInr: number;
  voice: { provider: string } | null;
  billingSet: boolean;
}

export default function OpsTenantsPage() {
  const [rows, setRows] = useState<TenantRow[] | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    opsApi
      .get<TenantRow[]>('/tenants')
      .then((r) => setRows(r.data))
      .catch((err) => setError(opsError(err, 'Could not load tenants.')));
  }, []);

  const shown = (rows ?? []).filter((t) => !q || `${t.name} ${t.slug}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Tenants</h1>
        <div className="flex items-center gap-2">
          <input className="input max-w-xs" placeholder="Search name" value={q} onChange={(e) => setQ(e.target.value)} />
          <Link href="/ops/tenants/new" className="btn btn-primary whitespace-nowrap">New tenant</Link>
        </div>
      </div>
      {error && <p className="text-sm" style={{ color: 'var(--bad)' }}>{error}</p>}
      <section className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
              <th className="px-4 py-3">Tenant</th>
              <th className="px-3 py-3">Status</th>
              <th className="px-3 py-3">Region</th>
              <th className="px-3 py-3 text-right">Users</th>
              <th className="px-3 py-3 text-right">Dials this month</th>
              <th className="px-3 py-3 text-right">AI min this month</th>
              <th className="px-3 py-3 text-right">Bill so far</th>
              <th className="px-3 py-3 text-right">Advance left</th>
              <th className="px-3 py-3">Voice</th>
              <th className="px-3 py-3">Billing terms</th>
              <th className="px-3 py-3">Last call</th>
              <th className="px-4 py-3">Since</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => (
              <tr key={t.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                <td className="px-4 py-3">
                  <Link href={`/ops/tenants/${t.id}`} className="font-semibold hover:underline">{t.name}</Link>
                  <span className="block text-xs" style={{ color: 'var(--text-dim)' }}>{t.slug}</span>
                </td>
                <td className="px-3 py-3">{tenantStatus(t)}</td>
                <td className="px-3 py-3 uppercase">{t.region}</td>
                <td className="px-3 py-3 text-right tabular-nums">{t.users}</td>
                <td className="px-3 py-3 text-right tabular-nums">{num(t.monthDials)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{num(t.monthAiMinutes, 1)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{inr(t.monthBilledInr, 0)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{inr(t.creditBalanceInr, 0)}</td>
                <td className="px-3 py-3" style={{ color: 'var(--text-dim)' }}>{t.voice?.provider ?? 'default'}</td>
                <td className="px-3 py-3" style={{ color: t.billingSet ? 'var(--text-dim)' : 'var(--accent)' }}>{t.billingSet ? 'Set' : 'Pilot defaults'}</td>
                <td className="px-3 py-3" style={{ color: 'var(--text-dim)' }}>{fmtDateTime(t.lastCallAt)}</td>
                <td className="px-4 py-3" style={{ color: 'var(--text-dim)' }}>{fmtDate(t.createdAt)}</td>
              </tr>
            ))}
            {rows && shown.length === 0 && (
              <tr>
                <td colSpan={12} className="px-4 py-6 text-center" style={{ color: 'var(--text-dim)' }}>No tenants match.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
