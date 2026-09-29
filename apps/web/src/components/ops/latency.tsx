'use client';

/** Shared pieces for the ops latency views: numbers, colours and the per-turn stage bar. */

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

export const STAGE_COLORS = { eou: '#60a5fa', llm: '#f59e0b', tts: '#34d399' } as const;
export const STAGE_LABELS = { eou: 'End of turn', llm: 'LLM first token', tts: 'Voice first audio' } as const;

/** 1234 → "1.23 s", 640 → "640 ms". */
export function ms(v: number | null | undefined): string {
  if (v == null) return '—';
  return v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 1 : 2)} s` : `${Math.round(v)} ms`;
}

/** Colour for a whole-turn gap against the targets. */
export function gapColor(v: number | null | undefined, t: Targets): string | undefined {
  if (v == null) return undefined;
  if (v > t.stallMs) return 'var(--bad)';
  if (v > t.slowMs) return 'var(--accent)';
  if (v <= t.goodMs) return 'var(--good)';
  return undefined;
}

export function Gap({ v, t }: { v: number | null | undefined; t: Targets }) {
  const color = gapColor(v, t);
  return <span className="tabular-nums" style={color ? { color, fontWeight: 600 } : undefined}>{ms(v)}</span>;
}

export function Legend() {
  return (
    <span className="flex flex-wrap items-center gap-3 text-xs" style={{ color: 'var(--text-dim)' }}>
      {(Object.keys(STAGE_COLORS) as Array<keyof typeof STAGE_COLORS>).map((k) => (
        <span key={k} className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: STAGE_COLORS[k] }} />
          {STAGE_LABELS[k]}
        </span>
      ))}
    </span>
  );
}

/**
 * One turn as a stacked bar: end of turn, then LLM, then voice. Width is on a
 * fixed scale (default 3 s) so bars compare across turns; a stall overflows
 * and is marked.
 */
export function StageBar({ eou, llm, tts, scaleMs = 3000 }: { eou: number; llm: number; tts: number; scaleMs?: number }) {
  const total = eou + llm + tts;
  const pct = (v: number) => `${Math.min(100, (v / scaleMs) * 100)}%`;
  return (
    <div
      className="flex h-3 w-full min-w-[120px] overflow-hidden rounded-sm"
      style={{ background: 'var(--surface-2)' }}
      title={`end of turn ${ms(eou)} · LLM ${ms(llm)} · voice ${ms(tts)} · total ${ms(total)}`}
    >
      {total > scaleMs ? (
        <div className="h-full w-full" style={{ background: 'var(--bad)' }} />
      ) : (
        <>
          <div className="h-full" style={{ width: pct(eou), background: STAGE_COLORS.eou }} />
          <div className="h-full" style={{ width: pct(llm), background: STAGE_COLORS.llm }} />
          <div className="h-full" style={{ width: pct(tts), background: STAGE_COLORS.tts }} />
        </>
      )}
    </div>
  );
}
