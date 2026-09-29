'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { gapTone, ms, TONE_COLOR, TONE_LABEL, TOTAL_COLOR, type Dist, type Targets, type Tone } from '@/components/ops/latency';

/** Charts for the latency tab, drawn as plain SVG at the container's real width. */

const GRID = 'var(--border)';
const P50_COLOR = '#3987e5';
const P95_COLOR = TOTAL_COLOR;

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Round axis steps: at most five gridlines, on values people say out loud. */
function axis(maxValue: number): { max: number; ticks: number[] } {
  const step = [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10_000].find((s) => maxValue / s <= 5) ?? 20_000;
  const max = Math.max(step, Math.ceil(maxValue / step) * step);
  return { max, ticks: Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step) };
}

const tick = (v: number) => (v === 0 ? '0' : v >= 1000 ? `${v / 1000} s` : `${v} ms`);
const dayLabel = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

function Tip({ x, y, width, children }: { x: number; y: number; width: number; children: React.ReactNode }) {
  const flip = x > width - 200;
  return (
    <div
      className="pointer-events-none absolute z-10 min-w-40 rounded-lg border border-border bg-background px-3 py-2 text-xs shadow-lg"
      style={{ top: Math.max(0, y), ...(flip ? { right: width - x + 12 } : { left: x + 12 }) }}
    >
      {children}
    </div>
  );
}

function TipRow({ color, label, value }: { color?: string; label: string; value: string }) {
  return (
    <p className="flex items-center justify-between gap-4">
      <span className="flex items-center gap-1.5 text-dim">
        {color && <span className="inline-block h-0.5 w-3 rounded-full" style={{ background: color }} />}
        {label}
      </span>
      <span className="font-semibold tabular-nums">{value}</span>
    </p>
  );
}

function TargetLines({ t, y, x0, x1, max }: { t: Targets; y: (v: number) => number; x0: number; x1: number; max: number }) {
  const lines = ([['good', t.goodMs, 'target'], ['slow', t.slowMs, 'slow']] as Array<[Tone, number, string]>).filter(([, v]) => v <= max);
  // On a tall scale (a day with a stall) the two lines sit a few pixels apart:
  // keep the lines where they are and push the labels apart so both stay readable.
  const MIN_GAP = 11;
  const labelY = lines.map(([, v]) => y(v) + 3.5);
  if (labelY.length === 2 && labelY[0]! - labelY[1]! < MIN_GAP) {
    const mid = (labelY[0]! + labelY[1]!) / 2;
    labelY[0] = mid + MIN_GAP / 2;
    labelY[1] = mid - MIN_GAP / 2;
  }
  return (
    <>
      {lines.map(([tone, v, label], i) => (
        <g key={tone}>
          <line x1={x0} x2={x1} y1={y(v)} y2={y(v)} stroke={TONE_COLOR[tone]} strokeWidth={1} opacity={0.55} />
          <text x={x1 + 6} y={labelY[i]} fontSize={10} fill="var(--text-dim)">{label} {tick(v)}</text>
        </g>
      ))}
    </>
  );
}

export interface DayPoint {
  day: string;
  calls: number;
  turns: number;
  timedTurns: number;
  underTarget: number;
  stalls: number;
  total: Dist;
}

/** Typical and worst-5% gap per day against the targets. */
export function TrendChart({ days, targets }: { days: DayPoint[]; targets: Targets }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const rows = [...days].sort((a, b) => a.day.localeCompare(b.day));
  const H = 220;
  const m = { l: 44, r: 84, t: 12, b: 26 };
  const values = rows.flatMap((r) => [r.total.p50, r.total.p95]).filter((v): v is number => v != null);
  const { max, ticks } = axis(Math.max(targets.slowMs * 1.2, ...values));
  const plotW = Math.max(0, width - m.l - m.r);
  const x = (i: number) => m.l + (rows.length > 1 ? (i / (rows.length - 1)) * plotW : plotW / 2);
  const y = (v: number) => m.t + (1 - v / max) * (H - m.t - m.b);
  const path = (k: 'p50' | 'p95') => {
    let d = '';
    let pen = false;
    rows.forEach((r, i) => {
      const v = r.total[k];
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i)},${y(v)}`;
      pen = true;
    });
    return d;
  };
  const every = Math.max(1, Math.ceil(rows.length / Math.max(1, Math.floor(plotW / 64))));
  const nearest = (clientX: number, left: number) => {
    const px = clientX - left;
    let best = 0;
    rows.forEach((_, i) => {
      if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    });
    return best;
  };
  const h = hover != null ? rows[hover] : null;

  return (
    <div ref={ref} className="relative">
      {width > 0 && (
        <svg
          width={width}
          height={H}
          role="img"
          aria-label="Typical and worst 5% turn gap per day"
          tabIndex={0}
          className="block outline-none focus-visible:ring-1 focus-visible:ring-accent-dim"
          onPointerMove={(e) => setHover(nearest(e.clientX, e.currentTarget.getBoundingClientRect().left))}
          onPointerLeave={() => setHover(null)}
          onBlur={() => setHover(null)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            const at = hover ?? rows.length - 1;
            setHover(Math.min(rows.length - 1, Math.max(0, at + (e.key === 'ArrowRight' ? 1 : -1))));
          }}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line x1={m.l} x2={width - m.r} y1={y(v)} y2={y(v)} stroke={GRID} strokeWidth={1} />
              <text x={m.l - 8} y={y(v) + 3.5} fontSize={10} textAnchor="end" fill="var(--text-dim)" style={{ fontVariantNumeric: 'tabular-nums' }}>{tick(v)}</text>
            </g>
          ))}
          <TargetLines t={targets} y={y} x0={m.l} x1={width - m.r} max={max} />
          {rows.map((r, i) => i % every === 0 && (
            <text key={r.day} x={x(i)} y={H - 8} fontSize={10} textAnchor="middle" fill="var(--text-dim)">{dayLabel(r.day)}</text>
          ))}
          {h && hover != null && <line x1={x(hover)} x2={x(hover)} y1={m.t} y2={H - m.b} stroke="var(--text-dim)" strokeWidth={1} opacity={0.6} />}
          <path d={path('p95')} fill="none" stroke={P95_COLOR} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <path d={path('p50')} fill="none" stroke={P50_COLOR} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {rows.map((r, i) => (['p95', 'p50'] as const).map((k) => {
            const v = r.total[k];
            const show = rows.length <= 14 || hover === i;
            return v != null && show ? (
              <circle key={`${r.day}${k}`} cx={x(i)} cy={y(v)} r={hover === i ? 5 : 4} fill={k === 'p50' ? P50_COLOR : P95_COLOR} stroke="var(--surface)" strokeWidth={2} />
            ) : null;
          }))}
        </svg>
      )}
      {h && hover != null && (
        <Tip x={x(hover)} y={m.t} width={width}>
          <p className="mb-1 font-semibold">{dayLabel(h.day)}</p>
          <TipRow color={P50_COLOR} label="Typical (p50)" value={ms(h.total.p50)} />
          <TipRow color={P95_COLOR} label="Worst 5% (p95)" value={ms(h.total.p95)} />
          <TipRow label="Under target" value={h.timedTurns ? `${Math.round((h.underTarget / h.timedTurns) * 100)}%` : '—'} />
          <TipRow label="Stalls" value={String(h.stalls)} />
          <TipRow label="Calls · replies" value={`${h.calls} · ${h.turns}`} />
        </Tip>
      )}
      <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-dim">
        <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 rounded-full" style={{ background: P50_COLOR }} />Typical reply (p50)</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 rounded-full" style={{ background: P95_COLOR }} />Worst 5% (p95)</span>
      </p>
    </div>
  );
}

export interface CallPoint {
  id: string;
  startedAt: string;
  label: string;
  p50: number | null;
  max: number | null;
  turns: number;
  stalls: number;
}

/** Hour of the day in India, as a fraction (14.5 = 2:30 pm). */
function istHour(iso: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get('hour') + get('minute') / 60;
}

const SCATTER_TONES: Tone[] = ['good', 'ok', 'slow', 'stall'];

/** Each call's typical gap against the time of day it ran, to show busy-hour slowdowns. */
export function CallScatter({ calls, targets }: { calls: CallPoint[]; targets: Targets }) {
  const router = useRouter();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = 220;
  const m = { l: 44, r: 84, t: 12, b: 26 };
  const cap = targets.stallMs * 1.2;
  const pts = calls
    .filter((c): c is CallPoint & { p50: number } => c.p50 != null)
    .map((c) => ({ ...c, hour: istHour(c.startedAt), tone: (c.stalls ? 'stall' : gapTone(c.p50, targets)) as Tone }));
  const hours = pts.map((p) => p.hour);
  const h0 = pts.length ? Math.max(0, Math.floor(Math.min(...hours)) - 1) : 8;
  const h1 = pts.length ? Math.min(24, Math.ceil(Math.max(...hours)) + 1) : 20;
  const { max, ticks } = axis(Math.max(targets.slowMs * 1.2, ...pts.map((p) => Math.min(p.p50, cap))));
  const plotW = Math.max(0, width - m.l - m.r);
  const x = (hour: number) => m.l + ((hour - h0) / Math.max(1, h1 - h0)) * plotW;
  const y = (v: number) => m.t + (1 - Math.min(v, max) / max) * (H - m.t - m.b);
  const span = h1 - h0;
  const hourStep = [1, 2, 3, 4, 6].find((s) => (span / s) * 44 <= plotW) ?? 6;
  const hourTicks = Array.from({ length: Math.floor(span / hourStep) + 1 }, (_, i) => h0 + i * hourStep);
  const find = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left;
    const py = e.clientY - box.top;
    let best: number | null = null;
    let dist = 28;
    pts.forEach((p, i) => {
      const d = Math.hypot(x(p.hour) - px, y(p.p50) - py);
      if (d < dist) {
        dist = d;
        best = i;
      }
    });
    return best;
  };
  const h = hover != null ? pts[hover] : null;

  return (
    <div ref={ref} className="relative">
      {width > 0 && (
        <svg
          width={width}
          height={H}
          role="img"
          aria-label="Typical turn gap of each call by time of day"
          className="block"
          style={{ cursor: h ? 'pointer' : 'default' }}
          onPointerMove={(e) => setHover(find(e))}
          onPointerLeave={() => setHover(null)}
          onClick={() => h && router.push(`/ops/calls/${h.id}`)}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line x1={m.l} x2={width - m.r} y1={y(v)} y2={y(v)} stroke={GRID} strokeWidth={1} />
              <text x={m.l - 8} y={y(v) + 3.5} fontSize={10} textAnchor="end" fill="var(--text-dim)" style={{ fontVariantNumeric: 'tabular-nums' }}>{tick(v)}</text>
            </g>
          ))}
          <TargetLines t={targets} y={y} x0={m.l} x1={width - m.r} max={max} />
          {hourTicks.map((v) => (
            <text key={v} x={x(v)} y={H - 8} fontSize={10} textAnchor="middle" fill="var(--text-dim)">{String(v % 24).padStart(2, '0')}:00</text>
          ))}
          {pts.map((p, i) => (
            <circle key={p.id} cx={x(p.hour)} cy={y(p.p50)} r={hover === i ? 6 : 4} fill={TONE_COLOR[p.tone]} stroke="var(--surface)" strokeWidth={2} />
          ))}
        </svg>
      )}
      {h && (
        <Tip x={x(h.hour)} y={y(h.p50) - 8} width={width}>
          <p className="font-semibold">{h.label}</p>
          <p className="mb-1 text-dim">{new Date(h.startedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}</p>
          <TipRow label="Typical (p50)" value={ms(h.p50)} />
          <TipRow label="Worst reply" value={ms(h.max)} />
          <TipRow label="Replies · stalls" value={`${h.turns} · ${h.stalls}`} />
          <p className="mt-1 text-dim">Click to open the call</p>
        </Tip>
      )}
      <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-dim">
        {SCATTER_TONES.map((tone) => (
          <span key={tone} className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: TONE_COLOR[tone] }} />
            {tone === 'stall' ? 'Had a stall' : TONE_LABEL[tone]}
          </span>
        ))}
        <span>Time of day in India{pts.some((p) => p.p50 > max) ? ` · calls above ${tick(max)} sit on the top line` : ''}</span>
      </p>
    </div>
  );
}
