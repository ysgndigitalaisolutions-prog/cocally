'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface Kpis {
  dials: number;
  connects: number;
  connectRate: number;
  transfers: number;
  bookings: number;
  qualifyToBook: number;
  costPerBookingCents: number | null;
  avgHandleTimeMs: number;
  avgQaScore: number | null;
}

interface Funnel {
  [k: string]: number;
}

interface Campaign {
  _id: string;
  name: string;
  status: string;
}

const FUNNEL_STAGES = ['fresh', 'attempted', 'contacted', 'qualified', 'transferred', 'booked'] as const;

export default function DashboardPage() {
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [funnel, setFunnel] = useState<Funnel | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignId, setCampaignId] = useState('');
  const [objections, setObjections] = useState<Array<{ objection: string; frequency: number; rebuttalWinRate: number }>>([]);

  const load = useCallback(async () => {
    const query = campaignId ? `?campaignId=${campaignId}` : '';
    const [kpiRes, funnelRes, objRes] = await Promise.all([
      api.get(`/analytics/kpis${query}`),
      api.get(`/analytics/funnel${query}`),
      api.get(`/analytics/objections${query}`),
    ]);
    setKpis(kpiRes.data);
    setFunnel(funnelRes.data);
    setObjections(objRes.data);
  }, [campaignId]);

  useEffect(() => {
    api.get('/campaigns').then((r) => setCampaigns(r.data));
  }, []);

  useEffect(() => {
    load().catch(() => undefined);
    const timer = setInterval(() => load().catch(() => undefined), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const maxFunnel = funnel ? Math.max(...FUNNEL_STAGES.map((s) => funnel[s] ?? 0), 1) : 1;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <select className="input max-w-xs" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
          <option value="">All campaigns</option>
          {campaigns.map((c) => (
            <option key={c._id} value={c._id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Dials" value={kpis?.dials ?? '—'} />
        <Stat label="Connect rate" value={kpis ? `${Math.round(kpis.connectRate * 100)}%` : '—'} />
        <Stat label="Transfers" value={kpis?.transfers ?? '—'} />
        <Stat label="Bookings" value={kpis?.bookings ?? '—'} accent />
        <Stat
          label="Cost / booking"
          value={kpis?.costPerBookingCents != null ? `$${(kpis.costPerBookingCents / 100).toFixed(2)}` : '—'}
        />
        <Stat label="Avg QA score" value={kpis?.avgQaScore != null ? Math.round(kpis.avgQaScore) : '—'} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card p-6">
          <h2 className="mb-4 font-semibold">Funnel</h2>
          <div className="space-y-2">
            {FUNNEL_STAGES.map((stage) => (
              <div key={stage} className="flex items-center gap-3">
                <span className="w-24 text-sm capitalize" style={{ color: 'var(--text-dim)' }}>
                  {stage}
                </span>
                <div className="h-6 flex-1 overflow-hidden rounded" style={{ background: 'var(--surface-2)' }}>
                  <div
                    className="h-full rounded"
                    style={{
                      width: `${((funnel?.[stage] ?? 0) / maxFunnel) * 100}%`,
                      background: stage === 'booked' ? 'var(--good)' : 'var(--accent)',
                      minWidth: (funnel?.[stage] ?? 0) > 0 ? '2rem' : 0,
                    }}
                  />
                </div>
                <span className="w-10 text-right text-sm font-semibold">{funnel?.[stage] ?? 0}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="card p-6">
          <h2 className="mb-4 font-semibold">Objection intelligence</h2>
          {objections.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
              No objections recorded yet.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left" style={{ color: 'var(--text-dim)' }}>
                  <th className="pb-2">Objection</th>
                  <th className="pb-2">Frequency</th>
                  <th className="pb-2">Rebuttal win rate</th>
                </tr>
              </thead>
              <tbody>
                {objections.map((o) => (
                  <tr key={o.objection} className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td className="py-2">{o.objection}</td>
                    <td className="py-2">{o.frequency}</td>
                    <td className="py-2">{Math.round(o.rebuttalWinRate * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className="card p-4">
      <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
        {label}
      </p>
      <p className="mt-1 text-2xl font-bold" style={accent ? { color: 'var(--good)' } : undefined}>
        {value}
      </p>
    </div>
  );
}
