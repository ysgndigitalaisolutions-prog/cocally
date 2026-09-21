'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface Campaign {
  _id: string;
  name: string;
}

/** Downloads a CSV via the authenticated API client (a plain <a href> can't carry the JWT bearer token). */
async function downloadCsv(path: string, params: Record<string, string | undefined>, filename: string) {
  const query = Object.fromEntries(Object.entries(params).filter(([, v]) => v));
  const res = await api.get(path, { params: query, responseType: 'blob' });
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ReportsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignId, setCampaignId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    api.get('/campaigns').then((r) => setCampaigns(r.data)).catch(() => undefined);
  }, []);

  async function run(key: string, path: string, filename: string, includeCampaign: boolean) {
    setBusy(key);
    try {
      await downloadCsv(path, { campaignId: includeCampaign ? campaignId || undefined : undefined, from, to }, filename);
    } catch {
      setMessage('Could not generate the report — try a narrower date range.');
      setTimeout(() => setMessage(''), 4000);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Reports</h1>
        <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
          CSV exports for client reporting. Filters apply to every report below.
        </p>
      </div>

      {message && <p className="text-sm" style={{ color: 'var(--bad)' }}>{message}</p>}

      <div className="card flex flex-wrap items-end gap-3 p-4">
        <div>
          <label className="mb-1 block text-xs" style={{ color: 'var(--text-dim)' }}>Campaign</label>
          <select className="input" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
            <option value="">All campaigns</option>
            {campaigns.map((c) => (
              <option key={c._id} value={c._id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs" style={{ color: 'var(--text-dim)' }}>From</label>
          <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="mb-1 block text-xs" style={{ color: 'var(--text-dim)' }}>To</label>
          <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <ReportCard
          title="Call log"
          description="Every call: outcome, disposition, agent, CLI, talk time, QA score."
          busy={busy === 'calls'}
          onRun={() => run('calls', '/reports/calls.csv', 'calls.csv', true)}
        />
        <ReportCard
          title="Lead book"
          description="Current state of every lead: score, attempts, owner, next attempt."
          busy={busy === 'leads'}
          onRun={() => run('leads', '/reports/leads.csv', 'leads.csv', true)}
        />
        <ReportCard
          title="Campaign summary"
          description="Per-campaign rollup: dials, connect rate, abandon rate, bookings, AHT."
          busy={busy === 'summary'}
          onRun={() => run('summary', '/reports/campaign-summary.csv', 'campaign-summary.csv', false)}
        />
      </div>
    </div>
  );
}

function ReportCard({
  title,
  description,
  busy,
  onRun,
}: {
  title: string;
  description: string;
  busy: boolean;
  onRun: () => void;
}) {
  return (
    <div className="card space-y-3 p-4">
      <h2 className="font-semibold">{title}</h2>
      <p className="text-xs" style={{ color: 'var(--text-dim)' }}>{description}</p>
      <button className="btn btn-primary w-full text-sm" disabled={busy} onClick={onRun}>
        {busy ? 'Generating…' : 'Download CSV'}
      </button>
    </div>
  );
}
