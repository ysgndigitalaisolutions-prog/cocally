'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import {
  fmtBucket,
  fmtDuration,
  PresenceBadge,
  RANGE_PRESETS,
  rangeForPreset,
  Stat,
  type RangePreset,
} from '@/components/AgentInsightsView';

interface TeamMemberRow {
  id: string;
  name: string;
  email: string;
  presence: string;
  handled: number;
  booked: number;
  talkSeconds: number;
  avgHandleSeconds: number;
  conversionRate: number;
  avgQaScore: number | null;
  recordings: number;
  transfers: { offered: number; accepted: number; acceptanceRate: number; avgAcceptSeconds: number | null };
  activity: { occupancy: number; loggedInSeconds: number };
}

interface TeamStats {
  members: TeamMemberRow[];
  timeline: Array<{ bucket: string; dials: number; connects: number; aiResolved: number; humanBridged: number; booked: number }>;
  totals: { dials: number; connects: number; aiResolved: number; humanBridged: number; booked: number };
}

/** Supervisor/admin roster: per-member insights + AI-vs-human floor volume. */
export default function TeamInsightsPage() {
  const router = useRouter();
  const [preset, setPreset] = useState<RangePreset>('today');
  const [data, setData] = useState<TeamStats | null>(null);

  const load = useCallback(async () => {
    const range = rangeForPreset(preset);
    const { data: res } = await api.get(
      `/analytics/agents/team?from=${range.from}&to=${range.to}&granularity=${range.granularity}`,
    );
    setData(res);
  }, [preset]);

  useEffect(() => {
    load().catch(() => undefined);
    const timer = setInterval(() => load().catch(() => undefined), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const granularity = rangeForPreset(preset).granularity;
  const maxDials = data ? Math.max(...data.timeline.map((t) => t.dials), 1) : 1;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Team insights</h1>
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

      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <Stat label="AI dials" value={data?.totals.dials ?? '—'} />
        <Stat label="Connects" value={data?.totals.connects ?? '—'} />
        <Stat label="AI-resolved" value={data?.totals.aiResolved ?? '—'} />
        <Stat label="Human-handled" value={data?.totals.humanBridged ?? '—'} />
        <Stat label="Bookings" value={data?.totals.booked ?? '—'} accent />
      </div>

      <section className="card p-6">
        <h2 className="mb-4 font-semibold">
          AI vs human volume {granularity === 'hour' ? 'per hour' : granularity === 'day' ? 'per day' : 'per month'}
        </h2>
        {!data || data.timeline.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
            No calls in this range yet.
          </p>
        ) : (
          <div className="flex h-40 items-end gap-1">
            {data.timeline.map((t) => (
              <div
                key={t.bucket}
                className="flex flex-1 flex-col items-center gap-1"
                title={`${t.dials} dials · ${t.aiResolved} AI-resolved · ${t.humanBridged} human · ${t.booked} booked`}
              >
                <div className="flex w-full flex-1 flex-col justify-end">
                  <div
                    className="w-full rounded-t"
                    style={{ height: `${(t.humanBridged / maxDials) * 100}%`, background: 'var(--good)' }}
                  />
                  <div
                    className="w-full"
                    style={{ height: `${(t.aiResolved / maxDials) * 100}%`, background: 'var(--accent)' }}
                  />
                  <div
                    className="w-full"
                    style={{
                      height: `${(Math.max(t.dials - t.aiResolved - t.humanBridged, 0) / maxDials) * 100}%`,
                      background: 'var(--surface-2)',
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
          <span style={{ color: 'var(--good)' }}>■</span> human-handled&nbsp;&nbsp;
          <span style={{ color: 'var(--accent)' }}>■</span> AI-resolved&nbsp;&nbsp;
          <span>■</span> no-connect dials
        </p>
      </section>

      <section className="card overflow-x-auto">
        <h2 className="p-6 pb-0 font-semibold">Members</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left" style={{ color: 'var(--text-dim)' }}>
              <th className="p-3 pl-6">Agent</th>
              <th className="p-3">Presence</th>
              <th className="p-3">Handled</th>
              <th className="p-3">Booked</th>
              <th className="p-3">Conversion</th>
              <th className="p-3">Talk time</th>
              <th className="p-3">Avg handle</th>
              <th className="p-3">Offers</th>
              <th className="p-3">Acceptance</th>
              <th className="p-3">Avg QA</th>
              <th className="p-3">Recordings</th>
              <th className="p-3">Occupancy</th>
            </tr>
          </thead>
          <tbody>
            {(data?.members ?? []).map((m) => (
              <tr
                key={m.id}
                onClick={() => router.push(`/team/${m.id}`)}
                className="cursor-pointer border-t"
                style={{ borderColor: 'var(--border)' }}
              >
                <td className="p-3 pl-6">
                  <p className="font-medium">{m.name}</p>
                  <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
                    {m.email}
                  </p>
                </td>
                <td className="p-3">
                  <PresenceBadge state={m.presence} />
                </td>
                <td className="p-3 font-semibold">{m.handled}</td>
                <td className="p-3" style={{ color: 'var(--good)' }}>
                  {m.booked}
                </td>
                <td className="p-3">{m.handled > 0 ? `${Math.round(m.conversionRate * 100)}%` : '—'}</td>
                <td className="p-3">{fmtDuration(m.talkSeconds)}</td>
                <td className="p-3">{m.handled > 0 ? fmtDuration(m.avgHandleSeconds) : '—'}</td>
                <td className="p-3">{m.transfers.offered}</td>
                <td className="p-3">
                  {m.transfers.offered > 0 ? `${Math.round(m.transfers.acceptanceRate * 100)}%` : '—'}
                </td>
                <td className="p-3">{m.avgQaScore != null ? Math.round(m.avgQaScore) : '—'}</td>
                <td className="p-3">{m.recordings}</td>
                <td className="p-3">
                  {m.activity.loggedInSeconds > 0 ? `${Math.round(m.activity.occupancy * 100)}%` : '—'}
                </td>
              </tr>
            ))}
            {data && data.members.length === 0 && (
              <tr className="border-t" style={{ borderColor: 'var(--border)' }}>
                <td colSpan={12} className="p-6 text-sm" style={{ color: 'var(--text-dim)' }}>
                  No active agents in this tenant.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
