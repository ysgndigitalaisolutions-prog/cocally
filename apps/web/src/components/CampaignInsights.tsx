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
  fresh: number;
  attempted: number;
  contacted: number;
  qualified: number;
  transferred: number;
  booked: number;
}

interface Objection {
  objection: string;
  frequency: number;
  rebuttalWinRate: number;
  bookingsAtRisk: number;
}

const RANGES = [
  { key: 'today', label: 'Today', days: 0 },
  { key: '7d', label: '7 days', days: 7 },
  { key: '30d', label: '30 days', days: 30 },
  { key: 'all', label: 'All time', days: null as number | null },
];

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg p-3" style={{ background: 'var(--surface-2)' }}>
      <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>{label}</p>
      <p className="text-xl font-bold">{value}</p>
      {hint && <p className="text-xs" style={{ color: 'var(--text-dim)' }}>{hint}</p>}
    </div>
  );
}

/** Per-campaign performance: the tenant dashboard scoped to one campaign. */
export default function CampaignInsights({ campaignId }: { campaignId: string }) {
  const [range, setRange] = useState('30d');
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [funnel, setFunnel] = useState<Funnel | null>(null);
  const [objections, setObjections] = useState<Objection[]>([]);

  const load = useCallback(async () => {
    const preset = RANGES.find((r) => r.key === range);
    const params: Record<string, string> = { campaignId };
    if (preset?.days !== null && preset?.days !== undefined) {
      const from = new Date();
      if (preset.days === 0) from.setHours(0, 0, 0, 0);
      else from.setDate(from.getDate() - preset.days);
      params.from = from.toISOString();
      params.to = new Date().toISOString();
    }
    const [k, f, o] = await Promise.all([
      api.get('/analytics/kpis', { params }),
      api.get('/analytics/funnel', { params: { campaignId } }),
      api.get('/analytics/objections', { params: { campaignId } }),
    ]);
    setKpis(k.data);
    setFunnel(f.data);
    setObjections(o.data);
  }, [campaignId, range]);

  useEffect(() => {
    load().catch(() => undefined);
    const timer = setInterval(() => load().catch(() => undefined), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const funnelSteps = funnel
    ? [
        { label: 'Fresh', value: funnel.fresh },
        { label: 'Attempted', value: funnel.attempted },
        { label: 'Contacted', value: funnel.contacted },
        { label: 'Qualified', value: funnel.qualified },
        { label: 'Transferred', value: funnel.transferred },
        { label: 'Booked', value: funnel.booked },
      ]
    : [];
  const funnelMax = Math.max(...funnelSteps.map((s) => s.value), 1);

  return (
    <section className="card space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Campaign insights</h2>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className="rounded-full px-3 py-1 text-xs font-semibold"
              style={
                range === r.key
                  ? { background: 'var(--accent)', color: '#0b1220' }
                  : { background: 'var(--surface-2)', color: 'var(--text-dim)' }
              }
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Dials" value={String(kpis?.dials ?? 0)} />
        <Tile label="Connect rate" value={kpis ? pct(kpis.connectRate) : '—'} hint={`${kpis?.connects ?? 0} answered`} />
        <Tile label="Transfers" value={String(kpis?.transfers ?? 0)} hint="reached a human" />
        <Tile label="Bookings" value={String(kpis?.bookings ?? 0)} hint={kpis ? `${pct(kpis.qualifyToBook)} of connects` : undefined} />
        <Tile
          label="Cost / booking"
          value={kpis?.costPerBookingCents != null ? `$${(kpis.costPerBookingCents / 100).toFixed(2)}` : '—'}
        />
        <Tile
          label="Avg QA"
          value={kpis?.avgQaScore != null ? kpis.avgQaScore.toFixed(1) : '—'}
          hint={kpis ? `AHT ${Math.round(kpis.avgHandleTimeMs / 1000)}s` : undefined}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-semibold">Lead funnel</h3>
          <div className="space-y-1">
            {funnelSteps.map((step) => (
              <div key={step.label} className="flex items-center gap-2 text-xs">
                <span className="w-20 shrink-0" style={{ color: 'var(--text-dim)' }}>{step.label}</span>
                <div className="h-4 flex-1 overflow-hidden rounded" style={{ background: 'var(--surface-2)' }}>
                  <div
                    style={{
                      width: `${(step.value / funnelMax) * 100}%`,
                      height: '100%',
                      background: step.label === 'Booked' ? 'var(--good)' : 'var(--accent)',
                    }}
                  />
                </div>
                <span className="w-10 text-right font-semibold">{step.value}</span>
              </div>
            ))}
          </div>
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold">Objections</h3>
          {objections.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--text-dim)' }}>No objections logged for this campaign yet.</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left" style={{ color: 'var(--text-dim)' }}>
                  <th className="pb-1">Objection</th>
                  <th className="pb-1">Raised</th>
                  <th className="pb-1">Rebuttal win</th>
                  <th className="pb-1">At risk</th>
                </tr>
              </thead>
              <tbody>
                {objections.slice(0, 6).map((o) => (
                  <tr key={o.objection} className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td className="py-1">{o.objection.replace(/_/g, ' ')}</td>
                    <td className="py-1">{o.frequency}</td>
                    <td className="py-1" style={{ color: 'var(--good)' }}>
                      {o.frequency > 0 ? pct(o.rebuttalWinRate) : '—'}
                    </td>
                    <td className="py-1" style={{ color: o.bookingsAtRisk > 0 ? 'var(--bad)' : undefined }}>
                      {o.bookingsAtRisk}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  );
}
