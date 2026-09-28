'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { fmtDateTime } from '@/components/ops/ui';
import { opsApi, opsError } from '@/lib/ops-api';

interface AuditRow {
  id: string;
  at: string;
  operatorEmail: string;
  action: string;
  tenantId: string | null;
  entityType: string | null;
  entityId: string | null;
  after: Record<string, unknown> | null;
  ip: string | null;
}

/** Everything done in the ops console, by whom, to which tenant. */
export default function OpsAuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [tenants, setTenants] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState('');

  useEffect(() => {
    opsApi
      .get<AuditRow[]>('/audit')
      .then((r) => setRows(r.data))
      .catch((err) => setError(opsError(err, 'Could not load the audit log.')));
    void opsApi.get<Array<{ id: string; name: string }>>('/tenants').then((r) => setTenants(new Map(r.data.map((t) => [t.id, t.name]))));
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Audit log</h1>
        <p className="text-sm" style={{ color: 'var(--text-dim)' }}>Operator sign-ins and every change made from this console (latest 200).</p>
      </div>
      {error && <p className="text-sm" style={{ color: 'var(--bad)' }}>{error}</p>}
      <section className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
              <th className="px-4 py-3">When</th>
              <th className="px-3 py-3">Operator</th>
              <th className="px-3 py-3">Action</th>
              <th className="px-3 py-3">Tenant</th>
              <th className="px-3 py-3">IP</th>
              <th className="px-4 py-3">Details</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t align-top" style={{ borderColor: 'var(--border)' }}>
                <td className="whitespace-nowrap px-4 py-2">{fmtDateTime(r.at)}</td>
                <td className="px-3 py-2">{r.operatorEmail}</td>
                <td className="px-3 py-2 font-mono text-xs" style={{ color: r.action.includes('failed') ? 'var(--bad)' : undefined }}>{r.action}</td>
                <td className="px-3 py-2">
                  {r.tenantId ? <Link href={`/ops/tenants/${r.tenantId}`} className="hover:underline">{tenants.get(r.tenantId) ?? r.tenantId}</Link> : '—'}
                </td>
                <td className="px-3 py-2 font-mono text-xs" style={{ color: 'var(--text-dim)' }}>{r.ip ?? ''}</td>
                <td className="max-w-md truncate px-4 py-2 font-mono text-xs" style={{ color: 'var(--text-dim)' }} title={JSON.stringify(r.after)}>
                  {r.after ? JSON.stringify(r.after) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
