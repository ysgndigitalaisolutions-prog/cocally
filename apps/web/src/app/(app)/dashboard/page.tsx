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

const RANGES = [
  { key: 'today', label: 'Today', days: 1 },
  { key: '7d', label: 'Last 7 days', days: 7 },
  { key: '30d', label: 'Last 30 days', days: 30 },
  { key: 'all', label: 'All time', days: 0 },
] as const;

type RangeKey = (typeof RANGES)[number]['key'];

/** Compute the `from`/`to` query fragment for a preset (empty for "all time"). */
function rangeQuery(range: RangeKey): string {
  if (range === 'all') return '';
  const to = new Date();
  const from = new Date();
  if (range === 'today') {
    from.setHours(0, 0, 0, 0);
  } else {
    const days = RANGES.find((r) => r.key === range)?.days ?? 7;
    from.setDate(from.getDate() - days);
  }
  return `&from=${from.toISOString()}&to=${to.toISOString()}`;
}

export default function DashboardPage() {
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [funnel, setFunnel] = useState<Funnel | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignId, setCampaignId] = useState('');
  const [range, setRange] = useState<RangeKey>('30d');
  const [objections, setObjections] = useState<Array<{ objection: string; frequency: number; rebuttalWinRate: number }>>([]);
  const [pacing, setPacing] = useState<{
    transfersRequested: number;
    bridged: number;
    abandoned: number;
    abandonRate: number;
  } | null>(null);
  const [overdueCallbacks, setOverdueCallbacks] = useState(0);

  const load = useCallback(async () => {
    // `from`/`to` are recomputed on each load so the window stays current while polling.
    const query = `?_=1${campaignId ? `&campaignId=${campaignId}` : ''}${rangeQuery(range)}`;
    const [kpiRes, funnelRes, objRes, pacingRes, cbRes] = await Promise.all([
      api.get(`/analytics/kpis${query}`),
      api.get(`/analytics/funnel${query}`),
      api.get(`/analytics/objections${query}`),
      api.get(`/analytics/pacing-health${query}`),
      api.get('/leads/callbacks/overdue').catch(() => ({ data: [] as unknown[] })),
    ]);
    setKpis(kpiRes.data);
    setFunnel(funnelRes.data);
    setObjections(objRes.data);
    setPacing(pacingRes.data);
    setOverdueCallbacks(Array.isArray(cbRes.data) ? cbRes.data.length : 0);
  }, [campaignId, range]);

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
        <div className="flex items-center gap-3">
          <select className="input max-w-[10rem]" value={range} onChange={(e) => setRange(e.target.value as RangeKey)}>
            {RANGES.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
          <select className="input max-w-xs" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
            <option value="">All campaigns</option>
            {campaigns.map((c) => (
              <option key={c._id} value={c._id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
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

      {/* Floor-health strip: the two exception numbers a supervisor must not miss.
          Abandon rate is the pacing-safety KPI — a connected customer who found
          nobody to talk to. Most outbound regimes cap it near 3%. */}
      {(pacing || overdueCallbacks > 0) && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {pacing && (
            <>
              <div
                className="card p-4"
                style={pacing.abandonRate > 0.03 ? { borderColor: 'var(--bad)' } : undefined}
              >
                <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                  Abandon rate
                </p>
                <p
                  className="text-2xl font-bold"
                  style={{ color: pacing.abandonRate > 0.03 ? 'var(--bad)' : 'var(--good)' }}
                >
                  {(pacing.abandonRate * 100).toFixed(1)}%
                </p>
                <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
                  {pacing.abandonRate > 0.03 ? 'Above the 3% guideline' : 'Within the 3% guideline'}
                </p>
              </div>
              <div className="card p-4">
                <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                  No closer available
                </p>
                <p className="text-2xl font-bold">{pacing.abandoned}</p>
                <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
                  of {pacing.transfersRequested} transfers requested
                </p>
              </div>
              <div className="card p-4">
                <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                  Bridged to a human
                </p>
                <p className="text-2xl font-bold">{pacing.bridged}</p>
              </div>
            </>
          )}
          <div className="card p-4" style={overdueCallbacks > 0 ? { borderColor: 'var(--bad)' } : undefined}>
            <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
              Overdue callbacks
            </p>
            <p className="text-2xl font-bold" style={overdueCallbacks > 0 ? { color: 'var(--bad)' } : undefined}>
              {overdueCallbacks}
            </p>
            <p className="text-xs" style={{ color: 'var(--text-dim)' }}>Promises past their due time</p>
          </div>
        </div>
      )}

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
