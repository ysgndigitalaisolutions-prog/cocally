'use client';

/** Shared pieces for the ops latency views: numbers, colours, status and the stage bars. */

export interface Dist {
  n: number;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  max: number | null;
  avg: number | null;
}

export interface Targets {
  goodMs: number;
  slowMs: number;
  stallMs: number;
}

export type Stage = 'eou' | 'llm' | 'tts';

/**
 * Stage colours say which stage, never how good it is: green, amber and red
 * stay reserved for the verdict against the targets. Checked for colour-blind
 * separation on the card surface.
 */
export const STAGE_COLORS: Record<Stage, string> = { eou: '#3987e5', llm: '#d55181', tts: '#9085e9' };
export const STAGE_LABELS: Record<Stage, string> = { eou: 'End of turn', llm: 'LLM first token', tts: 'Voice first audio' };
export const STAGES: Stage[] = ['eou', 'llm', 'tts'];
/** The whole gap, when it is drawn as one mark rather than split by stage. */
export const TOTAL_COLOR = '#94a3b8';

/** 1234 → "1.23 s", 640 → "640 ms". */
export function ms(v: number | null | undefined): string {
  if (v == null) return '—';
  return v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 1 : 2)} s` : `${Math.round(v)} ms`;
}

export type Tone = 'good' | 'ok' | 'slow' | 'stall';

export const TONE_COLOR: Record<Tone, string> = { good: 'var(--good)', ok: 'var(--text-dim)', slow: 'var(--accent)', stall: 'var(--bad)' };
export const TONE_LABEL: Record<Tone, string> = { good: 'On target', ok: 'Acceptable', slow: 'Slow', stall: 'Stall' };

/** Where a whole-turn gap sits against the targets. */
export function gapTone(v: number | null | undefined, t: Targets): Tone | undefined {
  if (v == null) return undefined;
  if (v > t.stallMs) return 'stall';
  if (v > t.slowMs) return 'slow';
  return v <= t.goodMs ? 'good' : 'ok';
}

/** A gap with its verdict as a dot beside it, so the number itself stays readable. */
export function Gap({ v, t, strong }: { v: number | null | undefined; t: Targets; strong?: boolean }) {
  const tone = gapTone(v, t);
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap tabular-nums" title={tone ? TONE_LABEL[tone] : undefined}>
      {tone && <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: TONE_COLOR[tone] }} />}
      <span className={strong ? 'font-semibold' : undefined}>{ms(v)}</span>
      {tone && <span className="sr-only">({TONE_LABEL[tone]})</span>}
    </span>
  );
}

export function TonePill({ tone, text }: { tone: Tone; text?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-surface-2 px-2.5 py-0.5 text-xs font-semibold">
      <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: TONE_COLOR[tone] }} />
      {text ?? TONE_LABEL[tone]}
    </span>
  );
}

export function Legend() {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dim">
      {STAGES.map((k) => (
        <span key={k} className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: STAGE_COLORS[k] }} />
          {STAGE_LABELS[k]}
        </span>
      ))}
    </span>
  );
}

/**
 * One reply as a stacked bar: end of turn, then LLM, then voice, on a fixed
 * scale (default 3 s) so bars compare down a list. `total` sets the bar's
 * length when the stage values are medians that must not be added up; the
 * stages then only set the proportions. A reply longer than the scale fills
 * the track and gets a red end cap.
 */
export function StageBar({ eou, llm, tts, total, scaleMs = 3000 }: { eou: number; llm: number; tts: number; total?: number; scaleMs?: number }) {
  const sum = eou + llm + tts;
  const length = total ?? sum;
  const over = length > scaleMs;
  const width = (v: number) => (sum > 0 ? `${(v / sum) * Math.min(1, length / scaleMs) * 100}%` : '0%');
  const parts: Array<[Stage, number]> = [['eou', eou], ['llm', llm], ['tts', tts]];
  return (
    <div
      className="flex h-2.5 w-full min-w-[96px] gap-[2px] overflow-hidden rounded-sm bg-surface-2"
      role="img"
      aria-label={`end of turn ${ms(eou)}, LLM ${ms(llm)}, voice ${ms(tts)}, gap ${ms(length)}`}
      title={`end of turn ${ms(eou)} · LLM ${ms(llm)} · voice ${ms(tts)} · gap ${ms(length)}${over ? ` (longer than the ${ms(scaleMs)} scale)` : ''}`}
    >
      {parts.filter(([, v]) => v > 0).map(([k, v]) => (
        <div key={k} className="h-full" style={{ width: width(v), background: STAGE_COLORS[k] }} />
      ))}
      {over && <div className="h-full w-1 shrink-0" style={{ background: 'var(--bad)' }} />}
    </div>
  );
}

/**
 * A distribution as one bar: solid to the typical value (p50), a thin line on
 * to the worst 5% (p95). `mark` shades the first part of the bar, used for the
 * share of a stage that is one network round trip.
 */
export function RangeBar({ p50, p95, scaleMs, color, mark, faded }: { p50: number | null; p95: number | null; scaleMs: number; color: string; mark?: number | null; faded?: boolean }) {
  const pos = (v: number) => `${Math.min(100, (v / scaleMs) * 100)}%`;
  return (
    <div className="relative h-3 w-full" aria-hidden>
      <div className="absolute inset-y-[3px] left-0 right-0 rounded-sm bg-surface-2" />
      {p50 != null && p95 != null && p95 > p50 && (
        <>
          <div className="absolute top-1/2 h-px -translate-y-1/2" style={{ left: pos(p50), width: `calc(${pos(p95)} - ${pos(p50)})`, background: color, opacity: 0.7 }} />
          <div className="absolute inset-y-[2px] w-[2px] rounded-full" style={{ left: `calc(${pos(p95)} - 2px)`, background: color, opacity: 0.7 }} />
        </>
      )}
      {p50 != null && (
        <div className="absolute inset-y-0 left-0 overflow-hidden rounded-r-[4px]" style={{ width: pos(p50), background: color, opacity: faded ? 0.55 : 1 }}>
          {mark != null && mark > 0 && <div className="h-full" style={{ width: `${Math.min(100, (mark / Math.max(p50, 1)) * 100)}%`, background: 'rgba(11, 18, 32, 0.45)' }} />}
        </div>
      )}
    </div>
  );
}
