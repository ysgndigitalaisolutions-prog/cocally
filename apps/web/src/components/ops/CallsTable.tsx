'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { fmtDateTime, Pill, secs } from '@/components/ops/ui';
import { inr } from '@/lib/billing';
import { opsApi, opsError } from '@/lib/ops-api';

interface CallRow {
  id: string;
  tenantId: string;
  tenantName: string;
  campaignName: string;
  leadName: string | null;
  leadPhone: string | null;
  agentName: string | null;
  kind: 'AI' | 'Manual' | 'Predictive';
  state: string;
  outcome: string | null;
  amdClass: string | null;
  disposition: string | null;
  score: number | null;
  startedAt: string;
  ringSeconds: number;
  aiSeconds: number;
  humanSeconds: number;
  recorded: boolean;
  costInr: number;
  billedInr: number;
}

const OUTCOMES = ['', 'ANSWERED_HUMAN', 'ANSWERED_VOICEMAIL', 'ANSWERED_IVR', 'NO_ANSWER', 'BUSY', 'FAILED', 'OPT_OUT', 'INVALID_NUMBER'];
const AMD = ['', 'HUMAN', 'VOICEMAIL', 'IVR', 'SILENCE'];

const pretty = (s: string | null) => (s ? s.toLowerCase().replace(/_/g, ' ') : '—');

function outcomeTone(o: string | null): 'good' | 'bad' | 'warn' | 'dim' {
  if (o === 'ANSWERED_HUMAN') return 'good';
  if (o === 'FAILED' || o === 'OPT_OUT' || o === 'INVALID_NUMBER') return 'bad';
  if (o === 'ANSWERED_VOICEMAIL' || o === 'ANSWERED_IVR') return 'warn';
  return 'dim';
}

/** Calls across tenants (or one tenant), with what each cost and was billed. */
export default function CallsTable({ tenantId, showTenant = true }: { tenantId?: string; showTenant?: boolean }) {
  const [rows, setRows] = useState<CallRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [outcome, setOutcome] = useState('');
  const [amd, setAmd] = useState('');
  const [transferred, setTransferred] = useState(false);
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const pageSize = 50;

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (tenantId) qs.set('tenantId', tenantId);
    if (from) qs.set('from', new Date(`${from}T00:00:00+05:30`).toISOString());
    if (to) qs.set('to', new Date(`${to}T23:59:59+05:30`).toISOString());
    if (outcome) qs.set('outcome', outcome);
    if (amd) qs.set('amdClass', amd);
    if (transferred) qs.set('transferred', 'true');
    if (phone.replace(/\D/g, '').length >= 4) qs.set('phone', phone);
    qs.set('page', String(page));
    try {
      const r = await opsApi.get<{ total: number; rows: CallRow[] }>(`/calls?${qs.toString()}`);
      setRows(r.data.rows);
      setTotal(r.data.total);
      setError('');
    } catch (err) {
      setError(opsError(err, 'Could not load calls.'));
    }
  }, [tenantId, from, to, outcome, amd, transferred, phone, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const reset = () => setPage(1);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs" style={{ color: 'var(--text-dim)' }}>
          From
          <input type="date" className="input mt-1" value={from} onChange={(e) => { setFrom(e.target.value); reset(); }} />
        </label>
        <label className="text-xs" style={{ color: 'var(--text-dim)' }}>
          To
          <input type="date" className="input mt-1" value={to} onChange={(e) => { setTo(e.target.value); reset(); }} />
        </label>
        <label className="text-xs" style={{ color: 'var(--text-dim)' }}>
          Outcome
          <select className="input mt-1" value={outcome} onChange={(e) => { setOutcome(e.target.value); reset(); }}>
            {OUTCOMES.map((o) => (
              <option key={o} value={o}>{o ? pretty(o) : 'Any'}</option>
            ))}
          </select>
        </label>
        <label className="text-xs" style={{ color: 'var(--text-dim)' }}>
          Answered by
          <select className="input mt-1" value={amd} onChange={(e) => { setAmd(e.target.value); reset(); }}>
            {AMD.map((o) => (
              <option key={o} value={o}>{o ? pretty(o) : 'Any'}</option>
            ))}
          </select>
        </label>
        <label className="text-xs" style={{ color: 'var(--text-dim)' }}>
          Customer phone
          <input className="input mt-1 w-40" placeholder="last digits" value={phone} onChange={(e) => { setPhone(e.target.value); reset(); }} />
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" checked={transferred} onChange={(e) => { setTransferred(e.target.checked); reset(); }} /> Transferred only
        </label>
      </div>

      {error && <p className="text-sm" style={{ color: 'var(--bad)' }}>{error}</p>}

      <section className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
              <th className="px-4 py-3">When</th>
              {showTenant && <th className="px-3 py-3">Tenant</th>}
              <th className="px-3 py-3">Customer</th>
              <th className="px-3 py-3">Campaign</th>
              <th className="px-3 py-3">Type</th>
              <th className="px-3 py-3">Outcome</th>
              <th className="px-3 py-3 text-right">Ring</th>
              <th className="px-3 py-3 text-right">AI</th>
              <th className="px-3 py-3 text-right">Agent</th>
              <th className="px-3 py-3 text-right">Score</th>
              <th className="px-3 py-3 text-right">Our cost</th>
              <th className="px-4 py-3 text-right">Billed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                <td className="whitespace-nowrap px-4 py-2">
                  <Link href={`/ops/calls/${c.id}`} className="hover:underline">{fmtDateTime(c.startedAt)}</Link>
                </td>
                {showTenant && <td className="px-3 py-2">{c.tenantName}</td>}
                <td className="px-3 py-2">
                  {c.leadName ?? '—'}
                  <span className="block font-mono text-xs" style={{ color: 'var(--text-dim)' }}>{c.leadPhone}</span>
                </td>
                <td className="px-3 py-2">{c.campaignName}</td>
                <td className="px-3 py-2">{c.kind}{c.agentName ? ` · ${c.agentName}` : ''}</td>
                <td className="px-3 py-2">
                  <Pill text={pretty(c.outcome ?? c.state)} tone={outcomeTone(c.outcome)} />
                  {c.amdClass && c.amdClass !== 'HUMAN' && (
                    <span className="ml-1 text-xs" style={{ color: 'var(--text-dim)' }}>{pretty(c.amdClass)}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{secs(c.ringSeconds)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{secs(c.aiSeconds)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{secs(c.humanSeconds)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{c.score ?? '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{inr(c.costInr)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{inr(c.billedInr)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={showTenant ? 12 : 11} className="px-4 py-6 text-center" style={{ color: 'var(--text-dim)' }}>No calls match.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <div className="flex items-center justify-between text-sm" style={{ color: 'var(--text-dim)' }}>
        <span>{total.toLocaleString('en-IN')} calls</span>
        <span className="flex items-center gap-2">
          <button className="btn btn-ghost text-xs" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          Page {page} of {pages}
          <button className="btn btn-ghost text-xs" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
        </span>
      </div>
    </div>
  );
}
