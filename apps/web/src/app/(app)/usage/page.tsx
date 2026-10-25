'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { num } from '@/lib/billing';

interface Usage {
  dials: number;
  answered: number;
  voicemail: number;
  transfers: number;
  manualDials: number;
  aiSeconds: number;
  humanSeconds: number;
}

interface Daily {
  from: string;
  to: string;
  timezone: string;
  totals: Usage;
  days: Array<{ day: string } & Usage>;
  byCampaign: Array<{ campaignId: string; name: string } & Usage>;
}

const TZ = 'Asia/Kolkata';

/** Today as YYYY-MM-DD in the board's zone. */
function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

function shift(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

const PRESETS: Array<{ id: string; label: string; range: () => [string, string] }> = [
  { id: 'today', label: 'Today', range: () => [today(), today()] },
  { id: '7d', label: 'Last 7 days', range: () => [shift(today(), -6), today()] },
  { id: '30d', label: 'Last 30 days', range: () => [shift(today(), -29), today()] },
  { id: 'month', label: 'This month', range: () => [`${today().slice(0, 8)}01`, today()] },
];

/** Answered by a person: answered minus answering machines. */
const people = (u: Usage) => Math.max(0, u.answered - u.voicemail);
const noAnswer = (u: Usage) => Math.max(0, u.dials - u.answered);
const mins = (s: number) => num(Math.round((s / 60) * 10) / 10, 1);
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');

function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** The tenant's usage board: calls and talk time per day. Counts only; billing comes later. */
export default function UsagePage() {
  const [preset, setPreset] = useState('7d');
  const [[from, to], setRange] = useState<[string, string]>(PRESETS[1]!.range());
  const [data, setData] = useState<Daily | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setData(null);
    api
      .get<Daily>(`/usage/daily?from=${from}&to=${to}&tz=${encodeURIComponent(TZ)}`)
      .then((r) => {
        setData(r.data);
        setError('');
      })
      .catch(() => setError('Could not load usage.'));
  }, [from, to]);

  const pick = (id: string) => {
    const p = PRESETS.find((x) => x.id === id)!;
    setPreset(id);
    setRange(p.range());
  };
  const setDate = (which: 0 | 1, v: string) => {
    if (!v) return;
    setPreset('custom');
    setRange((r) => {
      const next: [string, string] = which === 0 ? [v, r[1]] : [r[0], v];
      return next[0] <= next[1] ? next : [next[1], next[0]];
    });
  };

  const days = useMemo(() => (data ? [...data.days].reverse() : []), [data]);
  const maxAi = useMemo(() => Math.max(1, ...days.map((d) => d.aiSeconds)), [days]);
  const t = data?.totals;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Usage</h1>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
            Calls and talk time, day by day. Days are in India time (IST).
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-lg border" style={{ borderColor: 'var(--border)' }}>
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => pick(p.id)}
                className="px-3 py-1.5 text-sm"
                style={preset === p.id ? { background: 'var(--accent)', color: '#0b1220', fontWeight: 600 } : { color: 'var(--text-dim)' }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <input type="date" className="input w-auto" value={from} max={today()} onChange={(e) => setDate(0, e.target.value)} aria-label="From" />
          <span style={{ color: 'var(--text-dim)' }}>to</span>
          <input type="date" className="input w-auto" value={to} max={today()} onChange={(e) => setDate(1, e.target.value)} aria-label="To" />
        </div>
      </div>

      {error && <p className="text-sm" style={{ color: 'var(--bad)' }}>{error}</p>}
      {!data && !error && <p style={{ color: 'var(--text-dim)' }}>Loading…</p>}

      {t && data && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Figure label="Calls dialled" value={num(t.dials)} hint={t.manualDials ? `${num(t.manualDials)} dialled by agents` : 'All by the AI dialler'} />
            <Figure label="Picked up by a person" value={num(people(t))} hint={`${pct(people(t), t.dials)} of calls`} />
            <Figure label="Voicemail" value={num(t.voicemail)} hint={`${pct(t.voicemail, t.dials)} of calls`} />
            <Figure label="No answer" value={num(noAnswer(t))} hint={`${pct(noAnswer(t), t.dials)} of calls`} />
            <Figure label="AI talk time" value={`${mins(t.aiSeconds)} min`} hint={people(t) ? `${mins(t.aiSeconds / Math.max(1, people(t)))} min per pick-up` : undefined} accent />
            <Figure label="Human talk time" value={`${mins(t.humanSeconds)} min`} hint="Agents, after transfer or manual dial" />
            <Figure label="Transferred to agents" value={num(t.transfers)} hint={`${pct(t.transfers, people(t))} of pick-ups`} />
            <Figure label="Total talk time" value={`${mins(t.aiSeconds + t.humanSeconds)} min`} hint="AI + human" />
          </div>

          <section className="card overflow-x-auto">
            <h2 className="px-5 pt-4 font-semibold">By day</h2>
            <table className="mt-2 w-full min-w-[720px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                  <th className="px-5 pb-2">Day</th>
                  <th className="px-3 pb-2 text-right">Dialled</th>
                  <th className="px-3 pb-2 text-right">Picked up</th>
                  <th className="px-3 pb-2 text-right">Voicemail</th>
                  <th className="px-3 pb-2 text-right">No answer</th>
                  <th className="px-3 pb-2 text-right">Transfers</th>
                  <th className="px-3 pb-2 text-right">AI min</th>
                  <th className="px-5 pb-2 text-right">Human min</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => {
                  const empty = d.dials === 0;
                  return (
                    <tr key={d.day} className="border-t" style={{ borderColor: 'var(--border)', ...(empty ? { color: 'var(--text-dim)' } : {}) }}>
                      <td className="px-5 py-2 whitespace-nowrap">{dayLabel(d.day)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{empty ? '—' : num(d.dials)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{empty ? '' : num(people(d))}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{empty ? '' : num(d.voicemail)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{empty ? '' : num(noAnswer(d))}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{empty ? '' : num(d.transfers)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {!empty && (
                          <span className="inline-flex items-center justify-end gap-2">
                            <span className="hidden h-1.5 rounded-full sm:inline-block" style={{ width: `${Math.round((d.aiSeconds / maxAi) * 64)}px`, background: 'var(--accent)' }} />
                            {mins(d.aiSeconds)}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-2 text-right tabular-nums">{empty ? '' : mins(d.humanSeconds)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t font-semibold" style={{ borderColor: 'var(--border)' }}>
                  <td className="px-5 py-2">Total</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(t.dials)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(people(t))}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(t.voicemail)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(noAnswer(t))}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(t.transfers)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{mins(t.aiSeconds)}</td>
                  <td className="px-5 py-2 text-right tabular-nums">{mins(t.humanSeconds)}</td>
                </tr>
              </tfoot>
            </table>
          </section>

          {data.byCampaign.length > 0 && (
            <section className="card overflow-x-auto">
              <h2 className="px-5 pt-4 font-semibold">By campaign</h2>
              <table className="mt-2 w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                    <th className="px-5 pb-2">Campaign</th>
                    <th className="px-3 pb-2 text-right">Dialled</th>
                    <th className="px-3 pb-2 text-right">Picked up</th>
                    <th className="px-3 pb-2 text-right">Voicemail</th>
                    <th className="px-3 pb-2 text-right">Transfers</th>
                    <th className="px-3 pb-2 text-right">AI min</th>
                    <th className="px-5 pb-2 text-right">Human min</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byCampaign.map((c) => (
                    <tr key={c.campaignId} className="border-t" style={{ borderColor: 'var(--border)' }}>
                      <td className="px-5 py-2">{c.name}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{num(c.dials)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{num(people(c))}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{num(c.voicemail)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{num(c.transfers)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{mins(c.aiSeconds)}</td>
                      <td className="px-5 py-2 text-right tabular-nums">{mins(c.humanSeconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
            Picked up = answered by a person (answering machines are counted under Voicemail). AI talk time runs from pick-up until the
            AI hands over or the call ends; human talk time is an agent on the line, after a transfer or on a manual dial.
          </p>
        </>
      )}
    </div>
  );
}

function Figure({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: boolean }) {
  return (
    <div className="card p-4">
      <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>{label}</p>
      <p className="text-2xl font-bold tabular-nums" style={accent ? { color: 'var(--accent)' } : undefined}>
        {value}
      </p>
      {hint && <p className="text-xs" style={{ color: 'var(--text-dim)' }}>{hint}</p>}
    </div>
  );
}
