'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { num } from '@/lib/billing';

interface Usage {
  dials: number;
  pickedUp: number;
  voicemail: number;
  transfers: number;
  ringSeconds: number;
  aiSeconds: number;
  humanSeconds: number;
}

interface Daily {
  totals: Usage;
  days: Array<{ day: string } & Usage>;
  byCampaign: Array<{ campaignId: string; name: string } & Usage>;
}

/** Days follow the viewer's own clock, so "today" means their today. */
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';

function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

function shift(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

const PRESETS: Array<{ id: string; label: string; range: () => [string, string] }> = [
  { id: 'today', label: 'Today', range: () => [today(), today()] },
  { id: '7d', label: '7 days', range: () => [shift(today(), -6), today()] },
  { id: '30d', label: '30 days', range: () => [shift(today(), -29), today()] },
  { id: 'month', label: 'This month', range: () => [`${today().slice(0, 8)}01`, today()] },
];

const MINUTES = [
  { key: 'ringSeconds', label: 'Ring', color: 'var(--text-dim)', hint: 'Phone ringing, before anyone answers' },
  { key: 'aiSeconds', label: 'AI', color: 'var(--accent)', hint: 'The AI talking with the customer' },
  { key: 'humanSeconds', label: 'Human', color: 'var(--good)', hint: 'An agent on the line with the customer' },
] as const;

const mins = (s: number) => num(Math.round((s / 60) * 10) / 10, 1);
const totalSeconds = (u: Usage) => u.ringSeconds + u.aiSeconds + u.humanSeconds;
const noAnswer = (u: Usage) => Math.max(0, u.dials - u.pickedUp - u.voicemail);
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '–');

function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export default function DashboardPage() {
  const [preset, setPreset] = useState('7d');
  const [[from, to], setRange] = useState<[string, string]>(() => PRESETS[1]!.range());
  const [data, setData] = useState<Daily | null>(null);
  const [error, setError] = useState('');
  const [overdue, setOverdue] = useState(0);

  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .get<Daily>(`/usage/daily?from=${from}&to=${to}&tz=${encodeURIComponent(TZ)}`)
        .then((r) => {
          if (!live) return;
          setData(r.data);
          setError('');
        })
        .catch(() => live && setError('Could not load your minutes. Please refresh the page.'));
    setData(null);
    void load();
    const timer = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [from, to]);

  useEffect(() => {
    api
      .get('/leads/callbacks/overdue')
      .then((r) => setOverdue(Array.isArray(r.data) ? r.data.length : 0))
      .catch(() => undefined);
  }, []);

  const setDate = (which: 0 | 1, v: string) => {
    if (!v) return;
    setPreset('custom');
    setRange((r) => {
      const next: [string, string] = which === 0 ? [v, r[1]] : [r[0], v];
      return next[0] <= next[1] ? next : [next[1], next[0]];
    });
  };

  const days = useMemo(() => (data ? data.days.filter((d) => d.dials > 0).reverse() : []), [data]);
  const t = data?.totals;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-lg border border-border">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={preset === p.id}
                onClick={() => {
                  setPreset(p.id);
                  setRange(p.range());
                }}
                className={`px-3 py-1.5 text-sm ${preset === p.id ? 'bg-accent font-semibold text-on-accent' : 'text-dim hover:text-text'}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <input type="date" className="input" style={{ width: 'auto' }} value={from} max={today()} onChange={(e) => setDate(0, e.target.value)} aria-label="From" />
          <span className="text-sm text-dim">to</span>
          <input type="date" className="input" style={{ width: 'auto' }} value={to} max={today()} onChange={(e) => setDate(1, e.target.value)} aria-label="To" />
        </div>
      </div>

      {overdue > 0 && (
        <Link href="/leads" className="card block border-bad px-4 py-3 text-sm hover:underline">
          <span className="font-semibold text-bad">{overdue} overdue {overdue === 1 ? 'callback' : 'callbacks'}</span>
          <span className="text-dim"> · customers we promised to call back. Open leads</span>
        </Link>
      )}

      {error && <p className="text-sm text-bad">{error}</p>}
      {!data && !error && <p className="text-dim">Loading…</p>}

      {t && data && (t.dials === 0 ? (
        <section className="card p-10 text-center">
          <p className="font-semibold">No calls in this period</p>
          <p className="mt-1 text-sm text-dim">Your ring, AI and human minutes will show here once calls are made.</p>
        </section>
      ) : (
        <>
          <section className="card p-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm text-dim">Total minutes</p>
              <p className="text-4xl font-bold tabular-nums">{mins(totalSeconds(t))}</p>
            </div>
            <div className="mt-4 flex h-3 gap-0.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
              {MINUTES.map((m) => (
                <div key={m.key} style={{ width: `${totalSeconds(t) ? (t[m.key] / totalSeconds(t)) * 100 : 0}%`, background: m.color }} />
              ))}
            </div>
            <div className="mt-6 grid gap-6 sm:grid-cols-3">
              {MINUTES.map((m) => (
                <div key={m.key}>
                  <p className="flex items-center gap-2 text-sm font-semibold">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: m.color }} aria-hidden />
                    {m.label} minutes
                  </p>
                  <p className="mt-1 text-3xl font-bold tabular-nums">{mins(t[m.key])}</p>
                  <p className="mt-1 text-xs text-dim">{m.hint}</p>
                </div>
              ))}
            </div>
          </section>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Figure label="Calls" value={num(t.dials)} />
            <Figure label="Picked up" value={num(t.pickedUp)} hint={`${pct(t.pickedUp, t.dials)} of calls`} />
            <Figure label="No answer" value={num(noAnswer(t))} hint={`${pct(noAnswer(t), t.dials)} of calls`} />
            <Figure label="Voicemail" value={num(t.voicemail)} hint={`${pct(t.voicemail, t.dials)} of calls`} />
            <Figure label="Transfers" value={num(t.transfers)} hint={`${pct(t.transfers, t.pickedUp)} of pick-ups`} />
          </div>

          <MinutesTable
            title="By day"
            first="Day"
            rows={days.map((d) => ({ key: d.day, name: dayLabel(d.day), usage: d }))}
            totals={t}
          />
          {data.byCampaign.length > 1 && (
            <MinutesTable
              title="By campaign"
              first="Campaign"
              rows={data.byCampaign.map((c) => ({ key: c.campaignId, name: c.name, usage: c }))}
            />
          )}
        </>
      ))}
    </div>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-4">
      <p className="text-xs text-dim">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-dim">{hint}</p>}
    </div>
  );
}

function MinutesTable({ title, first, rows, totals }: { title: string; first: string; rows: Array<{ key: string; name: string; usage: Usage }>; totals?: Usage }) {
  const cells = (u: Usage) => [num(u.dials), mins(u.ringSeconds), mins(u.aiSeconds), mins(u.humanSeconds), mins(totalSeconds(u))];
  return (
    <section className="card overflow-x-auto">
      <h2 className="px-5 pt-4 font-semibold">{title}</h2>
      <table className="mt-2 w-full min-w-[520px] text-sm">
        <thead>
          <tr className="text-xs text-dim">
            <th className="px-5 pb-2 text-left font-medium">{first}</th>
            {['Calls', 'Ring min', 'AI min', 'Human min', 'Total min'].map((h) => (
              <th key={h} className="px-3 pb-2 text-right font-medium last:pr-5">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-border">
              <td className="px-5 py-2 whitespace-nowrap">{r.name}</td>
              {cells(r.usage).map((c, i) => (
                <td key={i} className="px-3 py-2 text-right tabular-nums last:pr-5">{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
        {totals && (
          <tfoot>
            <tr className="border-t border-border font-semibold">
              <td className="px-5 py-2">Total</td>
              {cells(totals).map((c, i) => (
                <td key={i} className="px-3 py-2 text-right tabular-nums last:pr-5">{c}</td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </section>
  );
}
