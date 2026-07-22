'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { LeadDrawer } from '@/components/LeadDrawer';
import { api } from '@/lib/api';
import { useAppStore } from '@/lib/store';

interface Campaign {
  _id: string;
  name: string;
  status: string;
}

interface Lead {
  _id: string;
  phone: string;
  firstName?: string;
  lastName?: string;
  suburb?: string;
  state?: string;
  state_: string;
  score: number;
  attempts: number;
  nextAttemptAt?: string;
  ownerId?: string;
  source?: string;
  tags?: string[];
}

interface ListHealth {
  total: number;
  touched: number;
  untouched: number;
  penetration: number;
  remainingWorkable: number;
  exhausted: number;
  availableNow: number;
  hopperDry: boolean;
}

interface AgentLoad {
  agentId: string;
  name: string;
  held: number;
}

const LEAD_STATES = [
  'FRESH',
  'ATTEMPTED',
  'CONTACTED',
  'QUALIFIED',
  'TRANSFERRED',
  'BOOKED',
  'CALLBACK',
  'NURTURE',
  'EXHAUSTED',
  'DNC',
];

interface ImportReport {
  total: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  rejects: Array<{ row: number; reason: string }>;
}

const STATE_COLORS: Record<string, string> = {
  BOOKED: 'var(--good)',
  QUALIFIED: 'var(--good)',
  TRANSFERRED: 'var(--accent)',
  DNC: 'var(--bad)',
  EXHAUSTED: 'var(--bad)',
};

export default function LeadsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignId, setCampaignId] = useState('');
  const [leads, setLeads] = useState<Lead[]>([]);
  const [showImport, setShowImport] = useState(false);
  const [csv, setCsv] = useState('');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [importing, setImporting] = useState(false);
  const [stateFilter, setStateFilter] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [health, setHealth] = useState<ListHealth | null>(null);
  const [agentLoad, setAgentLoad] = useState<AgentLoad[]>([]);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');
  const [openLeadId, setOpenLeadId] = useState<string | null>(null);
  const user = useAppStore((s) => s.user);
  const canManage = Boolean(user?.roles.some((r) => ['ADMIN', 'SUPERVISOR', 'OWNER'].includes(r)));

  useEffect(() => {
    api
      .get('/campaigns')
      .then((r) => {
        setCampaigns(r.data);
        if (r.data[0]) setCampaignId(r.data[0]._id);
      })
      .catch(() => undefined);
  }, []);

  // Debounce the search box so typing doesn't fire a query per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  /** First page. Cursor pagination keeps deep pages O(page) on a 100k book. */
  const loadLeads = useCallback(async () => {
    if (!campaignId) return;
    const { data } = await api.get<{ rows: Lead[]; nextCursor: string | null }>('/leads/search', {
      params: { campaignId, state: stateFilter || undefined, q: query || undefined, limit: 50 },
    });
    setLeads(data.rows);
    setCursor(data.nextCursor);
  }, [campaignId, stateFilter, query]);

  const loadHealth = useCallback(async () => {
    if (!campaignId) return;
    const [h, load] = await Promise.all([
      api.get<ListHealth>('/analytics/list-health', { params: { campaignId } }),
      api.get<AgentLoad[]>('/leads/assignment/load').catch(() => ({ data: [] as AgentLoad[] })),
    ]);
    setHealth(h.data);
    setAgentLoad(load.data);
  }, [campaignId]);

  useEffect(() => {
    loadLeads().catch(() => undefined);
  }, [loadLeads]);

  useEffect(() => {
    loadHealth().catch(() => undefined);
  }, [loadHealth]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const { data } = await api.get<{ rows: Lead[]; nextCursor: string | null }>('/leads/search', {
        params: { campaignId, state: stateFilter || undefined, q: query || undefined, limit: 50, cursor },
      });
      setLeads((prev) => [...prev, ...data.rows]);
      setCursor(data.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  function notify(text: string) {
    setFlash(text);
    setTimeout(() => setFlash(''), 4000);
  }

  /** Recycle worked-out records back into the dialable pool. */
  async function recycle() {
    if (!campaignId) return;
    const states = ['NURTURE', 'EXHAUSTED'];
    if (!window.confirm(`Recycle ${states.join(' and ')} leads in this campaign back to FRESH?`)) return;
    setBusy(true);
    try {
      const { data } = await api.post<{ recycled: number }>('/leads/recycle', {
        campaignId,
        fromStates: states,
        resetAttempts: true,
      });
      notify(`Recycled ${data.recycled} lead(s) back into the dialable pool.`);
      await Promise.all([loadLeads(), loadHealth()]);
    } catch {
      notify('Could not recycle leads.');
    } finally {
      setBusy(false);
    }
  }

  const campaign = campaigns.find((c) => c._id === campaignId);

  async function runImport(e: React.FormEvent) {
    e.preventDefault();
    setImporting(true);
    setReport(null);
    try {
      const { data } = await api.post('/leads/import', {
        campaignId,
        filename: 'ui-upload.csv',
        csvContent: csv,
        mapping: { phone: 'phone', firstName: 'firstName', lastName: 'lastName', suburb: 'suburb', state: 'state', postcode: 'postcode' },
      });
      setReport(data);
      setCsv('');
      await loadLeads();
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Header: one clear context — which campaign's leads am I looking at */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Leads</h1>
          {campaign && (
            <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
              Campaign:{' '}
              <Link href={`/campaigns/${campaign._id}`} style={{ color: 'var(--accent)' }}>
                {campaign.name}
              </Link>{' '}
              · {campaign.status}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <select className="input w-64" value={campaignId} onChange={(e) => { setCampaignId(e.target.value); setReport(null); }}>
            {campaigns.map((c) => (
              <option key={c._id} value={c._id}>
                {c.name}
              </option>
            ))}
          </select>
          <button className="btn btn-primary text-sm" onClick={() => setShowImport(!showImport)}>
            {showImport ? 'Close import' : '+ Import leads'}
          </button>
        </div>
      </div>

      {/* Import: collapsed by default, always into THIS campaign */}
      {showImport && (
        <form onSubmit={runImport} className="card space-y-3 p-5" style={{ border: '1px solid var(--accent-dim)' }}>
          <p className="text-sm">
            Importing into <b>{campaign?.name}</b> — the campaign's lead list is managed automatically. CSV headers:
            <code className="ml-1 text-xs" style={{ color: 'var(--text-dim)' }}>phone, firstName, lastName, suburb, state, postcode</code>
          </p>
          <textarea
            className="input h-32 font-mono text-xs"
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={'phone,firstName,lastName,suburb,state\n0412 345 678,Kim,Lee,Fitzroy,VIC'}
            required
          />
          <button className="btn btn-primary" disabled={importing}>
            {importing ? 'Importing…' : `Import into ${campaign?.name ?? 'campaign'}`}
          </button>
          {report && (
            <div className="rounded-lg p-3 text-sm" style={{ background: 'var(--surface-2)' }}>
              <p>
                Total {report.total} · accepted <span style={{ color: 'var(--good)' }}>{report.accepted}</span> ·
                duplicates {report.duplicates} · rejected{' '}
                <span style={{ color: report.rejected > 0 ? 'var(--bad)' : undefined }}>{report.rejected}</span>
              </p>
              {report.rejects.slice(0, 5).map((reject) => (
                <p key={reject.row} className="text-xs" style={{ color: 'var(--text-dim)' }}>
                  row {reject.row}: {reject.reason}
                </p>
              ))}
            </div>
          )}
        </form>
      )}

      {flash && <p className="text-sm" style={{ color: 'var(--accent)' }}>{flash}</p>}

      {/* List health: the two numbers a floor manager actually decides on — how
          much of this list is worked, and how much dialable work is left. */}
      {health && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {[
            { label: 'Total leads', value: health.total.toLocaleString() },
            { label: 'Penetration', value: `${Math.round(health.penetration * 100)}%`, hint: `${health.touched.toLocaleString()} touched` },
            { label: 'Workable left', value: health.remainingWorkable.toLocaleString() },
            {
              label: 'Available now',
              value: health.availableNow.toLocaleString(),
              hint: health.hopperDry ? 'Hopper running dry' : 'Unassigned & due',
              danger: health.hopperDry,
            },
            { label: 'Exhausted / DNC', value: health.exhausted.toLocaleString() },
          ].map((tile) => (
            <div key={tile.label} className="card p-3">
              <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>{tile.label}</p>
              <p className="text-xl font-bold" style={tile.danger ? { color: 'var(--bad)' } : undefined}>{tile.value}</p>
              {tile.hint && (
                <p className="text-xs" style={{ color: tile.danger ? 'var(--bad)' : 'var(--text-dim)' }}>{tile.hint}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Who is holding work right now — surfaces a starving or hoarding seat. */}
      {agentLoad.length > 0 && (
        <div className="card p-3">
          <p className="mb-2 text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
            Assigned worklists
          </p>
          <div className="flex flex-wrap gap-2">
            {agentLoad.map((a) => (
              <span key={a.agentId} className="rounded-full px-3 py-1 text-xs" style={{ background: 'var(--surface-2)' }}>
                {a.name} · <b>{a.held}</b>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Server-side filters — page-local counts are meaningless on a 100k book. */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input max-w-xs"
          placeholder="Search name, phone or email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="input max-w-[12rem]" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
          <option value="">All states</option>
          {LEAD_STATES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <button className="btn btn-ghost text-xs" disabled={busy} onClick={recycle} title="Return worked-out leads to the dialable pool">
          ♻ Recycle worked-out
        </button>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left" style={{ color: 'var(--text-dim)' }}>
              <th className="p-3">Name</th>
              <th className="p-3">Phone</th>
              <th className="p-3">Location</th>
              <th className="p-3">State</th>
              <th className="p-3">Owner</th>
              <th className="p-3">Source</th>
              <th className="p-3">Score</th>
              <th className="p-3">Attempts</th>
              <th className="p-3">Next attempt</th>
            </tr>
          </thead>
          <tbody>
            {leads.length === 0 && (
              <tr>
                <td className="p-4 text-center" colSpan={9} style={{ color: 'var(--text-dim)' }}>
                  {query || stateFilter
                    ? 'No leads match these filters.'
                    : 'No leads in this campaign yet — use "+ Import leads".'}
                </td>
              </tr>
            )}
            {leads.map((lead) => (
              <tr
                key={lead._id}
                className="cursor-pointer border-t hover:opacity-80"
                style={{ borderColor: 'var(--border)' }}
                onClick={() => setOpenLeadId(lead._id)}
                title="Open lead"
              >
                <td className="p-3 font-medium">
                  {[lead.firstName, lead.lastName].filter(Boolean).join(' ') || '—'}
                </td>
                <td className="p-3 font-mono text-xs">{lead.phone}</td>
                <td className="p-3">{[lead.suburb, lead.state].filter(Boolean).join(', ')}</td>
                <td className="p-3">
                  <span
                    className="rounded-full px-2 py-0.5 text-xs font-semibold"
                    style={{ background: 'var(--surface-2)', color: STATE_COLORS[lead.state_] ?? 'var(--text-dim)' }}
                  >
                    {lead.state_}
                  </span>
                </td>
                <td className="p-3 text-xs">
                  {lead.ownerId ? (
                    <span style={{ color: 'var(--accent)' }}>
                      {agentLoad.find((a) => a.agentId === lead.ownerId)?.name ?? 'Assigned'}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-dim)' }}>pool</span>
                  )}
                </td>
                <td className="p-3 text-xs" style={{ color: 'var(--text-dim)' }}>{lead.source ?? '—'}</td>
                <td className="p-3 font-semibold">{lead.score}</td>
                <td className="p-3">{lead.attempts}</td>
                <td className="p-3 text-xs" style={{ color: 'var(--text-dim)' }}>
                  {lead.nextAttemptAt ? new Date(lead.nextAttemptAt).toLocaleString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {cursor && (
        <div className="flex justify-center">
          <button className="btn btn-ghost text-sm" disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? 'Loading…' : `Load more (${leads.length} shown)`}
          </button>
        </div>
      )}

      {openLeadId && (
        <LeadDrawer
          leadId={openLeadId}
          canManage={canManage}
          onClose={() => setOpenLeadId(null)}
          onChanged={() => {
            void loadLeads();
            void loadHealth();
          }}
        />
      )}
    </div>
  );
}
