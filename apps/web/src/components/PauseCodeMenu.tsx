'use client';

import { useEffect, useRef, useState } from 'react';
import type { PauseCode } from '@cocally/shared';
import { api } from '@/lib/api';

interface PauseCodeOption {
  code: PauseCode;
  label: string;
  productive: boolean;
}

interface Props {
  /** The code the agent is currently paused on, if any. */
  activeCode: PauseCode | null;
  /** True while the agent is actually on BREAK (changes the button copy). */
  onBreak: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onSelect: (code: PauseCode) => void | Promise<void>;
}

/**
 * The break button, but with a reason attached.
 *
 * A plain BREAK toggle is unreportable: a supervisor cannot tell an agent sat
 * in a training session from one waiting on a broken headset from one at lunch,
 * so adherence is guesswork and payroll is unauditable. The API refuses a
 * codeless BREAK outright (`presence.service.setPresence`), so this menu is the
 * only way onto a pause — there is no "just go on break" path to fall back to.
 *
 * The codes come from `GET /workspace/pause-codes` rather than the shared enum
 * so the productive/unproductive split the agent picks from is by construction
 * the same one the wallboard reports on.
 */
export default function PauseCodeMenu({ activeCode, onBreak, disabled, disabledReason, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [codes, setCodes] = useState<PauseCodeOption[]>([]);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    api.get('/workspace/pause-codes').then((r) => setCodes(r.data)).catch(() => undefined);
  }, []);

  // Click-outside / Escape close. Both, because this is a menu an agent opens
  // by accident mid-call and must be able to dismiss without thinking.
  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const productive = codes.filter((c) => c.productive);
  const unproductive = codes.filter((c) => !c.productive);

  function choose(code: PauseCode) {
    setOpen(false);
    void onSelect(code);
  }

  function group(title: string, hint: string, options: PauseCodeOption[], accent: string) {
    if (options.length === 0) return null;
    return (
      <div className="px-2 py-2">
        <p className="px-2 text-xs font-semibold uppercase tracking-wide" style={{ color: accent }}>
          {title}
        </p>
        <p className="px-2 pb-1 text-xs" style={{ color: 'var(--text-dim)' }}>
          {hint}
        </p>
        {options.map((option) => (
          <button
            key={option.code}
            role="menuitem"
            onClick={() => choose(option.code)}
            className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm"
            style={
              option.code === activeCode
                ? { background: 'var(--surface-2)', color: accent }
                : { color: 'var(--text)' }
            }
          >
            <span>{option.label}</span>
            {option.code === activeCode && <span aria-hidden>●</span>}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        className="btn text-sm"
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={
          onBreak
            ? { background: 'var(--accent)', color: '#0b1220' }
            : {
                background: 'var(--surface-2)',
                color: 'var(--text-dim)',
                border: '1px solid var(--border)',
                opacity: disabled ? 0.5 : 1,
              }
        }
      >
        {onBreak ? `On break · ${codes.find((c) => c.code === activeCode)?.label ?? activeCode}` : 'Break…'}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Pause reason"
          className="absolute right-0 z-40 mt-1 w-64 overflow-hidden rounded-xl border shadow-2xl"
          style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
        >
          {codes.length === 0 && (
            <p className="p-3 text-sm" style={{ color: 'var(--text-dim)' }}>
              Loading pause codes…
            </p>
          )}
          {group('Paid / on task', 'Counts as productive time in adherence.', productive, 'var(--good)')}
          {productive.length > 0 && unproductive.length > 0 && (
            <div className="border-t" style={{ borderColor: 'var(--border)' }} />
          )}
          {group('Unpaid break', 'Does not count toward productive time.', unproductive, 'var(--text-dim)')}
        </div>
      )}
    </div>
  );
}
