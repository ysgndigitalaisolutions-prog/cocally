'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

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
}

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

  useEffect(() => {
    api
      .get('/campaigns')
      .then((r) => {
        setCampaigns(r.data);
        if (r.data[0]) setCampaignId(r.data[0]._id);
      })
      .catch(() => undefined);
  }, []);

  const loadLeads = useCallback(async () => {
    if (!campaignId) return;
    const query = stateFilter ? `?state=${stateFilter}` : '';
    const { data } = await api.get(`/leads/campaign/${campaignId}${query}`);
    setLeads(data);
  }, [campaignId, stateFilter]);

  useEffect(() => {
    loadLeads().catch(() => undefined);
  }, [loadLeads]);

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

  const counts = leads.reduce<Record<string, number>>((acc, lead) => {
    acc[lead.state_] = (acc[lead.state_] ?? 0) + 1;
    return acc;
  }, {});

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

      {/* State summary chips double as filters */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setStateFilter('')}
          className="rounded-full px-3 py-1 text-xs font-semibold"
          style={!stateFilter ? { background: 'var(--accent)', color: '#0b1220' } : { background: 'var(--surface-2)', color: 'var(--text-dim)' }}
        >
          All ({leads.length})
        </button>
        {Object.entries(counts).map(([state, count]) => (
          <button
            key={state}
            onClick={() => setStateFilter(stateFilter === state ? '' : state)}
            className="rounded-full px-3 py-1 text-xs font-semibold"
            style={
              stateFilter === state
                ? { background: 'var(--accent)', color: '#0b1220' }
                : { background: 'var(--surface-2)', color: STATE_COLORS[state] ?? 'var(--text-dim)' }
            }
          >
            {state} ({count})
          </button>
        ))}
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left" style={{ color: 'var(--text-dim)' }}>
              <th className="p-3">Name</th>
              <th className="p-3">Phone</th>
              <th className="p-3">Location</th>
              <th className="p-3">State</th>
              <th className="p-3">Score</th>
              <th className="p-3">Attempts</th>
              <th className="p-3">Next attempt</th>
            </tr>
          </thead>
          <tbody>
            {leads.length === 0 && (
              <tr>
                <td className="p-4 text-center" colSpan={7} style={{ color: 'var(--text-dim)' }}>
                  No leads in this campaign yet — use "+ Import leads".
                </td>
              </tr>
            )}
            {leads.map((lead) => (
              <tr key={lead._id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                <td className="p-3 font-medium">{[lead.firstName, lead.lastName].filter(Boolean).join(' ') || '—'}</td>
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
    </div>
  );
}
