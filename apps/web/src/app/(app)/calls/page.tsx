'use client';

import { useCallback, useEffect, useState } from 'react';
import { AMD_CLASSES, CALL_OUTCOMES, DISPOSITIONS } from '@cocally/shared';
import { api } from '@/lib/api';

interface CallRow {
  _id: string;
  startedAt: string;
  state: string;
  amdClass?: string;
  outcome?: string;
  disposition?: string;
  agentId?: string;
  agentName?: string | null;
  finalScore: number;
  summary: string;
  qaScore?: { total: number; notes: string };
}

interface CallDetail extends CallRow {
  transcript: Array<{ speaker: string; text: string; leg: string }>;
  scoreHistory: Array<{ atMs: number; score: number; reason: string }>;
  complianceEvents: Array<{ atMs: number; kind: string; detail: string }>;
}

interface Campaign {
  _id: string;
  name: string;
}

interface Member {
  id: string;
  name: string;
  roles: string[];
}

// Sourced from the shared enums so the filter options can never drift from
// the values the engine actually writes.
const OUTCOMES = CALL_OUTCOMES;
const AMD = AMD_CLASSES;

/** yyyy-mm-dd for <input type="date">, in the viewer's own timezone. */
function isoDate(d: Date): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

const EMPTY = { campaignId: '', agentId: '', outcome: '', disposition: '', amdClass: '', from: '', to: '' };

export default function CallsPage() {
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [agents, setAgents] = useState<Member[]>([]);
  const [filters, setFilters] = useState({ ...EMPTY });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    Promise.all([api.get('/campaigns'), api.get('/users')])
      .then(([c, u]) => {
        setCampaigns(c.data);
        setAgents((u.data as Member[]).filter((m) => m.roles.includes('AGENT') || m.roles.includes('SUPERVISOR')));
      })
      .catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== ''));
      const { data } = await api.get('/calls', { params: { ...params, limit: 200 } });
      setCalls(data);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  async function openDetail(id: string) {
    const { data } = await api.get(`/calls/${id}`);
    setDetail(data);
  }

  function set(key: keyof typeof EMPTY, value: string) {
    setFilters((f) => ({ ...f, [key]: value }));
  }

  function quickRange(days: number) {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - days);
    setFilters((f) => ({ ...f, from: isoDate(from), to: isoDate(to) }));
  }

  const activeCount = Object.values(filters).filter(Boolean).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Calls</h1>
        <span className="text-sm" style={{ color: 'var(--text-dim)' }}>
          {loading ? 'Loading…' : `${calls.length} call${calls.length === 1 ? '' : 's'}`}
          {activeCount > 0 && ` · ${activeCount} filter${activeCount === 1 ? '' : 's'} active`}
        </span>
      </div>

      <section className="card space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
          <div>
            <label className="mb-1 block text-xs" style={{ color: 'var(--text-dim)' }}>Campaign</label>
            <select className="input" value={filters.campaignId} onChange={(e) => set('campaignId', e.target.value)}>
              <option value="">All campaigns</option>
              {campaigns.map((c) => (
                <option key={c._id} value={c._id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs" style={{ color: 'var(--text-dim)' }}>Agent</label>
            <select className="input" value={filters.agentId} onChange={(e) => set('agentId', e.target.value)}>
              <option value="">All agents</option>
              <option value="unassigned">AI only (no agent)</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs" style={{ color: 'var(--text-dim)' }}>Outcome</label>
            <select className="input" value={filters.outcome} onChange={(e) => set('outcome', e.target.value)}>
              <option value="">Any outcome</option>
              {OUTCOMES.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs" style={{ color: 'var(--text-dim)' }}>Disposition</label>
            <select className="input" value={filters.disposition} onChange={(e) => set('disposition', e.target.value)}>
              <option value="">Any disposition</option>
              {DISPOSITIONS.map((d) => (
                <option key={d} value={d}>{d.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs" style={{ color: 'var(--text-dim)' }}>Answered by</label>
            <select className="input" value={filters.amdClass} onChange={(e) => set('amdClass', e.target.value)}>
              <option value="">Any</option>
              {AMD.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-2 sm:col-span-2 md:col-span-3 xl:col-span-1">
            <div className="flex-1">
              <label className="mb-1 block text-xs" style={{ color: 'var(--text-dim)' }}>From</label>
              <input type="date" className="input" value={filters.from} onChange={(e) => set('from', e.target.value)} />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs" style={{ color: 'var(--text-dim)' }}>To</label>
              <input type="date" className="input" value={filters.to} onChange={(e) => set('to', e.target.value)} />
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-ghost text-xs" onClick={() => quickRange(0)}>Today</button>
          <button className="btn btn-ghost text-xs" onClick={() => quickRange(7)}>Last 7 days</button>
          <button className="btn btn-ghost text-xs" onClick={() => quickRange(30)}>Last 30 days</button>
          <button className="btn btn-ghost text-xs" onClick={() => setFilters({ ...EMPTY })} disabled={activeCount === 0}>
            Clear filters
          </button>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: 'var(--text-dim)' }}>
                <th className="p-3">Started</th>
                <th className="p-3">Agent</th>
                <th className="p-3">AMD</th>
                <th className="p-3">Outcome</th>
                <th className="p-3">Disposition</th>
                <th className="p-3">Score</th>
                <th className="p-3">QA</th>
              </tr>
            </thead>
            <tbody>
              {calls.length === 0 && !loading && (
                <tr>
                  <td className="p-4 text-center" colSpan={7} style={{ color: 'var(--text-dim)' }}>
                    No calls match these filters.
                  </td>
                </tr>
              )}
              {calls.map((call) => (
                <tr
                  key={call._id}
                  onClick={() => openDetail(call._id)}
                  className="cursor-pointer border-t"
                  style={{
                    borderColor: 'var(--border)',
                    background: detail?._id === call._id ? 'var(--surface-2)' : undefined,
                  }}
                >
                  <td className="p-3">{new Date(call.startedAt).toLocaleString()}</td>
                  <td className="p-3">
                    {call.agentName ?? <span style={{ color: 'var(--text-dim)' }}>AI only</span>}
                  </td>
                  <td className="p-3">{call.amdClass ?? '—'}</td>
                  <td className="p-3">{call.outcome ?? call.state}</td>
                  <td className="p-3">{call.disposition ?? '—'}</td>
                  <td className="p-3 font-semibold">{call.finalScore}</td>
                  <td className="p-3">{call.qaScore?.total ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card p-6">
          {!detail ? (
            <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
              Select a call for the deep-dive: transcript, score-over-time, compliance events (DASH-07).
            </p>
          ) : (
            <div className="space-y-4 text-sm">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">Call deep-dive</h2>
                <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
                  {detail.agentName ? `Handled by ${detail.agentName}` : 'AI only — never bridged'}
                </span>
              </div>
              {detail.summary && (
                <p className="rounded-lg p-3" style={{ background: 'var(--surface-2)' }}>
                  {detail.summary}
                </p>
              )}
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {detail.transcript.map((line, i) => (
                  <p key={i}>
                    <span
                      style={{
                        color: line.speaker === 'ai' ? 'var(--accent)' : line.speaker === 'agent' ? 'var(--good)' : 'var(--text-dim)',
                      }}
                    >
                      [{line.leg}] {line.speaker}:
                    </span>{' '}
                    {line.text}
                  </p>
                ))}
              </div>
              <div>
                <h3 className="mb-1 font-semibold">Score over time</h3>
                {detail.scoreHistory.map((point, i) => (
                  <p key={i} style={{ color: 'var(--text-dim)' }}>
                    +{(point.atMs / 1000).toFixed(1)}s → <span style={{ color: 'var(--text)' }}>{point.score}</span> ({point.reason})
                  </p>
                ))}
              </div>
              <div>
                <h3 className="mb-1 font-semibold">Compliance events</h3>
                {detail.complianceEvents.map((event, i) => (
                  <p key={i} style={{ color: 'var(--text-dim)' }}>
                    {event.kind}: {event.detail.slice(0, 80)}
                  </p>
                ))}
              </div>
              {detail.qaScore && (
                <p>
                  <span className="font-semibold">Auto-QA:</span> {detail.qaScore.total}/100 — {detail.qaScore.notes}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
