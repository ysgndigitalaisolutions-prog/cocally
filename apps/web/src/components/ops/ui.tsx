'use client';

/** Small shared building blocks for the ops console pages. */

export function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'good' | 'bad' | 'warn' }) {
  const color = tone === 'good' ? 'var(--good)' : tone === 'bad' ? 'var(--bad)' : tone === 'warn' ? 'var(--accent)' : undefined;
  return (
    <div className="card p-4">
      <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>{label}</p>
      <p className="text-2xl font-bold tabular-nums" style={color ? { color } : undefined}>{value}</p>
      {hint && <p className="text-xs" style={{ color: 'var(--text-dim)' }}>{hint}</p>}
    </div>
  );
}

export function Pill({ text, tone }: { text: string; tone: 'good' | 'bad' | 'warn' | 'dim' }) {
  const bg = tone === 'good' ? 'var(--good)' : tone === 'bad' ? 'var(--bad)' : tone === 'warn' ? 'var(--accent)' : 'var(--surface-2)';
  return (
    <span className="whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: bg, color: tone === 'dim' ? 'var(--text-dim)' : '#0b1220' }}>
      {text}
    </span>
  );
}

export function tenantStatus(t: { active: boolean; paused: boolean }) {
  if (!t.active) return <Pill text="Deactivated" tone="bad" />;
  if (t.paused) return <Pill text="Paused" tone="warn" />;
  return <Pill text="Active" tone="good" />;
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function secs(s: number): string {
  if (!s) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, '0')}`;
}

/** Shows a one-time link with a copy button — used for invites and resets. */
export function LinkBox({ title, url, expiresAt, onClose }: { title: string; url: string; expiresAt?: string; onClose: () => void }) {
  return (
    <div className="card space-y-2 border p-4" style={{ borderColor: 'var(--accent)' }}>
      <div className="flex items-start justify-between gap-3">
        <p className="font-semibold">{title}</p>
        <button className="text-xs" style={{ color: 'var(--text-dim)' }} onClick={onClose}>Close</button>
      </div>
      <p className="break-all rounded bg-[var(--surface-2)] p-2 font-mono text-xs">{url}</p>
      <div className="flex items-center gap-3">
        <button className="btn btn-primary text-sm" onClick={() => void navigator.clipboard.writeText(url)}>Copy link</button>
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
          Shown once. Send it to them directly.{expiresAt ? ` Expires ${fmtDateTime(expiresAt)}.` : ''}
        </span>
      </div>
    </div>
  );
}
