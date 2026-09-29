'use client';

import { useMemo, useState } from 'react';
import { Gap, gapTone, Legend, ms, StageBar, TONE_COLOR, type Targets } from '@/components/ops/latency';
import { secs, Segmented } from '@/components/ops/ui';

export interface TurnMetric {
  at: string;
  eou: number;
  stt: number;
  llm: number;
  tts: number;
  total: number;
  llmServed?: string;
  ttsServed?: string;
  promptTokens?: number;
  reply: boolean;
}

export interface CallEvent {
  at: string;
  kind: string;
  ms?: number;
  detail?: string;
  host?: string;
  stage?: string;
  jitterMs?: number;
  lossPct?: number;
}

export interface TranscriptLine {
  speaker: string;
  leg: string;
  atMs: number;
  text: string;
}

interface Props {
  startedAt: string;
  transcript: TranscriptLine[];
  redacted: boolean;
  onUnredact: () => void;
  turns: TurnMetric[];
  events: CallEvent[];
  providersUsed: Record<string, string>;
  targets: Targets;
}

const EVENT_LABELS: Record<string, string> = {
  answered: 'Worker heard the pickup',
  greeting: 'Pickup → first AI word',
  stall_guard: 'Stall guard forced a turn',
  transfer: 'Transfer',
  llm_fallback: 'LLM fallback',
};

/** A turn's timing belongs to the AI line spoken within this long of it. */
const MATCH_WINDOW_MS = 6000;

type Item =
  | { kind: 'line'; at: number; line: TranscriptLine; turn?: TurnMetric }
  | { kind: 'turn'; at: number; turn: TurnMetric }
  | { kind: 'event'; at: number; event: CallEvent };

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * The call as it was heard: each customer line, how long the AI took to
 * answer and where that time went, then the AI's line. Stalls and worker
 * events sit in place, so a bad moment is visible where it happened.
 */
export default function CallConversation({ startedAt, transcript, redacted, onUnredact, turns, events, providersUsed: pu, targets: t }: Props) {
  const [view, setView] = useState<'talk' | 'table'>('talk');
  const started = new Date(startedAt).getTime();
  const offset = (iso: string) => Math.max(0, new Date(iso).getTime() - started);

  const items = useMemo(() => {
    const lines = transcript.map((line) => ({ kind: 'line' as const, at: line.atMs, line, turn: undefined as TurnMetric | undefined }));
    const loose: Item[] = [];
    for (const turn of turns) {
      const at = Math.max(0, new Date(turn.at).getTime() - started);
      const match = lines
        .filter((l) => l.line.speaker === 'ai' && !l.turn && Math.abs(l.at - at) <= MATCH_WINDOW_MS)
        .sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0];
      if (match) match.turn = turn;
      else loose.push({ kind: 'turn', at, turn });
    }
    const marks: Item[] = events
      .filter((e) => e.kind !== 'net_provider' && e.kind !== 'net_media')
      .map((event) => ({ kind: 'event', at: Math.max(0, new Date(event.at).getTime() - started), event }));
    return [...lines, ...loose, ...marks].sort((a, b) => a.at - b.at);
  }, [transcript, turns, events, started]);

  const timed = turns.filter((x) => x.reply).map((x) => x.total);
  const stalls = timed.filter((v) => v > t.stallMs).length;
  const providers = events.filter((e) => e.kind === 'net_provider');
  const media = events.filter((e) => e.kind === 'net_media');
  const lastLoss = [...media].reverse().find((e) => e.lossPct != null)?.lossPct;
  const hasTimings = turns.length > 0;

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
        <div>
          <h2 className="font-semibold">Conversation</h2>
          <p className="text-xs text-dim">
            {hasTimings
              ? `Each reply shows the gap the customer waited: they stop talking → AI’s first audio. Target ${ms(t.goodMs)}, slow over ${ms(t.slowMs)}, stall over ${ms(t.stallMs)}.`
              : 'This call has no voice timings.'}
          </p>
        </div>
        <span className="flex flex-wrap items-center gap-2">
          {hasTimings && <Segmented label="View" value={view} options={[['talk', 'Conversation'], ['table', 'Timing table']]} onChange={setView} />}
          {redacted ? (
            <button
              className="btn btn-ghost !px-3 !py-1 text-xs"
              onClick={() => {
                if (window.confirm('Show the transcript with personal details? This is recorded in the audit log.')) onUnredact();
              }}
            >
              Show unredacted
            </button>
          ) : (
            <span className="text-xs text-accent">Unredacted, audited</span>
          )}
        </span>
      </div>

      {hasTimings && (
        <div className="mx-5 mt-4 grid gap-x-8 gap-y-3 rounded-lg bg-surface-2 px-4 py-3 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Typical reply"><Gap v={median(timed)} t={t} strong /></Fact>
          <Fact label="Longest reply"><Gap v={timed.length ? Math.max(...timed) : null} t={t} strong /></Fact>
          <Fact label="Replies">
            <span className="font-semibold">{turns.length}</span>
            <span className="text-dim"> · {stalls} stalled · {turns.length - timed.length} not timed</span>
          </Fact>
          <Fact label="Stack"><span className="font-mono text-xs">{pu.stt ?? 'nova'} · {pu.llm ?? '—'} · {pu.tts ?? '—'}</span></Fact>
          {(providers.length > 0 || media.length > 0) && (
            <div className="border-t border-border pt-3 text-xs text-dim sm:col-span-2 lg:col-span-4">
              <span className="font-semibold text-text">Network from the worker </span>
              {providers.map((e) => `${(e.stage ?? '').toUpperCase()} ${ms(e.ms)}`).join(' · ')}
              {media.length > 0 && `${providers.length ? ' · ' : ''}media ${ms(median(media.flatMap((e) => (e.ms != null ? [e.ms] : []))))}`}
              {media.some((e) => e.jitterMs != null) && ` · jitter up to ${ms(Math.max(...media.map((e) => e.jitterMs ?? 0)))}`}
              {lastLoss != null && ` · loss ${lastLoss.toFixed(1)}%`}
              . The phone ↔ carrier leg is not measured.
            </div>
          )}
        </div>
      )}

      {view === 'table' && hasTimings ? (
        <TimingTable turns={turns} t={t} pu={pu} at={(iso) => secs(offset(iso) / 1000)} />
      ) : items.length === 0 ? (
        <p className="p-5 text-sm text-dim">No transcript.</p>
      ) : (
        <>
          {hasTimings && <div className="flex justify-end px-5 pt-4"><Legend /></div>}
          <ol className="space-y-1 px-5 pb-5 pt-3 text-sm">
            {items.map((item, i) => (
              <li key={i}>
                {item.kind === 'event' && <EventMark at={item.at} event={item.event} />}
                {item.kind === 'turn' && <ReplyGap turn={item.turn} t={t} pu={pu} />}
                {item.kind === 'line' && (
                  <>
                    {item.turn && <ReplyGap turn={item.turn} t={t} pu={pu} />}
                    <div className="flex gap-3 py-1">
                      <span className="w-10 shrink-0 pt-0.5 text-right font-mono text-xs tabular-nums text-dim">{secs(item.at / 1000)}</span>
                      <span className={`w-20 shrink-0 pt-0.5 text-xs font-semibold uppercase ${item.line.speaker === 'customer' ? 'text-text' : 'text-dim'}`}>
                        {item.line.speaker === 'ai' ? 'AI' : item.line.speaker}
                      </span>
                      <span className={item.line.speaker === 'customer' ? undefined : 'text-dim'}>{item.line.text}</span>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 text-sm">
      <p className="text-xs text-dim">{label}</p>
      <p className="tabular-nums">{children}</p>
    </div>
  );
}

/** The wait before an AI line: how long, and which stage it went on. */
function ReplyGap({ turn: x, t, pu }: { turn: TurnMetric; t: Targets; pu: Record<string, string> }) {
  const tone = x.reply ? gapTone(x.total, t) : undefined;
  const bad = tone === 'slow' || tone === 'stall';
  return (
    <div
      className="my-1 ml-[3.25rem] flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border-l-2 py-1.5 pl-3 pr-2 text-xs"
      style={{ borderColor: tone ? TONE_COLOR[tone] : 'var(--border)', background: bad ? 'var(--surface-2)' : undefined }}
      title={`${pu.stt ?? 'nova'} · ${x.llmServed ?? pu.llm ?? '—'} · ${x.ttsServed ?? pu.tts ?? '—'}${x.promptTokens ? ` · ${x.promptTokens} prompt tokens` : ''}`}
    >
      <span className="w-24 shrink-0">
        {x.reply ? <Gap v={x.total} t={t} strong /> : <span className="tabular-nums text-dim" title="The turn was committed from the transcript, so the wait after the customer stopped was not timed. The real gap is at least this.">≥ {ms(x.total)}</span>}
      </span>
      <span className="w-40 shrink-0"><StageBar eou={x.eou} llm={x.llm} tts={x.tts} /></span>
      <span className="tabular-nums text-dim">
        {x.reply ? `end of turn ${ms(x.eou)}` : 'end of turn not timed'} · LLM {ms(x.llm)} · voice {ms(x.tts)}
      </span>
      {tone === 'stall' && <span className="font-semibold">Stall</span>}
      {x.llmServed && pu.llm && x.llmServed !== pu.llm && <span className="font-mono text-dim">answered by {x.llmServed}</span>}
    </div>
  );
}

function EventMark({ at, event: e }: { at: number; event: CallEvent }) {
  const alert = e.kind === 'stall_guard' || e.kind === 'llm_fallback';
  return (
    <div className="flex items-center gap-3 py-1.5 text-xs text-dim">
      <span className="w-10 shrink-0 text-right font-mono tabular-nums">{secs(at / 1000)}</span>
      <span className="h-px w-6 bg-border" />
      <span className="flex items-center gap-1.5">
        {alert && <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />}
        <span className={alert ? 'font-semibold text-text' : 'font-semibold'}>{EVENT_LABELS[e.kind] ?? e.kind}</span>
        {e.ms != null && <span className="tabular-nums">{ms(e.ms)}</span>}
        {e.detail && <span>· {e.detail.toLowerCase().replace(/_/g, ' ')}</span>}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function TimingTable({ turns, t, pu, at }: { turns: TurnMetric[]; t: Targets; pu: Record<string, string>; at: (iso: string) => string }) {
  return (
    <div className="overflow-x-auto pb-2 pt-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-dim">
            <th className="py-2 pl-5 pr-3 font-medium">At</th>
            <th className="px-3 py-2 font-medium">Split</th>
            <th className="px-3 py-2 text-right font-medium">Gap</th>
            <th className="px-3 py-2 text-right font-medium">End of turn</th>
            <th className="px-3 py-2 text-right font-medium">of which STT</th>
            <th className="px-3 py-2 text-right font-medium">LLM</th>
            <th className="px-3 py-2 text-right font-medium">Voice</th>
            <th className="py-2 pl-3 pr-5 font-medium">LLM · voice that served</th>
          </tr>
        </thead>
        <tbody>
          {turns.map((x, i) => (
            <tr key={i} className="border-t border-border">
              <td className="py-2 pl-5 pr-3 font-mono text-xs">{at(x.at)}</td>
              <td className="w-44 px-3 py-2"><StageBar eou={x.eou} llm={x.llm} tts={x.tts} /></td>
              <td className="px-3 py-2 text-right">{x.reply ? <Gap v={x.total} t={t} strong /> : <span className="tabular-nums text-dim">≥ {ms(x.total)}</span>}</td>
              <td className="px-3 py-2 text-right tabular-nums">{x.reply ? ms(x.eou) : <span className="text-dim" title="The turn was committed from the transcript, so the wait after the customer stopped was not timed.">not timed</span>}</td>
              <td className="px-3 py-2 text-right tabular-nums">{x.reply ? ms(x.stt) : '—'}</td>
              <td className="px-3 py-2 text-right tabular-nums">{ms(x.llm)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{ms(x.tts)}</td>
              <td className="py-2 pl-3 pr-5 font-mono text-xs text-dim">
                {x.llmServed ?? pu.llm ?? '—'} · {x.ttsServed ?? pu.tts ?? '—'}
                {x.promptTokens ? ` · ${x.promptTokens} tok` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
