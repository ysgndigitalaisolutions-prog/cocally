'use client';

import { useCallback, useEffect, useState } from 'react';
import { AMD_CLASSES, CALL_OUTCOMES, DISPOSITIONS } from '@cocally/shared';
import { api } from '@/lib/api';
import { minutes } from '@/lib/billing';

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
  campaignId: string;
  leadName?: string | null;
  leadPhone?: string | null;
  callerId?: string | null;
  ringSeconds?: number;
  aiSeconds?: number;
  humanSeconds?: number;
}

interface CallDetail extends CallRow {
  transcript: Array<{ speaker: string; text: string; leg: string }>;
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

type SortKey = 'started' | 'customer' | 'callerId' | 'campaign' | 'result' | 'agent' | 'disposition' | 'ring' | 'ai' | 'human';
/** Click a heading to sort by it, again to reverse. Numbers and dates start biggest/newest first. */
const COLUMNS: Array<{ key: SortKey; label: string; right?: boolean; firstDir: 1 | -1 }> = [
  { key: 'started', label: 'Started', firstDir: -1 },
  { key: 'customer', label: 'Customer', firstDir: 1 },
  { key: 'callerId', label: 'Caller ID', firstDir: 1 },
  { key: 'campaign', label: 'Campaign', firstDir: 1 },
  { key: 'result', label: 'Result', firstDir: 1 },
  { key: 'agent', label: 'Agent', firstDir: 1 },
  { key: 'disposition', label: 'Disposition', firstDir: 1 },
  { key: 'ring', label: 'Ring', right: true, firstDir: -1 },
  { key: 'ai', label: 'AI min', right: true, firstDir: -1 },
  { key: 'human', label: 'Human min', right: true, firstDir: -1 },
];

const EMPTY = { campaignId: '', agentId: '', outcome: '', disposition: '', amdClass: '', from: '', to: '' };

export default function CallsPage() {
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [recordingNote, setRecordingNote] = useState('');

  // Presigned playback link, fetched per call; 404 = no audio for this call.
  useEffect(() => {
    setRecordingUrl(null);
    setRecordingNote('');
    if (!detail) return;
    api
      .get(`/calls/${detail._id}/recording`)
      .then((r) => setRecordingUrl(r.data.url))
      .catch((err) => setRecordingNote(err?.response?.data?.message ?? 'No recording available for this call.'));
  }, [detail?._id]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [agents, setAgents] = useState<Member[]>([]);
  // Opens on today's calls; "Clear filters" still shows every call.
  const [filters, setFilters] = useState(() => ({ ...EMPTY, from: isoDate(new Date()), to: isoDate(new Date()) }));
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
    // The list row carries the customer and caller ID; the deep-dive route does not.
    setDetail({ ...calls.find((c) => c._id === id), ...data });
  }

  useEffect(() => {
    if (!detail) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDetail(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [detail]);

  const campaignName = (id?: string) => campaigns.find((c) => c._id === id)?.name;

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

  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'started', dir: -1 });
  const sortValue = (c: CallRow, key: SortKey): string | number => {
    switch (key) {
      case 'started': return new Date(c.startedAt).getTime();
      case 'customer': return (c.leadName || c.leadPhone || '').toLowerCase();
      case 'callerId': return c.callerId ?? '';
      case 'campaign': return (campaignName(c.campaignId) ?? '').toLowerCase();
      case 'result': return resultLabel(c).toLowerCase();
      case 'agent': return (c.agentName ?? '').toLowerCase();
      case 'disposition': return (c.disposition ?? '').toLowerCase();
      case 'ring': return c.ringSeconds ?? -1;
      case 'ai': return c.aiSeconds ?? 0;
      case 'human': return c.humanSeconds ?? 0;
    }
  };
  const sorted = [...calls].sort((a, b) => {
    const x = sortValue(a, sort.key);
    const y = sortValue(b, sort.key);
    return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
  });

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

      <CallTotals calls={calls} />

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[1040px] text-sm">
          <thead>
            <tr className="text-left text-xs" style={{ color: 'var(--text-dim)' }}>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  className={`p-3 font-medium ${c.right ? 'text-right' : ''}`}
                  aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
                >
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 hover:underline"
                    onClick={() => setSort((s) => (s.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: c.firstDir }))}
                  >
                    {c.label}
                    <span aria-hidden>{sort.key === c.key ? (sort.dir === 1 ? '▲' : '▼') : ''}</span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {calls.length === 0 && !loading && (
              <tr>
                <td className="p-4 text-center" colSpan={10} style={{ color: 'var(--text-dim)' }}>
                  No calls match these filters.
                </td>
              </tr>
            )}
            {sorted.map((call) => (
              <tr
                key={call._id}
                tabIndex={0}
                onClick={() => openDetail(call._id)}
                onKeyDown={(e) => e.key === 'Enter' && openDetail(call._id)}
                className="cursor-pointer border-t hover:bg-surface-2"
                style={{ borderColor: 'var(--border)' }}
              >
                <td className="whitespace-nowrap p-3">{new Date(call.startedAt).toLocaleString()}</td>
                <td className="p-3">
                  {call.leadName && <p className="font-medium">{call.leadName}</p>}
                  <p className="font-mono text-xs" style={{ color: 'var(--text-dim)' }}>{call.leadPhone ?? '—'}</p>
                </td>
                <td className="p-3 font-mono text-xs">{call.callerId ?? '—'}</td>
                <td className="p-3">{campaignName(call.campaignId) ?? '—'}</td>
                <td className="p-3 font-medium">{resultLabel(call)}</td>
                <td className="p-3">{call.agentName ?? <span style={{ color: 'var(--text-dim)' }}>AI only</span>}</td>
                <td className="p-3">{call.disposition ?? '—'}</td>
                <td className="p-3 text-right tabular-nums">{secs(call.ringSeconds)}</td>
                <td className="p-3 text-right tabular-nums">{minutes(call.aiSeconds ?? 0)}</td>
                <td className="p-3 text-right tabular-nums">{minutes(call.humanSeconds ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detail && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.6)' }}
          onClick={() => setDetail(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Call details"
            className="card flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b p-5" style={{ borderColor: 'var(--border)' }}>
              <div>
                <h2 className="text-lg font-bold">{detail.leadName || detail.leadPhone || 'Call'}</h2>
                <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
                  {new Date(detail.startedAt).toLocaleString()} · {resultLabel(detail)} ·{' '}
                  {detail.agentName ? `Handled by ${detail.agentName}` : 'AI only'}
                </p>
              </div>
              <button className="btn btn-ghost shrink-0 border text-sm" style={{ borderColor: 'var(--border)' }} onClick={() => setDetail(null)}>
                ✕ Close
              </button>
            </div>
            <div className="space-y-4 overflow-y-auto p-5 text-sm">
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  ['Customer', detail.leadPhone ?? '—'],
                  ['Caller ID', detail.callerId ?? '—'],
                  ['Campaign', campaignName(detail.campaignId) ?? '—'],
                  ['Disposition', detail.disposition ?? '—'],
                  ['Ring', secs(detail.ringSeconds)],
                  ['AI minutes', minutes(detail.aiSeconds ?? 0)],
                  ['Human minutes', minutes(detail.humanSeconds ?? 0)],
                  ['Score', String(detail.finalScore)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs" style={{ color: 'var(--text-dim)' }}>{label}</dt>
                    <dd className="break-words font-medium">{value}</dd>
                  </div>
                ))}
              </dl>
              {detail.summary && (
                <p className="rounded-lg p-3" style={{ background: 'var(--surface-2)' }}>
                  {detail.summary}
                </p>
              )}
              {recordingUrl ? (
                <audio controls preload="none" src={recordingUrl} className="w-full" aria-label="Call recording" />
              ) : (
                <p className="text-xs" style={{ color: 'var(--text-dim)' }}>{recordingNote}</p>
              )}
              <div>
                <h3 className="mb-2 font-semibold">Transcript</h3>
                {detail.transcript.length === 0 && <p style={{ color: 'var(--text-dim)' }}>No transcript for this call.</p>}
                <div className="space-y-1.5">
                  {detail.transcript.map((line, i) => (
                    <p key={i}>
                      <span
                        className="font-medium"
                        style={{ color: line.speaker === 'ai' ? 'var(--accent)' : line.speaker === 'agent' ? 'var(--good)' : 'var(--text)' }}
                      >
                        {line.speaker === 'ai' ? 'AI' : line.speaker === 'agent' ? 'Agent' : 'Customer'}:
                      </span>{' '}
                      {line.text}
                    </p>
                  ))}
                </div>
              </div>
              {detail.qaScore && (
                <p>
                  <span className="font-semibold">Auto-QA:</span> {detail.qaScore.total}/100 — {detail.qaScore.notes}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const RESULT_LABEL: Record<string, string> = {
  ANSWERED_HUMAN: 'Picked up',
  ANSWERED_VOICEMAIL: 'Voicemail',
  ANSWERED_IVR: 'Gate',
  NO_ANSWER: 'No answer',
  BUSY: 'Busy',
  DISCONNECTED: 'Number unreachable',
  FAILED: 'Failed',
  CALLBACK_REQUESTED: 'Callback requested',
  OPT_OUT: 'Opted out',
  ABANDONED: 'No agent free',
};

function resultLabel(call: { outcome?: string; state: string }): string {
  return call.outcome ? (RESULT_LABEL[call.outcome] ?? call.outcome) : 'In progress';
}

/** Seconds as "45s" or "1m 05s"; a dash when nothing was measured. */
function secs(s?: number): string {
  if (!s) return '—';
  const r = Math.round(s);
  return r < 60 ? `${r}s` : `${Math.floor(r / 60)}m ${String(r % 60).padStart(2, '0')}s`;
}

/** Totals for the calls on screen: calls and minutes. */
function CallTotals({ calls }: { calls: CallRow[] }) {
  if (calls.length === 0) return null;
  const sum = (f: (c: CallRow) => number | undefined) => calls.reduce((a, c) => a + (f(c) ?? 0), 0);
  const answered = calls.filter((c) => c.outcome === 'ANSWERED_HUMAN').length;
  const transferred = calls.filter((c) => Boolean(c.agentId)).length;
  const figures: Array<[string, string]> = [
    ['Calls', String(calls.length)],
    ['Answered', `${answered} (${Math.round((answered / calls.length) * 100)}%)`],
    ['Transferred', String(transferred)],
    ['Ring minutes', minutes(sum((c) => c.ringSeconds))],
    ['AI minutes', minutes(sum((c) => c.aiSeconds))],
    ['Human minutes', minutes(sum((c) => c.humanSeconds))],
  ];
  return (
    <section className="card p-4">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {figures.map(([label, value]) => (
          <div key={label}>
            <p className="text-xs" style={{ color: 'var(--text-dim)' }}>{label}</p>
            <p className="text-lg font-semibold tabular-nums">{value}</p>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs" style={{ color: 'var(--text-dim)' }}>
        Totals for the {calls.length} calls listed{calls.length >= 200 ? ' (the most recent 200; narrow the dates for more)' : ''}.
      </p>
    </section>
  );
}
