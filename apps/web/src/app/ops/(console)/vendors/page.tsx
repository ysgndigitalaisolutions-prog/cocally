'use client';

import { useCallback, useEffect, useState } from 'react';
import { opsApi, opsError } from '@/lib/ops-api';

interface Vendor {
  id: string;
  name: string;
  usedFor: string;
  status: 'OK' | 'WARN' | 'PROBLEM' | 'UNKNOWN';
  keyOk: boolean | null;
  keyDetail: string;
  balance: string;
  lastUsedAt: string | null;
  billingFailures24h: number;
  billingFailures7d: number;
  carrierFailures24h: number;
  lastFailure: string | null;
  billingUrl: string | null;
}

const STATUS: Record<Vendor['status'], { color: string; label: string }> = {
  OK: { color: 'var(--good)', label: 'OK' },
  WARN: { color: 'var(--accent)', label: 'Check' },
  PROBLEM: { color: 'var(--bad)', label: 'Problem' },
  UNKNOWN: { color: 'var(--text-dim)', label: 'Unknown' },
};

function ago(iso: string | null): string {
  if (!iso) return 'Not in 7 days';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} d ago`;
}

export default function OpsVendorsPage() {
  const [rows, setRows] = useState<Vendor[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    opsApi
      .get<Vendor[]>('/vendors')
      .then((r) => {
        setRows(r.data);
        setError('');
      })
      .catch((err) => setError(opsError(err, 'Could not load vendors.')));
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const failing = rows?.filter((v) => v.status === 'PROBLEM') ?? [];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Vendors</h1>
        <p className="text-sm text-dim">
          Every paid service calls depend on. A working key does not prove credit remains: billing failures below come from real calls.
        </p>
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      {!rows && !error && <p className="text-dim">Loading…</p>}
      {rows && (
        <p className="card px-4 py-3 text-sm font-semibold" style={{ color: failing.length ? 'var(--bad)' : 'var(--good)' }}>
          {failing.length ? `Problem: ${failing.map((v) => v.name).join(', ')}` : 'No billing failures on calls today'}
        </p>
      )}
      {rows && (
        <section className="card overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="text-left text-xs text-dim">
                <th className="px-4 py-3 font-medium">Vendor</th>
                <th className="px-3 py-3 font-medium">Status</th>
                <th className="px-3 py-3 font-medium">Key</th>
                <th className="px-3 py-3 font-medium">Worked on a call</th>
                <th className="px-3 py-3 text-right font-medium">Billing failures 24h / 7d</th>
                <th className="px-3 py-3 font-medium">Balance</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id} className="border-t border-border align-top">
                  <td className="px-4 py-3">
                    <p className="font-semibold">{v.name}</p>
                    <p className="text-xs text-dim">{v.usedFor}</p>
                    {v.lastFailure && <p className="mt-1 max-w-sm break-words text-xs text-bad">{v.lastFailure}</p>}
                    {v.carrierFailures24h > 0 && <p className="mt-1 text-xs text-accent">{v.carrierFailures24h} SIP 503 in 24h (cause not confirmed as billing)</p>}
                  </td>
                  <td className="px-3 py-3 font-semibold" style={{ color: STATUS[v.status].color }}>{STATUS[v.status].label}</td>
                  <td className="px-3 py-3">{v.keyDetail}</td>
                  <td className="px-3 py-3">{ago(v.lastUsedAt)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{v.billingFailures24h} / {v.billingFailures7d}</td>
                  <td className="px-3 py-3 text-xs text-dim">{v.balance}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    {v.billingUrl && (
                      <a href={v.billingUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">Billing</a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
