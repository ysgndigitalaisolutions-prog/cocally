'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface AuditRow {
  _id: string;
  createdAt: string;
  actorLabel: string;
  action: string;
  entityType: string;
  entityId?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

export default function AuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);

  useEffect(() => {
    api
      .get('/audit')
      .then((r) => setRows(r.data))
      .catch(() => undefined);
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Audit log</h1>
      <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
        Immutable record of every configuration change: actor, before/after, timestamp (ADM-02).
      </p>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left" style={{ color: 'var(--text-dim)' }}>
              <th className="p-3">When</th>
              <th className="p-3">Actor</th>
              <th className="p-3">Action</th>
              <th className="p-3">Entity</th>
              <th className="p-3">Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row._id} className="border-t align-top" style={{ borderColor: 'var(--border)' }}>
                <td className="p-3 whitespace-nowrap">{new Date(row.createdAt).toLocaleString()}</td>
                <td className="p-3">{row.actorLabel}</td>
                <td className="p-3 font-mono text-xs">{row.action}</td>
                <td className="p-3">{row.entityType}</td>
                <td className="p-3 font-mono text-xs" style={{ color: 'var(--text-dim)' }}>
                  {row.after ? JSON.stringify(row.after).slice(0, 120) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
