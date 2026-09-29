'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Gap, Legend, ms, StageBar, type Dist, type Targets } from '@/components/ops/latency';
import { fmtDateTime, Stat } from '@/components/ops/ui';
import { opsApi, opsError } from '@/lib/ops-api';

interface Stats {
  turns: number;
  timedTurns: number;
  untimedTurns: number;
  total: Dist;
  eou: Dist;
  stt: Dist;
  llm: Dist;
  tts: Dist;
  slow: number;
  stalls: number;
  underTarget: number;
}

interface Stack {
  stt: string;
  llm: string;
  tts: string;
}

interface Latency {
  range: { from: string; to: string };
  targets: Targets;
  truncated: boolean;
  summary: Stats & {
    calls: number;
    stallGuardFires: number;
    greeting: Dist;
    answerDetect: Dist;
    amd: Dist;
    transfers: { n: number; bridged: number; wait: Dist };
  };
  byStack: Array<Stats & { stack: Stack; calls: number }>;
  byModel: Array<{ model: string; turns: number; llm: Dist; total: Dist }>;
  byVoice: Array<{ model: string; turns: number; tts: Dist }>;
  network: {
    providers: Array<{ host: string; stage: string; rtt: Dist }>;
    media: { rtt: Dist; jitter: Dist; lossPct: Dist };
  };
  byDay: Array<Stats & { day: string; calls: number }>;
  calls: Array<{
    id: string;
    startedAt: string;
    leadName: string | null;
    campaignName: string;
    outcome: string | null;
    stack: Stack;
    turns: number;
    untimedTurns: number;
    p50: number | null;
    p95: number | null;
    max: number | null;
    eouP50: number | null;
    llmP50: number | null;
    ttsP50: number | null;
    slow: number;
    stalls: number;
    stallGuardFires: number;
    greetingMs: number | null;
    amdLatencyMs: number | null;
    llmServed: string[];
    net: { providers: Record<string, number>; mediaRttMs: number | null; jitterMaxMs: number | null; lossPct: number | null };
  }>;
}

const RANGES: Array<[string, number]> = [
  ['Today', 1],
  ['7 days', 7],
  ['30 days', 30],
];

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const stackLabel = (s: Stack) => `${s.stt} · ${s.llm} · ${s.tts}`;

function DistRow({ label, d, t, stage }: { label: string; d: Dist; t: Targets; stage?: boolean }) {
  return (
    <tr className="border-t" style={{ borderColor: 'var(--border)' }}>
      <td className="px-4 py-2">{label}</td>
      {(['p50', 'p90', 'p95', 'max'] as const).map((k) => (
        <td key={k} className="px-3 py-2 text-right">
          {stage ? <span className="tabular-nums">{ms(d[k])}</span> : <Gap v={d[k]} t={t} />}
        </td>
      ))}
      <td className="px-4 py-2 text-right tabular-nums" style={{ color: 'var(--text-dim)' }}>{d.n}</td>
    </tr>
  );
}

/**
 * Per-tenant voice latency: what the caller waits for after they stop
 * talking, split by stage, by provider stack, by the model that actually
 * answered, by day and by call. Built for "which stack do we keep".
 */
export default function TenantLatency({ tenantId }: { tenantId: string }) {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<Latency | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const to = new Date();
    const from = days === 1 ? new Date(new Date().setHours(0, 0, 0, 0)) : new Date(to.getTime() - days * 86_400_000);
    try {
      const r = await opsApi.get<Latency>(`/tenants/${tenantId}/latency?from=${from.toISOString()}&to=${to.toISOString()}`);
      setData(r.data);
      setError('');
    } catch (err) {
      setError(opsError(err, 'Could not load latency.'));
    }
  }, [tenantId, days]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data) return <p style={{ color: error ? 'var(--bad)' : 'var(--text-dim)' }}>{error || 'Loading…'}</p>;
  const s = data.summary;
  const t = data.targets;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1">
          {RANGES.map(([label, d]) => (
            <button key={d} className={`btn text-xs ${days === d ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setDays(d)}>{label}</button>
          ))}
          <button className="btn btn-ghost text-xs" onClick={() => void load()}>Refresh</button>
        </div>
        <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
          Turn gap = customer stops talking → AI&apos;s first audio. Green ≤ {ms(t.goodMs)}, amber &gt; {ms(t.slowMs)}, red stall &gt; {ms(t.stallMs)}.
          {data.truncated ? ' Showing the newest 1,000 calls.' : ''}
        </p>
      </div>
      {error && <p className="text-sm" style={{ color: 'var(--bad)' }}>{error}</p>}

      {s.turns === 0 && s.calls === 0 ? (
        <p className="card p-5 text-sm" style={{ color: 'var(--text-dim)' }}>No AI calls with timing data in this range.</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Typical turn gap (p50)" value={ms(s.total.p50)} hint={`${s.timedTurns} timed replies over ${s.calls} calls`} tone={s.total.p50 != null && s.total.p50 <= t.goodMs ? 'good' : s.total.p50 != null && s.total.p50 > t.slowMs ? 'bad' : undefined} />
            <Stat label="Worst 5% (p95)" value={ms(s.total.p95)} hint={`max ${ms(s.total.max)}`} tone={s.total.p95 != null && s.total.p95 > t.stallMs ? 'bad' : s.total.p95 != null && s.total.p95 > t.slowMs ? 'warn' : undefined} />
            <Stat label="Replies under target" value={pct(s.underTarget, s.timedTurns)} hint={`${s.slow} slow · ${s.stalls} stalls`} tone={s.stalls ? 'bad' : undefined} />
            <Stat label="Pickup → first AI word" value={ms(s.greeting.p50)} hint={s.greeting.n ? `p95 ${ms(s.greeting.p95)} · ${s.greeting.n} calls` : 'no data yet'} />
          </div>

          <section className="card overflow-x-auto p-0">
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4">
              <h3 className="font-semibold">Where the time goes</h3>
              <Legend />
            </div>
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                  <th className="px-4 py-2">Stage</th>
                  <th className="px-3 py-2 text-right">p50</th>
                  <th className="px-3 py-2 text-right">p90</th>
                  <th className="px-3 py-2 text-right">p95</th>
                  <th className="px-3 py-2 text-right">Max</th>
                  <th className="px-4 py-2 text-right">n</th>
                </tr>
              </thead>
              <tbody>
                <DistRow label="End of turn (customer stops → turn decided)" d={s.eou} t={t} stage />
                <DistRow label="  of which speech-to-text final transcript" d={s.stt} t={t} stage />
                <DistRow label="LLM first token" d={s.llm} t={t} stage />
                <DistRow label="Voice first audio" d={s.tts} t={t} stage />
                <DistRow label="Total turn gap" d={s.total} t={t} />
                <DistRow label="Pickup → first AI word" d={s.greeting} t={t} stage />
                <DistRow label="Answering-machine decision" d={s.amd} t={t} stage />
              </tbody>
            </table>
            <p className="px-4 py-3 text-xs" style={{ color: 'var(--text-dim)' }}>
              Stall guard fired {s.stallGuardFires}× (speech-to-text never finalised; turn forced after the guard delay).
              {' '}{s.untimedTurns} replies had no measured end of turn (committed from the transcript); their LLM and voice times are included, but not their gap.
              {s.transfers.n ? ` Transfers: ${s.transfers.bridged}/${s.transfers.n} bridged, typical wait ${ms(s.transfers.wait.p50)}.` : ''}
            </p>
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="card overflow-x-auto p-0">
              <h3 className="px-4 pt-4 font-semibold">By provider stack</h3>
              <p className="px-4 text-xs" style={{ color: 'var(--text-dim)' }}>Speech-to-text · LLM (configured) · voice. Compare rows to choose a stack.</p>
              <table className="mt-2 w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                    <th className="px-4 py-2">Stack</th>
                    <th className="px-3 py-2 text-right">Calls</th>
                    <th className="px-3 py-2 text-right">p50</th>
                    <th className="px-3 py-2 text-right">p95</th>
                    <th className="px-3 py-2 text-right">EOT</th>
                    <th className="px-3 py-2 text-right">LLM</th>
                    <th className="px-3 py-2 text-right">Voice</th>
                    <th className="px-4 py-2 text-right">Stalls</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byStack.map((r) => (
                    <tr key={stackLabel(r.stack)} className="border-t" style={{ borderColor: 'var(--border)' }}>
                      <td className="px-4 py-2 font-mono text-xs">{stackLabel(r.stack)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.calls}</td>
                      <td className="px-3 py-2 text-right"><Gap v={r.total.p50} t={t} /></td>
                      <td className="px-3 py-2 text-right"><Gap v={r.total.p95} t={t} /></td>
                      <td className="px-3 py-2 text-right tabular-nums">{ms(r.eou.p50)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{ms(r.llm.p50)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{ms(r.tts.p50)}</td>
                      <td className="px-4 py-2 text-right tabular-nums" style={r.stalls ? { color: 'var(--bad)' } : undefined}>{r.stalls}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="card overflow-x-auto p-0">
              <h3 className="px-4 pt-4 font-semibold">By model that actually answered</h3>
              <p className="px-4 text-xs" style={{ color: 'var(--text-dim)' }}>A fallback model showing up here means the primary was slow or failing.</p>
              <table className="mt-2 w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                    <th className="px-4 py-2">Model</th>
                    <th className="px-3 py-2 text-right">Turns</th>
                    <th className="px-3 py-2 text-right">LLM p50</th>
                    <th className="px-3 py-2 text-right">LLM p95</th>
                    <th className="px-4 py-2 text-right">Gap p50</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byModel.map((r) => (
                    <tr key={r.model} className="border-t" style={{ borderColor: 'var(--border)' }}>
                      <td className="px-4 py-2 font-mono text-xs">{r.model}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.turns}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{ms(r.llm.p50)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{ms(r.llm.p95)}</td>
                      <td className="px-4 py-2 text-right"><Gap v={r.total.p50} t={t} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="card overflow-x-auto p-0">
              <h3 className="px-4 pt-4 font-semibold">Network</h3>
              <p className="px-4 text-xs" style={{ color: 'var(--text-dim)' }}>
                Measured from the AI worker on each call. Provider = one round trip to that host; it is part of every stage&apos;s time above.
                The phone ↔ carrier leg is not visible from here.
              </p>
              <table className="mt-2 w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                    <th className="px-4 py-2">Leg</th>
                    <th className="px-3 py-2 text-right">p50</th>
                    <th className="px-3 py-2 text-right">p95</th>
                    <th className="px-3 py-2 text-right">Max</th>
                    <th className="px-4 py-2 text-right">n</th>
                  </tr>
                </thead>
                <tbody>
                  {data.network.providers.map((p) => (
                    <tr key={p.host} className="border-t" style={{ borderColor: 'var(--border)' }}>
                      <td className="px-4 py-2">
                        {p.stage.toUpperCase()} <span className="font-mono text-xs" style={{ color: 'var(--text-dim)' }}>{p.host}</span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{ms(p.rtt.p50)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{ms(p.rtt.p95)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{ms(p.rtt.max)}</td>
                      <td className="px-4 py-2 text-right tabular-nums" style={{ color: 'var(--text-dim)' }}>{p.rtt.n}</td>
                    </tr>
                  ))}
                  <tr className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td className="px-4 py-2">Worker ↔ LiveKit media, round trip</td>
                    <td className="px-3 py-2 text-right tabular-nums">{ms(data.network.media.rtt.p50)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{ms(data.network.media.rtt.p95)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{ms(data.network.media.rtt.max)}</td>
                    <td className="px-4 py-2 text-right tabular-nums" style={{ color: 'var(--text-dim)' }}>{data.network.media.rtt.n}</td>
                  </tr>
                  <tr className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td className="px-4 py-2">Customer audio jitter</td>
                    <td className="px-3 py-2 text-right tabular-nums">{ms(data.network.media.jitter.p50)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{ms(data.network.media.jitter.p95)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{ms(data.network.media.jitter.max)}</td>
                    <td className="px-4 py-2 text-right tabular-nums" style={{ color: 'var(--text-dim)' }}>{data.network.media.jitter.n}</td>
                  </tr>
                  <tr className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td className="px-4 py-2">Customer audio packet loss</td>
                    {(['p50', 'p95', 'max'] as const).map((k) => (
                      <td key={k} className="px-3 py-2 text-right tabular-nums">
                        {data.network.media.lossPct[k] == null ? '—' : `${data.network.media.lossPct[k]!.toFixed(1)}%`}
                      </td>
                    ))}
                    <td className="px-4 py-2 text-right tabular-nums" style={{ color: 'var(--text-dim)' }}>{data.network.media.lossPct.n}</td>
                  </tr>
                </tbody>
              </table>
            </section>

            <section className="card overflow-x-auto p-0">
              <h3 className="px-4 pt-4 font-semibold">By voice that actually spoke</h3>
              <table className="mt-2 w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                    <th className="px-4 py-2">Voice model</th>
                    <th className="px-3 py-2 text-right">Turns</th>
                    <th className="px-3 py-2 text-right">First audio p50</th>
                    <th className="px-4 py-2 text-right">p95</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byVoice.map((r) => (
                    <tr key={r.model} className="border-t" style={{ borderColor: 'var(--border)' }}>
                      <td className="px-4 py-2 font-mono text-xs">{r.model}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.turns}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{ms(r.tts.p50)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{ms(r.tts.p95)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>

          <section className="card overflow-x-auto p-0">
            <h3 className="px-4 pt-4 font-semibold">By day</h3>
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                  <th className="px-4 py-2">Day (IST)</th>
                  <th className="px-3 py-2 text-right">Calls</th>
                  <th className="px-3 py-2 text-right">Replies</th>
                  <th className="px-3 py-2 text-right">p50</th>
                  <th className="px-3 py-2 text-right">p95</th>
                  <th className="px-3 py-2 text-right">Under target</th>
                  <th className="px-4 py-2 text-right">Stalls</th>
                </tr>
              </thead>
              <tbody>
                {data.byDay.map((r) => (
                  <tr key={r.day} className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td className="px-4 py-2">{r.day}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.calls}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.turns}</td>
                    <td className="px-3 py-2 text-right"><Gap v={r.total.p50} t={t} /></td>
                    <td className="px-3 py-2 text-right"><Gap v={r.total.p95} t={t} /></td>
                    <td className="px-3 py-2 text-right tabular-nums">{pct(r.underTarget, r.timedTurns)}</td>
                    <td className="px-4 py-2 text-right tabular-nums" style={r.stalls ? { color: 'var(--bad)' } : undefined}>{r.stalls}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="card overflow-x-auto p-0">
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4">
              <h3 className="font-semibold">Calls</h3>
              <span className="text-xs" style={{ color: 'var(--text-dim)' }}>Bar = typical reply split by stage. Open a call for every turn.</span>
            </div>
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                  <th className="px-4 py-2">When</th>
                  <th className="px-3 py-2">Customer</th>
                  <th className="px-3 py-2">Stack</th>
                  <th className="px-3 py-2 text-right">Replies</th>
                  <th className="px-3 py-2">Typical reply</th>
                  <th className="px-3 py-2 text-right">p50</th>
                  <th className="px-3 py-2 text-right">Max</th>
                  <th className="px-3 py-2 text-right">Pickup→word</th>
                  <th className="px-3 py-2 text-right">Network</th>
                  <th className="px-4 py-2 text-right">Stalls</th>
                </tr>
              </thead>
              <tbody>
                {data.calls.map((c) => (
                  <tr key={c.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td className="whitespace-nowrap px-4 py-2">
                      <Link href={`/ops/calls/${c.id}`} className="hover:underline">{fmtDateTime(c.startedAt)}</Link>
                    </td>
                    <td className="px-3 py-2">
                      {c.leadName ?? '—'}
                      <span className="block text-xs" style={{ color: 'var(--text-dim)' }}>{c.campaignName}</span>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {stackLabel(c.stack)}
                      {c.llmServed.length > 1 && <span className="block" style={{ color: 'var(--accent)' }}>fallback: {c.llmServed.join(', ')}</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{c.turns}</td>
                    <td className="w-40 px-3 py-2">
                      {c.eouP50 != null && <StageBar eou={c.eouP50} llm={c.llmP50 ?? 0} tts={c.ttsP50 ?? 0} />}
                    </td>
                    <td className="px-3 py-2 text-right"><Gap v={c.p50} t={t} /></td>
                    <td className="px-3 py-2 text-right"><Gap v={c.max} t={t} /></td>
                    <td className="px-3 py-2 text-right tabular-nums">{ms(c.greetingMs)}</td>
                    <td className="px-3 py-2 text-right text-xs tabular-nums" style={{ color: 'var(--text-dim)' }}>
                      {c.net.mediaRttMs != null || Object.keys(c.net.providers).length ? (
                        <>
                          {['stt', 'llm', 'tts'].filter((k) => c.net.providers[k] != null).map((k) => `${k} ${ms(c.net.providers[k])}`).join(' · ')}
                          {c.net.mediaRttMs != null && <span className="block">media {ms(c.net.mediaRttMs)}{c.net.lossPct != null ? ` · loss ${c.net.lossPct.toFixed(1)}%` : ''}</span>}
                        </>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums" style={c.stalls ? { color: 'var(--bad)' } : undefined}>
                      {c.stalls}
                      {c.stallGuardFires ? <span className="block text-xs" style={{ color: 'var(--text-dim)' }}>guard {c.stallGuardFires}×</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
