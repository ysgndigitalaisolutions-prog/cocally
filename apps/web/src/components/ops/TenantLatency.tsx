'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { LuActivity, LuArrowUpRight, LuChevronDown, LuChevronRight, LuLayers, LuNetwork, LuRefreshCw } from 'react-icons/lu';
import {
  Gap, gapTone, Legend, ms, RangeBar, StageBar, STAGE_COLORS, TONE_COLOR, TonePill, TOTAL_COLOR,
  type Dist, type Stage, type Targets, type Tone,
} from '@/components/ops/latency';
import { CallScatter, TrendChart } from '@/components/ops/latency-charts';
import { fmtDateTime, Segmented } from '@/components/ops/ui';
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

interface CallRow {
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
}

interface Provider {
  host: string;
  stage: string;
  rtt: Dist;
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
    providers: Provider[];
    media: { rtt: Dist; jitter: Dist; lossPct: Dist };
  };
  byDay: Array<Stats & { day: string; calls: number }>;
  calls: CallRow[];
}

type Range = 'today' | '7' | '30' | 'custom';
const RANGES: Array<[Range, string]> = [['today', 'Today'], ['7', '7 days'], ['30', '30 days'], ['custom', 'Custom']];

/** Below this many replies a row is too thin to call a winner on. */
const MIN_SAMPLE = 20;
const PAGE = 25;

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const stackLabel = (s: Stack) => `${s.stt} · ${s.llm} · ${s.tts}`;
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const STAGE_NAMES: Record<string, string> = { stt: 'Speech-to-text', llm: 'LLM', tts: 'Voice' };

/** The busiest host per stage, so one stage gets one round-trip figure. */
function providerFor(providers: Provider[], stage: string): Provider | undefined {
  return providers.filter((p) => p.stage === stage && p.rtt.p50 != null).sort((a, b) => b.rtt.n - a.rtt.n)[0];
}

/**
 * Per-tenant voice latency, laid out to answer three questions in order: is
 * the reply gap on target, which stage or network leg is holding it back, and
 * which provider stack does best. The calls behind the numbers come last.
 */
export default function TenantLatency({ tenantId }: { tenantId: string }) {
  const [range, setRange] = useState<Range>('7');
  const [custom, setCustom] = useState(() => ({ from: isoDay(new Date(Date.now() - 7 * 86_400_000)), to: isoDay(new Date()) }));
  const [campaignId, setCampaignId] = useState('');
  const [campaigns, setCampaigns] = useState<Array<{ id: string; name: string }>>([]);
  const [data, setData] = useState<Latency | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    opsApi.get<Array<{ id: string; name: string }>>(`/tenants/${tenantId}/campaigns`).then((r) => setCampaigns(r.data)).catch(() => setCampaigns([]));
  }, [tenantId]);

  const load = useCallback(async () => {
    let to = new Date();
    let from = new Date(to.getTime() - Number(range) * 86_400_000);
    if (range === 'today') from = new Date(new Date().setHours(0, 0, 0, 0));
    if (range === 'custom') {
      if (!custom.from || !custom.to || custom.from > custom.to) return;
      from = new Date(`${custom.from}T00:00:00`);
      to = new Date(new Date(`${custom.to}T00:00:00`).getTime() + 86_400_000);
    }
    const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    if (campaignId) params.set('campaignId', campaignId);
    setLoading(true);
    try {
      const r = await opsApi.get<Latency>(`/tenants/${tenantId}/latency?${params.toString()}`);
      setData(r.data);
      setError('');
    } catch (err) {
      setError(opsError(err, 'Could not load latency.'));
    } finally {
      setLoading(false);
    }
  }, [tenantId, range, custom, campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label="Date range" value={range} options={RANGES} onChange={setRange} />
        {range === 'custom' && (
          <span className="flex items-center gap-1.5 text-xs text-dim">
            <input type="date" aria-label="From" className="input !w-auto !py-1 text-xs" value={custom.from} max={custom.to} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
            to
            <input type="date" aria-label="To" className="input !w-auto !py-1 text-xs" value={custom.to} min={custom.from} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
          </span>
        )}
        {campaigns.length > 0 && (
          <select aria-label="Campaign" className="input !w-auto !py-1 text-xs" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
            <option value="">All campaigns</option>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <button className="btn btn-ghost flex items-center gap-1.5 !px-3 !py-1 text-xs" onClick={() => void load()} disabled={loading}>
          <LuRefreshCw aria-hidden className={loading ? 'animate-spin' : undefined} /> Refresh
        </button>
        {data?.truncated && <span className="text-xs text-dim">Showing the newest 1,000 calls in this range.</span>}
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}

      {!data ? (
        !error && <p className="text-dim">Loading…</p>
      ) : data.summary.turns === 0 && data.summary.calls === 0 ? (
        <p className="card p-8 text-center text-sm text-dim">No AI calls with timing data in this range.</p>
      ) : (
        <div className="space-y-5 transition-opacity" style={{ opacity: loading ? 0.55 : 1 }}>
          <Report data={data} />
        </div>
      )}
    </div>
  );
}

function Report({ data }: { data: Latency }) {
  const s = data.summary;
  const t = data.targets;
  return (
    <>
      <Verdict data={data} />

      <div className="grid gap-5 xl:grid-cols-5">
        <StageBreakdown data={data} />
        <NetworkPath data={data} />
      </div>

      <Compare data={data} />

      <div className={`grid gap-5 ${data.byDay.length > 1 ? 'xl:grid-cols-2' : ''}`}>
        {data.byDay.length > 1 && (
          <Card title="Day by day" hint="Is it getting better or worse?">
            <div className="px-5 pb-4">
              <TrendChart days={data.byDay} targets={t} />
            </div>
            <Disclosure label="Show as a table">
              <Table head={['Day (India)', 'Calls', 'Replies', 'Typical', 'Worst 5%', 'Under target', 'Stalls']}>
                {data.byDay.map((r) => (
                  <tr key={r.day} className="border-t border-border">
                    <td className="px-5 py-2">{r.day}</td>
                    <Num>{r.calls}</Num>
                    <Num>{r.turns}</Num>
                    <Num><Gap v={r.total.p50} t={t} /></Num>
                    <Num><Gap v={r.total.p95} t={t} /></Num>
                    <Num>{pct(r.underTarget, r.timedTurns)}</Num>
                    <Num last>{r.stalls}</Num>
                  </tr>
                ))}
              </Table>
            </Disclosure>
          </Card>
        )}
        <Card title="By time of day" hint="One dot per call. Slow dots bunched at one hour point to load, not the stack.">
          <div className="px-5 pb-5">
            <CallScatter
              targets={t}
              calls={data.calls.map((c) => ({ id: c.id, startedAt: c.startedAt, label: c.leadName ?? c.campaignName, p50: c.p50, max: c.max, turns: c.turns, stalls: c.stalls }))}
            />
          </div>
        </Card>
      </div>

      <Calls calls={data.calls} t={t} />

      <p className="text-xs text-dim">
        Measured on the server: {s.turns} replies over {s.calls} calls. {s.untimedTurns > 0 && `${s.untimedTurns} replies had no timed end of speech, so they count towards LLM and voice times but not the gap. `}
        The caller also hears the phone network&apos;s own delay on top, which cannot be measured from here.
      </p>
    </>
  );
}

// ── Verdict ──────────────────────────────────────────────────────────────

function Verdict({ data }: { data: Latency }) {
  const s = data.summary;
  const t = data.targets;
  const tone = gapTone(s.total.p50, t);
  const over = s.total.p50 != null ? s.total.p50 - t.goodMs : null;

  const stages = ([['eou', s.eou.p50], ['llm', s.llm.p50], ['tts', s.tts.p50]] as Array<[Stage, number | null]>).filter((x): x is [Stage, number] => x[1] != null);
  const top = [...stages].sort((a, b) => b[1] - a[1])[0];
  const stageText: Record<Stage, string> = {
    eou: 'Deciding the customer has finished is the largest stage',
    llm: 'The LLM’s first token is the largest stage',
    tts: 'The voice’s first audio is the largest stage',
  };

  const legs = data.network.providers.filter((p) => p.rtt.p50 != null).sort((a, b) => (b.rtt.p50 ?? 0) - (a.rtt.p50 ?? 0));
  const leg = legs[0];
  const legStage = leg ? ({ stt: s.stt.p50, llm: s.llm.p50, tts: s.tts.p50 } as Record<string, number | null>)[leg.stage] : null;
  const share = leg?.rtt.p50 != null && legStage ? leg.rtt.p50 / legStage : null;

  return (
    <section className="card grid gap-6 p-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-8">
      <div className="flex flex-col justify-between gap-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-dim">Typical reply gap</p>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <p className="text-5xl font-bold leading-none">{ms(s.total.p50)}</p>
            {tone && <TonePill tone={tone} />}
          </div>
          <p className="mt-2 text-sm text-dim">
            {over == null
              ? 'No reply in this range had a timed gap.'
              : over <= 0
                ? `${ms(-over)} inside the ${ms(t.goodMs)} target.`
                : `${ms(over)} over the ${ms(t.goodMs)} target.`}
            {' '}Customer stops talking → AI&apos;s first audio, over {s.timedTurns} timed replies.
          </p>
        </div>
        <GapMeter p50={s.total.p50} p95={s.total.p95} t={t} />
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Metric label="Worst 5%" value={<Gap v={s.total.p95} t={t} />} hint={`longest ${ms(s.total.max)}`} />
          <Metric label="Under target" value={pct(s.underTarget, s.timedTurns)} hint={`${s.slow} slow`} />
          <Metric label="Stalls" value={<Flag n={s.stalls} />} hint={`guard fired ${s.stallGuardFires}×`} />
          <Metric label="Pickup → first word" value={ms(s.greeting.p50)} hint={s.greeting.n ? `worst 5% ${ms(s.greeting.p95)}` : 'no data yet'} />
        </dl>
      </div>

      <div className="space-y-4 border-border lg:border-l lg:pl-8">
        <p className="text-xs font-semibold uppercase tracking-wide text-dim">What is holding it back</p>
        <Finding icon={<LuLayers aria-hidden />} title={top ? `${stageText[top[0]]}: ${ms(top[1])}` : 'No stage timings in this range'}>
          {top?.[0] === 'eou' && s.stt.p50 != null && `${ms(s.stt.p50)} of that is waiting for the final transcript from speech-to-text. `}
          {stages.filter(([k]) => k !== top?.[0]).map(([k, v]) => `${k === 'eou' ? 'End of turn' : k === 'llm' ? 'LLM' : 'Voice'} ${ms(v)}`).join(', ')}
          {stages.length > 1 && ' typical.'}
        </Finding>
        <Finding
          icon={<LuNetwork aria-hidden />}
          title={leg ? `Furthest provider: ${STAGE_NAMES[leg.stage] ?? leg.stage}, ${ms(leg.rtt.p50)} per round trip` : 'No network measurements in this range'}
        >
          {leg ? (
            <>
              <span className="font-mono">{leg.host}</span>.{' '}
              {share == null
                ? ''
                : share >= 0.3
                  ? `That is about ${Math.round(share * 100)}% of the stage’s typical time, so distance is a real part of it.`
                  : `That is about ${Math.round(share * 100)}% of the stage’s typical time, so the provider’s own speed matters more than distance.`}
            </>
          ) : (
            'Calls before 29 Sep did not record round trips.'
          )}
        </Finding>
        <Finding
          icon={<LuActivity aria-hidden />}
          tone={s.stalls ? 'stall' : s.slow ? 'slow' : 'good'}
          title={s.stalls ? `${s.stalls} ${s.stalls === 1 ? 'reply' : 'replies'} stalled past ${ms(t.stallMs)}` : s.slow ? `No stalls, ${s.slow} slow ${s.slow === 1 ? 'reply' : 'replies'}` : 'No stalls or slow replies'}
        >
          {s.stalls > 0 && `${pct(s.stalls, s.timedTurns)} of timed replies. Speech-to-text never gave a final transcript. `}
          {s.stallGuardFires > 0 ? `The stall guard forced a turn ${s.stallGuardFires}×. ` : ''}
          {s.transfers.n > 0 && `Transfers: ${s.transfers.bridged} of ${s.transfers.n} connected, typical wait ${ms(s.transfers.wait.p50)}.`}
        </Finding>
      </div>
    </section>
  );
}

/** The gap on a ruler: target zones underneath, the typical and worst-5% replies on top. */
function GapMeter({ p50, p95, t }: { p50: number | null; p95: number | null; t: Targets }) {
  const scale = Math.min(t.stallMs * 1.2, Math.max(t.slowMs * 1.6, (p95 ?? 0) * 1.15));
  const pos = (v: number) => `${Math.min(100, (v / scale) * 100)}%`;
  const zones: Array<[Tone, number, number]> = [['good', 0, t.goodMs], ['ok', t.goodMs, t.slowMs], ['slow', t.slowMs, Math.min(scale, t.stallMs)]];
  if (scale > t.stallMs) zones.push(['stall', t.stallMs, scale]);
  return (
    <div role="img" aria-label={`Typical gap ${ms(p50)}, worst 5% ${ms(p95)}, target ${ms(t.goodMs)}`}>
      <div className="relative h-8">
        {p95 != null && <Marker at={pos(p95)} label={`worst 5% ${p95 > scale ? '›' : ''}`} hollow />}
        {p50 != null && <Marker at={pos(p50)} label="typical" />}
      </div>
      <div className="flex h-1.5 gap-[2px] overflow-hidden rounded-full">
        {zones.map(([tone, a, b]) => (
          <div key={tone} style={{ width: `${((b - a) / scale) * 100}%`, background: TONE_COLOR[tone], opacity: tone === 'ok' ? 0.35 : 0.75 }} />
        ))}
      </div>
      <div className="relative mt-1 h-4 text-[10px] text-dim">
        <span className="absolute left-0">0</span>
        <span className="absolute -translate-x-1/2" style={{ left: pos(t.goodMs) }}>{ms(t.goodMs)}</span>
        <span className="absolute -translate-x-1/2" style={{ left: pos(t.slowMs) }}>{ms(t.slowMs)}</span>
        {scale > t.stallMs && <span className="absolute -translate-x-1/2" style={{ left: pos(t.stallMs) }}>{ms(t.stallMs)}</span>}
      </div>
    </div>
  );
}

function Marker({ at, label, hollow }: { at: string; label: string; hollow?: boolean }) {
  return (
    <div className="absolute bottom-0 flex -translate-x-1/2 flex-col items-center" style={{ left: at }}>
      <span className="whitespace-nowrap text-[10px] text-dim">{label}</span>
      <span className="mt-0.5 h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: 'var(--text)', background: hollow ? 'var(--surface)' : 'var(--text)' }} />
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div>
      <dt className="text-xs text-dim">{label}</dt>
      <dd className="text-lg font-semibold">{value}</dd>
      {hint && <dd className="text-xs text-dim">{hint}</dd>}
    </div>
  );
}

function Flag({ n }: { n: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {n > 0 && <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-bad" />}
      {n}
    </span>
  );
}

function Finding({ icon, title, tone, children }: { icon: React.ReactNode; title: string; tone?: Tone; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2" style={{ color: tone ? TONE_COLOR[tone] : 'var(--text-dim)' }}>{icon}</span>
      <div className="min-w-0">
        <p className="font-semibold">{title}</p>
        <p className="text-sm text-dim">{children}</p>
      </div>
    </div>
  );
}

// ── Stages and network ───────────────────────────────────────────────────

function StageBreakdown({ data }: { data: Latency }) {
  const s = data.summary;
  const t = data.targets;
  const net = (stage: string) => providerFor(data.network.providers, stage)?.rtt.p50 ?? null;
  const rows: Array<{ key: string; label: string; sub: string; d: Dist; color: string; mark: number | null; nested?: boolean }> = [
    { key: 'eou', label: 'End of turn', sub: 'customer stops → turn decided', d: s.eou, color: STAGE_COLORS.eou, mark: null },
    { key: 'stt', label: 'of which speech-to-text', sub: 'waiting for the final transcript', d: s.stt, color: STAGE_COLORS.eou, mark: net('stt'), nested: true },
    { key: 'llm', label: 'LLM first token', sub: 'turn decided → first word written', d: s.llm, color: STAGE_COLORS.llm, mark: net('llm') },
    { key: 'tts', label: 'Voice first audio', sub: 'first word → first sound', d: s.tts, color: STAGE_COLORS.tts, mark: net('tts') },
  ];
  const scale = Math.max(500, ...rows.map((r) => r.d.p95 ?? r.d.p50 ?? 0)) * 1.05;
  return (
    <Card className="xl:col-span-3" title="Where the time goes" hint="Bar = typical reply, thin line = worst 5%. The darker start of a bar is one network round trip to that provider.">
      <div className="space-y-4 px-5 pb-4">
        {rows.map((r) => (
          <div key={r.key} className={`grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto] items-center gap-x-4 ${r.nested ? 'pl-4' : ''}`}>
            <div className="min-w-0">
              <p className={r.nested ? 'text-sm text-dim' : 'text-sm font-semibold'}>{r.label}</p>
              <p className="truncate text-xs text-dim">{r.sub}</p>
            </div>
            <RangeBar p50={r.d.p50} p95={r.d.p95} scaleMs={scale} color={r.color} mark={r.mark} faded={r.nested} />
            <p className="w-32 text-right text-sm tabular-nums">
              <span className="font-semibold">{ms(r.d.p50)}</span>
              <span className="text-dim"> · {ms(r.d.p95)}</span>
            </p>
          </div>
        ))}
        <p className="text-xs text-dim">Stages overlap a little, so their percentiles do not add up to the gap.</p>
      </div>
      <Disclosure label="All percentiles">
        <Table head={['Stage', 'p50', 'p90', 'p95', 'Longest', 'Samples']}>
          {([
            ['End of turn', s.eou], ['of which speech-to-text', s.stt], ['LLM first token', s.llm], ['Voice first audio', s.tts],
            ['Whole turn gap', s.total], ['Pickup → first AI word', s.greeting], ['Answering-machine decision', s.amd], ['Worker join → answer (mostly ringing)', s.answerDetect],
          ] as Array<[string, Dist]>).map(([label, d]) => (
            <tr key={label} className="border-t border-border">
              <td className="px-5 py-2">{label}</td>
              {(['p50', 'p90', 'p95', 'max'] as const).map((k) => (
                <Num key={k}>{label === 'Whole turn gap' ? <Gap v={d[k]} t={t} /> : ms(d[k])}</Num>
              ))}
              <Num last dim>{d.n}</Num>
            </tr>
          ))}
        </Table>
      </Disclosure>
    </Card>
  );
}

/** The audio's route drawn top to bottom, with the unmeasured phone leg shown as unmeasured. */
function NetworkPath({ data }: { data: Latency }) {
  const { providers, media } = data.network;
  const measured = providers.length > 0 || media.rtt.n > 0;
  return (
    <Card className="xl:col-span-2" title="Network path" hint="Measured from the AI worker, once per call.">
      <div className="px-5 pb-5">
        {!measured ? (
          <p className="text-sm text-dim">No network measurements in this range. Calls before 29 Sep did not record them.</p>
        ) : (
          <>
            <ol>
              <Hop name="Customer’s phone" />
              <Leg label="Phone ↔ carrier ↔ LiveKit" value="not measured" unmeasured />
              <Hop name="LiveKit media server" />
              <Leg label="Media round trip" value={ms(media.rtt.p50)} hint={media.rtt.n ? `worst 5% ${ms(media.rtt.p95)}` : undefined} />
              <Hop name="AI worker" />
              {providers.map((p, i) => (
                <li key={p.host} className="flex items-stretch gap-3">
                  <span className="relative w-3 shrink-0">
                    <span className={`absolute left-1/2 top-0 w-px -translate-x-1/2 bg-border ${i === providers.length - 1 ? 'h-1/2' : 'h-full'}`} />
                    <span className="absolute left-1/2 top-1/2 h-px w-3 bg-border" />
                  </span>
                  <div className="flex min-w-0 flex-1 items-center justify-between gap-3 py-1.5 pl-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: p.stage === 'stt' ? STAGE_COLORS.eou : p.stage === 'llm' ? STAGE_COLORS.llm : STAGE_COLORS.tts }} />
                      <span className="min-w-0">
                        <span className="block text-sm">{STAGE_NAMES[p.stage] ?? p.stage}</span>
                        <span className="block truncate font-mono text-xs text-dim" title={p.host}>{p.host}</span>
                      </span>
                    </span>
                    <span className="shrink-0 text-right text-sm tabular-nums">
                      <span className="font-semibold">{ms(p.rtt.p50)}</span>
                      <span className="block text-xs text-dim">worst 5% {ms(p.rtt.p95)}</span>
                    </span>
                  </div>
                </li>
              ))}
            </ol>
            <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-border pt-4">
              <Metric label="Customer audio jitter" value={ms(media.jitter.p50)} hint={media.jitter.n ? `worst 5% ${ms(media.jitter.p95)}` : 'no data yet'} />
              <Metric label="Customer packet loss" value={media.lossPct.p50 == null ? '—' : `${media.lossPct.p50.toFixed(1)}%`} hint={media.lossPct.max == null ? 'no data yet' : `highest ${media.lossPct.max.toFixed(1)}%`} />
            </dl>
          </>
        )}
      </div>
    </Card>
  );
}

function Hop({ name }: { name: string }) {
  return (
    <li className="flex items-center gap-3">
      <span className="flex w-3 shrink-0 justify-center"><span className="h-3 w-3 rounded-full border-2 border-dim bg-surface" /></span>
      <span className="text-sm font-semibold">{name}</span>
    </li>
  );
}

function Leg({ label, value, hint, unmeasured }: { label: string; value: string; hint?: string; unmeasured?: boolean }) {
  return (
    <li className="flex items-stretch gap-3">
      <span className="flex w-3 shrink-0 justify-center">
        <span className={`w-px ${unmeasured ? 'border-l border-dashed border-dim' : 'bg-border'}`} />
      </span>
      <div className="flex flex-1 items-center justify-between gap-3 py-2.5 pl-2 text-sm">
        <span className="text-dim">{label}</span>
        <span className="text-right tabular-nums">
          <span className={unmeasured ? 'text-dim' : 'font-semibold'}>{value}</span>
          {hint && <span className="block text-xs text-dim">{hint}</span>}
        </span>
      </div>
    </li>
  );
}

// ── Comparison ───────────────────────────────────────────────────────────

type CompareBy = 'stack' | 'llm' | 'voice';

function Compare({ data }: { data: Latency }) {
  const [by, setBy] = useState<CompareBy>('stack');
  const t = data.targets;
  const view = {
    stack: {
      hint: 'Speech-to-text · LLM · voice as configured on the call. Measured on the whole reply gap.',
      color: TOTAL_COLOR,
      rows: data.byStack.map((r) => ({ name: stackLabel(r.stack), n: r.turns, sub: `${r.calls} calls`, d: r.total, stalls: r.stalls as number | null })),
    },
    llm: {
      hint: 'The model that actually answered each reply. A fallback model here means the first choice was slow or failing.',
      color: STAGE_COLORS.llm,
      rows: data.byModel.map((r) => ({ name: r.model, n: r.turns, sub: `gap ${ms(r.total.p50)}`, d: r.llm, stalls: null })),
    },
    voice: {
      hint: 'The voice model that actually spoke each reply, measured to its first audio.',
      color: STAGE_COLORS.tts,
      rows: data.byVoice.map((r) => ({ name: r.model, n: r.turns, sub: '', d: r.tts, stalls: null })),
    },
  }[by];
  const scale = Math.max(500, ...view.rows.map((r) => r.d.p95 ?? r.d.p50 ?? 0)) * 1.05;
  const ranked = view.rows.filter((r) => r.n >= MIN_SAMPLE && r.d.p50 != null).sort((a, b) => (a.d.p50 ?? 0) - (b.d.p50 ?? 0));
  const fastest = ranked.length > 1 ? ranked[0].name : null;
  return (
    <Card
      title="Compare"
      hint={view.hint}
      action={<Segmented label="Compare by" value={by} options={[['stack', 'Provider stack'], ['llm', 'LLM'], ['voice', 'Voice']]} onChange={setBy} />}
    >
      <div className="px-5 pb-5">
        <div className="grid grid-cols-[minmax(0,18rem)_minmax(0,1fr)_auto] gap-x-4 border-b border-border pb-2 text-xs uppercase tracking-wide text-dim">
          <span>{by === 'stack' ? 'Stack' : 'Model'}</span>
          <span>{by === 'stack' ? 'Reply gap' : by === 'llm' ? 'First token' : 'First audio'}</span>
          <span className="w-44 text-right">Typical · worst 5%{by === 'stack' ? ' · stalls' : ''}</span>
        </div>
        {view.rows.map((r) => (
          <div key={r.name} className="grid grid-cols-[minmax(0,18rem)_minmax(0,1fr)_auto] items-center gap-x-4 border-b border-border py-3 last:border-0 last:pb-0">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2">
                <span className="truncate font-mono text-xs" title={r.name}>{r.name}</span>
                {r.name === fastest && <TonePill tone="good" text="Fastest" />}
              </p>
              <p className="text-xs text-dim">
                {r.n} replies{r.sub ? ` · ${r.sub}` : ''}{r.n < MIN_SAMPLE ? ' · too few to judge' : ''}
              </p>
            </div>
            <div style={{ opacity: r.n < MIN_SAMPLE ? 0.5 : 1 }}>
              <RangeBar p50={r.d.p50} p95={r.d.p95} scaleMs={scale} color={view.color} />
            </div>
            <p className="flex w-44 items-center justify-end gap-1.5 text-sm tabular-nums">
              {by === 'stack' ? <Gap v={r.d.p50} t={t} strong /> : <span className="font-semibold">{ms(r.d.p50)}</span>}
              <span className="text-dim">· {ms(r.d.p95)}</span>
              {r.stalls != null && <span className="text-dim">· <Flag n={r.stalls} /></span>}
            </p>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ── Calls ────────────────────────────────────────────────────────────────

type CallFilter = 'all' | 'problem' | 'fallback';

function Calls({ calls, t }: { calls: CallRow[]; t: Targets }) {
  const [filter, setFilter] = useState<CallFilter>('all');
  const [sort, setSort] = useState<'newest' | 'slowest'>('newest');
  const [open, setOpen] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);

  const rows = useMemo(() => {
    const kept = calls.filter((c) => (filter === 'problem' ? c.stalls > 0 || c.slow > 0 : filter === 'fallback' ? c.llmServed.length > 1 : true));
    return sort === 'slowest' ? [...kept].sort((a, b) => (b.p50 ?? -1) - (a.p50 ?? -1)) : kept;
  }, [calls, filter, sort]);

  return (
    <Card
      title="Calls"
      hint="Newest 200 in this range. Open a row for its stack and network, or the call for every turn."
      action={
        <span className="flex flex-wrap items-center gap-2">
          <Segmented label="Show" value={filter} options={[['all', 'All'], ['problem', 'Slow or stalled'], ['fallback', 'Used a fallback']]} onChange={(v) => { setFilter(v); setShown(PAGE); }} />
          <Segmented label="Order" value={sort} options={[['newest', 'Newest'], ['slowest', 'Slowest']]} onChange={setSort} />
        </span>
      }
    >
      <div className="flex justify-end px-5 pb-2"><Legend /></div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-dim">
              <th className="py-2 pl-5 pr-3 font-medium">Call</th>
              <th className="px-3 py-2 text-right font-medium">Replies</th>
              <th className="px-3 py-2 font-medium">Typical reply</th>
              <th className="px-3 py-2 text-right font-medium">Longest</th>
              <th className="px-3 py-2 font-medium">Flags</th>
              <th className="py-2 pl-3 pr-5" />
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((c) => (
              <Fragment key={c.id}>
                <tr className="cursor-pointer border-t border-border hover:bg-surface-2" onClick={() => setOpen(open === c.id ? null : c.id)}>
                  <td className="py-2.5 pl-5 pr-3">
                    <button className="flex cursor-pointer items-center gap-2 text-left" aria-expanded={open === c.id}>
                      {open === c.id ? <LuChevronDown aria-hidden className="shrink-0 text-dim" /> : <LuChevronRight aria-hidden className="shrink-0 text-dim" />}
                      <span>
                        <span className="block">{c.leadName ?? 'Customer'}</span>
                        <span className="block text-xs text-dim">{fmtDateTime(c.startedAt)} · {c.campaignName}</span>
                      </span>
                    </button>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{c.turns}</td>
                  <td className="px-3 py-2.5">
                    <span className="flex items-center gap-3">
                      <span className="w-36 shrink-0">
                        {c.p50 != null && <StageBar eou={c.eouP50 ?? 0} llm={c.llmP50 ?? 0} tts={c.ttsP50 ?? 0} total={c.p50} />}
                      </span>
                      <Gap v={c.p50} t={t} strong />
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right"><Gap v={c.max} t={t} /></td>
                  <td className="px-3 py-2.5">
                    <span className="flex flex-wrap gap-1.5">
                      {c.stalls > 0 && <TonePill tone="stall" text={`${c.stalls} stall${c.stalls > 1 ? 's' : ''}`} />}
                      {c.stallGuardFires > 0 && <TonePill tone="slow" text={`guard ${c.stallGuardFires}×`} />}
                      {c.llmServed.length > 1 && <TonePill tone="slow" text="fallback" />}
                      {(c.net.lossPct ?? 0) >= 1 && <TonePill tone="slow" text={`loss ${c.net.lossPct!.toFixed(1)}%`} />}
                    </span>
                  </td>
                  <td className="py-2.5 pl-3 pr-5 text-right">
                    <Link href={`/ops/calls/${c.id}`} className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-dim hover:text-text" onClick={(e) => e.stopPropagation()}>
                      Open <LuArrowUpRight aria-hidden />
                    </Link>
                  </td>
                </tr>
                {open === c.id && (
                  <tr className="bg-surface-2">
                    <td colSpan={6} className="px-5 py-4 pl-12">
                      <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                        <Detail label="Stack">{stackLabel(c.stack)}</Detail>
                        <Detail label="LLM that answered">{c.llmServed.length ? c.llmServed.join(', ') : '—'}</Detail>
                        <Detail label="Stages, typical">end of turn {ms(c.eouP50)} · LLM {ms(c.llmP50)} · voice {ms(c.ttsP50)}</Detail>
                        <Detail label="Pickup → first word">{ms(c.greetingMs)}{c.amdLatencyMs != null ? ` · answer detected in ${ms(c.amdLatencyMs)}` : ''}</Detail>
                        <Detail label="Round trip to providers">
                          {['stt', 'llm', 'tts'].some((k) => c.net.providers[k] != null)
                            ? ['stt', 'llm', 'tts'].filter((k) => c.net.providers[k] != null).map((k) => `${STAGE_NAMES[k]} ${ms(c.net.providers[k])}`).join(' · ')
                            : '—'}
                        </Detail>
                        <Detail label="Media round trip">{ms(c.net.mediaRttMs)}</Detail>
                        <Detail label="Customer audio">{c.net.jitterMaxMs != null ? `jitter up to ${ms(c.net.jitterMaxMs)}` : '—'}{c.net.lossPct != null ? ` · loss ${c.net.lossPct.toFixed(1)}%` : ''}</Detail>
                        <Detail label="Replies">{c.turns} · {c.slow} slow · {c.untimedTurns} not timed</Detail>
                      </dl>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6} className="border-t border-border px-5 py-8 text-center text-dim">No calls match this filter.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {rows.length > shown && (
        <div className="border-t border-border px-5 py-3 text-center">
          <button className="btn btn-ghost !py-1 text-xs" onClick={() => setShown(shown + PAGE)}>Show {Math.min(PAGE, rows.length - shown)} more of {rows.length - shown}</button>
        </div>
      )}
    </Card>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-dim">{label}</dt>
      <dd className="break-words tabular-nums">{children}</dd>
    </div>
  );
}

// ── Layout pieces ────────────────────────────────────────────────────────

function Card({ title, hint, action, className, children }: { title: string; hint?: string; action?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <section className={`card overflow-hidden ${className ?? ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pb-4 pt-5">
        <div className="min-w-0">
          <h3 className="font-semibold">{title}</h3>
          {hint && <p className="max-w-2xl text-xs text-dim">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Disclosure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details className="group border-t border-border">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-5 py-2.5 text-xs text-dim hover:text-text">
        <LuChevronRight aria-hidden className="transition-transform group-open:rotate-90" /> {label}
      </summary>
      <div className="overflow-x-auto pb-2">{children}</div>
    </details>
  );
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs uppercase tracking-wide text-dim">
          {head.map((h, i) => (
            <th key={h} className={`py-2 font-medium ${i === 0 ? 'px-5 text-left' : i === head.length - 1 ? 'pl-3 pr-5 text-right' : 'px-3 text-right'}`}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

function Num({ children, last, dim }: { children: React.ReactNode; last?: boolean; dim?: boolean }) {
  return <td className={`py-2 text-right tabular-nums ${last ? 'pl-3 pr-5' : 'px-3'} ${dim ? 'text-dim' : ''}`}>{children}</td>;
}
