'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

export type RangePreset = 'today' | '7d' | 'month' | '30d' | '12m';

export interface RangeQuery {
  from: string;
  to: string;
  granularity: 'hour' | 'day' | 'month';
}

export const RANGE_PRESETS: Array<{ key: RangePreset; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: 'month', label: 'This month' },
  { key: '30d', label: '30 days' },
  { key: '12m', label: 'By month' },
];

export function rangeForPreset(preset: RangePreset): RangeQuery {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (preset) {
    case 'today':
      return { from: startOfDay.toISOString(), to: now.toISOString(), granularity: 'hour' };
    case '7d':
      return { from: new Date(now.getTime() - 7 * 86400_000).toISOString(), to: now.toISOString(), granularity: 'day' };
    case 'month':
      return {
        from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
        to: now.toISOString(),
        granularity: 'day',
      };
    case '12m':
      // Rolling 12 months bucketed per month — the month-over-month trend view.
      return {
        from: new Date(now.getFullYear() - 1, now.getMonth(), 1).toISOString(),
        to: now.toISOString(),
        granularity: 'month',
      };
    case '30d':
    default:
      return { from: new Date(now.getTime() - 30 * 86400_000).toISOString(), to: now.toISOString(), granularity: 'day' };
  }
}

export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m ${seconds % 60}s`;
  return `${h}h ${m}m`;
}

export function fmtBucket(iso: string, granularity: RangeQuery['granularity']): string {
  const d = new Date(iso);
  if (granularity === 'hour') return `${d.getHours()}:00`;
  if (granularity === 'month') return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function PresenceBadge({ state }: { state: string }) {
  const color =
    state === 'AVAILABLE' ? 'var(--good)' : state === 'ON_CALL' || state === 'RESERVED' ? 'var(--accent)' : 'var(--text-dim)';
  return (
    <span className="rounded-full px-2 py-0.5 text-xs font-semibold" style={{ background: 'var(--surface-2)', color }}>
      {state.replace('_', ' ')}
    </span>
  );
}

export function Stat({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
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

interface MemberStats {
  agent: { id: string; name: string; email: string; presence: string; talkTimeTodaySeconds: number };
  summary: {
    handled: number;
    booked: number;
    talkSeconds: number;
    avgHandleSeconds: number;
    conversionRate: number;
    avgQaScore: number | null;
    avgLeadScore: number | null;
    recordings: number;
  };
  transfers: {
    offered: number;
    accepted: number;
    declined: number;
    timedOut: number;
    acceptanceRate: number;
    avgAcceptSeconds: number | null;
  };
  activity: {
    availableSeconds: number;
    onCallSeconds: number;
    wrapUpSeconds: number;
    breakSeconds: number;
    loggedInSeconds: number;
    occupancy: number;
  };
  timeline: Array<{ bucket: string; handled: number; booked: number; talkSeconds: number }>;
  dispositions: Array<{ disposition: string; count: number }>;
  recentCalls: Array<{
    id: string;
    bridgedAt: string | null;
    talkSeconds: number | null;
    disposition: string | null;
    outcome: string | null;
    finalScore: number;
    qaScore: number | null;
    summary: string;
    recordings: number;
  }>;
}

const ACTIVITY_SLICES = [
  { key: 'onCallSeconds', label: 'On call', color: 'var(--accent)' },
  { key: 'wrapUpSeconds', label: 'Wrap-up', color: 'var(--accent-dim)' },
  { key: 'availableSeconds', label: 'Available', color: 'var(--good)' },
  { key: 'breakSeconds', label: 'Break', color: 'var(--text-dim)' },
] as const;

/**
 * The per-agent insights view, shared between "My insights" (target="me")
 * and the admin/supervisor member drill-down (target=<userId>).
 */
export default function AgentInsightsView({ target, title }: { target: string; title?: string }) {
  const [preset, setPreset] = useState<RangePreset>('today');
  const [data, setData] = useState<MemberStats | null>(null);
  const [expandedCall, setExpandedCall] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const range = rangeForPreset(preset);
    try {
      const { data: res } = await api.get(
        `/analytics/agents/${target}?from=${range.from}&to=${range.to}&granularity=${range.granularity}`,
      );
      setData(res);
      setError('');
    } catch {
      setError('Could not load insights.');
    }
  }, [preset, target]);

  useEffect(() => {
    load().catch(() => undefined);
    const timer = setInterval(() => load().catch(() => undefined), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const granularity = rangeForPreset(preset).granularity;
  const maxHandled = data ? Math.max(...data.timeline.map((t) => t.handled), 1) : 1;
  const activityTotal = data
    ? ACTIVITY_SLICES.reduce((sum, s) => sum + data.activity[s.key], 0)
    : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">{title ?? (data ? data.agent.name : 'Insights')}</h1>
          {data && <PresenceBadge state={data.agent.presence} />}
        </div>
        <div className="flex gap-1">
          {RANGE_PRESETS.map((r) => (
            <button
              key={r.key}
              onClick={() => setPreset(r.key)}
              className="btn text-sm"
              style={
                preset === r.key
                  ? { background: 'var(--surface-2)', color: 'var(--accent)' }
                  : { color: 'var(--text-dim)' }
              }
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="text-sm" style={{ color: 'var(--bad)' }}>
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-8">
        <Stat label="Calls handled" value={data?.summary.handled ?? '—'} />
        <Stat label="Bookings" value={data?.summary.booked ?? '—'} accent />
        <Stat label="Conversion" value={data ? `${Math.round(data.summary.conversionRate * 100)}%` : '—'} />
        <Stat label="Talk time" value={data ? fmtDuration(data.summary.talkSeconds) : '—'} />
        <Stat label="Avg handle" value={data ? fmtDuration(data.summary.avgHandleSeconds) : '—'} />
        <Stat
          label="Acceptance"
          value={data && data.transfers.offered > 0 ? `${Math.round(data.transfers.acceptanceRate * 100)}%` : '—'}
        />
        <Stat label="Avg QA" value={data?.summary.avgQaScore != null ? Math.round(data.summary.avgQaScore) : '—'} />
        <Stat label="Recordings" value={data?.summary.recordings ?? '—'} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card p-6">
          <h2 className="mb-4 font-semibold">
            Calls {granularity === 'hour' ? 'per hour' : granularity === 'day' ? 'per day' : 'per month'}
          </h2>
          {!data || data.timeline.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
              No calls in this range yet.
            </p>
          ) : (
            <div className="flex h-40 items-end gap-1">
              {data.timeline.map((t) => (
                <div key={t.bucket} className="flex flex-1 flex-col items-center gap-1" title={`${t.handled} calls, ${t.booked} booked, ${fmtDuration(t.talkSeconds)} talk`}>
                  <div className="flex w-full flex-1 flex-col justify-end">
                    <div
                      className="w-full rounded-t"
                      style={{ height: `${(t.booked / maxHandled) * 100}%`, background: 'var(--good)' }}
                    />
                    <div
                      className="w-full"
                      style={{
                        height: `${((t.handled - t.booked) / maxHandled) * 100}%`,
                        background: 'var(--accent)',
                        borderRadius: t.booked === 0 ? '0.25rem 0.25rem 0 0' : 0,
                      }}
                    />
                  </div>
                  <span className="text-[10px]" style={{ color: 'var(--text-dim)' }}>
                    {fmtBucket(t.bucket, granularity)}
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className="mt-3 text-xs" style={{ color: 'var(--text-dim)' }}>
            <span style={{ color: 'var(--accent)' }}>■</span> handled&nbsp;&nbsp;
            <span style={{ color: 'var(--good)' }}>■</span> booked
          </p>
        </section>

        <section className="card p-6">
          <h2 className="mb-4 font-semibold">Activity &amp; occupancy</h2>
          {activityTotal === 0 ? (
            <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
              No workspace activity in this range.
            </p>
          ) : (
            <>
              <div className="flex h-6 w-full overflow-hidden rounded" style={{ background: 'var(--surface-2)' }}>
                {ACTIVITY_SLICES.map((s) => (
                  <div
                    key={s.key}
                    style={{ width: `${((data?.activity[s.key] ?? 0) / activityTotal) * 100}%`, background: s.color }}
                  />
                ))}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                {ACTIVITY_SLICES.map((s) => (
                  <p key={s.key}>
                    <span style={{ color: s.color }}>■</span>{' '}
                    <span style={{ color: 'var(--text-dim)' }}>{s.label}</span>{' '}
                    <span className="font-semibold">{fmtDuration(data?.activity[s.key] ?? 0)}</span>
                  </p>
                ))}
              </div>
              <p className="mt-4 text-sm">
                Occupancy{' '}
                <span className="text-xl font-bold" style={{ color: 'var(--accent)' }}>
                  {Math.round((data?.activity.occupancy ?? 0) * 100)}%
                </span>{' '}
                <span style={{ color: 'var(--text-dim)' }}>· logged-in {fmtDuration(data?.activity.loggedInSeconds ?? 0)}</span>
              </p>
            </>
          )}
        </section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card p-6">
          <h2 className="mb-4 font-semibold">Transfer offers</h2>
          <div className="grid grid-cols-4 gap-3 text-center">
            {[
              { label: 'Offered', value: data?.transfers.offered },
              { label: 'Accepted', value: data?.transfers.accepted },
              { label: 'Declined', value: data?.transfers.declined },
              { label: 'Timed out', value: data?.transfers.timedOut },
            ].map((x) => (
              <div key={x.label} className="rounded-lg p-3" style={{ background: 'var(--surface-2)' }}>
                <p className="text-xl font-bold">{x.value ?? '—'}</p>
                <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
                  {x.label}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-sm" style={{ color: 'var(--text-dim)' }}>
            Avg time to accept:{' '}
            <span className="font-semibold" style={{ color: 'var(--text)' }}>
              {data?.transfers.avgAcceptSeconds != null ? `${data.transfers.avgAcceptSeconds}s` : '—'}
            </span>
          </p>
        </section>

        <section className="card p-6">
          <h2 className="mb-4 font-semibold">Dispositions</h2>
          {!data || data.dispositions.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
              No dispositioned calls in this range.
            </p>
          ) : (
            <div className="space-y-2">
              {data.dispositions.map((d) => {
                const max = Math.max(...data.dispositions.map((x) => x.count), 1);
                return (
                  <div key={d.disposition} className="flex items-center gap-3 text-sm">
                    <span className="w-32 truncate" style={{ color: 'var(--text-dim)' }}>
                      {d.disposition.replace(/_/g, ' ')}
                    </span>
                    <div className="h-4 flex-1 overflow-hidden rounded" style={{ background: 'var(--surface-2)' }}>
                      <div
                        className="h-full rounded"
                        style={{
                          width: `${(d.count / max) * 100}%`,
                          background: d.disposition === 'BOOKED' ? 'var(--good)' : 'var(--accent)',
                        }}
                      />
                    </div>
                    <span className="w-8 text-right font-semibold">{d.count}</span>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <section className="card overflow-x-auto">
        <h2 className="p-6 pb-0 font-semibold">Recent calls</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left" style={{ color: 'var(--text-dim)' }}>
              <th className="p-3 pl-6">When</th>
              <th className="p-3">Duration</th>
              <th className="p-3">Disposition</th>
              <th className="p-3">Score</th>
              <th className="p-3">QA</th>
              <th className="p-3">Recordings</th>
            </tr>
          </thead>
          <tbody>
            {(data?.recentCalls ?? []).map((c) => (
              <Fragment key={c.id}>
                <tr
                  onClick={() => setExpandedCall(expandedCall === c.id ? null : c.id)}
                  className="cursor-pointer border-t"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <td className="p-3 pl-6">{c.bridgedAt ? new Date(c.bridgedAt).toLocaleString() : '—'}</td>
                  <td className="p-3">{fmtDuration(c.talkSeconds)}</td>
                  <td className="p-3">{c.disposition?.replace(/_/g, ' ') ?? '—'}</td>
                  <td className="p-3 font-semibold">{c.finalScore}</td>
                  <td className="p-3">{c.qaScore ?? '—'}</td>
                  <td className="p-3">{c.recordings}</td>
                </tr>
                {expandedCall === c.id && (
                  <tr className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td colSpan={6} className="p-3 pl-6">
                      <p className="rounded-lg p-3 text-sm" style={{ background: 'var(--surface-2)' }}>
                        {c.summary || 'No AI summary for this call.'}
                      </p>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {data && data.recentCalls.length === 0 && (
              <tr className="border-t" style={{ borderColor: 'var(--border)' }}>
                <td colSpan={6} className="p-6 text-sm" style={{ color: 'var(--text-dim)' }}>
                  No handled calls in this range.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
