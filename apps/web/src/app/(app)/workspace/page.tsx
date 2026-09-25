'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentShiftState, FloorCallCard, PauseCode } from '@cocally/shared';
import { api, secondsSince, secondsUntil, serverNow } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { useAppStore } from '@/lib/store';
import { SUPERVISOR_ROLES, hasRole, roleLabel } from '@/lib/roles';
import PauseCodeMenu from '@/components/PauseCodeMenu';

interface TeamMember {
  id: string;
  name: string;
  roles: string[];
  presence: string;
  availableSince: string | null;
  talkTimeTodaySeconds: number;
}

const PRESENCE_META: Record<string, { dot: string; label: string; hint: string }> = {
  AVAILABLE: { dot: 'var(--good)', label: 'Available', hint: 'You will receive warm-transfer offers.' },
  RESERVED: { dot: 'var(--accent)', label: 'Reserved', hint: 'A transfer is being offered to you right now.' },
  ON_CALL: { dot: 'var(--accent)', label: 'On call', hint: 'Bridged with a customer.' },
  WRAP_UP: { dot: 'var(--accent-dim)', label: 'Wrap-up', hint: 'Finishing notes — no new offers until you go Available.' },
  BREAK: { dot: 'var(--text-dim)', label: 'On break', hint: 'No offers while on break.' },
  OFFLINE: { dot: 'var(--bad)', label: 'Offline', hint: 'Go Available to start receiving transfers.' },
};

function formatClock(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function errorMessage(err: unknown, fallback: string): string {
  const detail = (err as { response?: { data?: { message?: string | string[] } } }).response?.data?.message;
  if (Array.isArray(detail)) return detail.join(', ');
  return typeof detail === 'string' ? detail : fallback;
}

export default function WorkspacePage() {
  const {
    user,
    presence,
    setPresence,
    shift,
    setShift,
    activeCall,
    wrapUp,
  } = useAppStore();
  // Team roster and live AI floor are floor-management views. An agent's day
  // is their own status and their own calls; offers arrive via the call bar.
  const showFloor = hasRole(user, ...SUPERVISOR_ROLES);
  const [floor, setFloor] = useState<Record<string, FloorCallCard>>({});
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [shiftError, setShiftError] = useState('');
  const [busy, setBusy] = useState(false);
  /** Forces a re-render once a second so the shift clocks tick. */
  const [, setTick] = useState(0);
  /** serverNow() at the moment `shift` was fetched — the origin the clocks tick from. */
  const shiftFetchedAt = useRef(0);

  const loadShift = useCallback(async () => {
    const r = await api.get('/workspace/me/shift');
    const state: AgentShiftState = r.data;
    shiftFetchedAt.current = serverNow();
    setShift(state);
    setPresence(state.presence);
    return state;
  }, [setShift, setPresence]);

  // Server truth on load: own presence + shift + team roster. The buttons and
  // banner always reflect what the SERVER believes, never a stale local default.
  useEffect(() => {
    loadShift().catch(() => undefined);
    if (!showFloor) return;
    api.get('/workspace/team').then((r) => setTeam(r.data)).catch(() => undefined);
    const timer = setInterval(() => {
      api.get('/workspace/team').then((r) => setTeam(r.data)).catch(() => undefined);
    }, 15_000);
    return () => clearInterval(timer);
  }, [loadShift, showFloor]);

  // Shift and pause durations are ticked client-side off the server's counters
  // rather than re-fetched every second: one request on every change, then pure
  // arithmetic, so the numbers move smoothly and the API is left alone.
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    // Transfer offers, bridges and wrap-up are owned by GlobalCallBar (mounted
    // for the whole session) so they are never missed on another page. This
    // page only keeps the team roster and the live floor in step.
    const onPresence = ({ userId, state }: { userId: string; state: string }) => {
      setTeam((prev) => prev.map((m) => (m.id === userId ? { ...m, presence: state } : m)));
      const me = JSON.parse(localStorage.getItem('cocally.user') ?? '{}') as { id?: string };
      // Re-read the shift rather than trusting the broadcast alone: pause code,
      // paused total and clock-in time all move with it.
      if (me.id === userId) void loadShift().catch(() => undefined);
    };
    const onFloorUpdated = (card: FloorCallCard) => setFloor((prev) => ({ ...prev, [card.callId]: card }));
    const onFloorRemoved = ({ callId }: { callId: string }) =>
      setFloor((prev) => {
        const next = { ...prev };
        delete next[callId];
        return next;
      });
    socket.on('presence.updated', onPresence);
    socket.on('floor.call.updated', onFloorUpdated);
    socket.on('floor.call.removed', onFloorRemoved);

    // Removed by reference: `socket.off(event)` would also strip the
    // GlobalCallBar's listeners for the same events.
    return () => {
      socket.off('presence.updated', onPresence);
      socket.off('floor.call.updated', onFloorUpdated);
      socket.off('floor.call.removed', onFloorRemoved);
    };
  }, [loadShift]);

  async function changePresence(state: 'AVAILABLE' | 'WRAP_UP' | 'OFFLINE', pauseCode?: PauseCode) {
    setBusy(true);
    setShiftError('');
    try {
      await api.post('/workspace/presence', { state, pauseCode });
      await loadShift();
    } catch (err) {
      setShiftError(errorMessage(err, 'Could not change your status.'));
    } finally {
      setBusy(false);
    }
  }

  async function goOnBreak(pauseCode: PauseCode) {
    setBusy(true);
    setShiftError('');
    try {
      await api.post('/workspace/presence', { state: 'BREAK', pauseCode });
      await loadShift();
    } catch (err) {
      setShiftError(errorMessage(err, 'Could not start your break.'));
    } finally {
      setBusy(false);
    }
  }

  async function clock(direction: 'in' | 'out') {
    setBusy(true);
    setShiftError('');
    try {
      await api.post(`/workspace/clock-${direction}`);
      await loadShift();
    } catch (err) {
      setShiftError(errorMessage(err, `Could not clock ${direction}.`));
    } finally {
      setBusy(false);
    }
  }

  const meta = PRESENCE_META[presence] ?? PRESENCE_META.OFFLINE!;
  const clockedIn = Boolean(shift?.clockedInAt);
  // The API refuses AVAILABLE for an agent who is not on shift, because the
  // dialer would otherwise pace calls at an empty chair. Disable the button and
  // say why rather than letting the agent discover it through a 400.
  const onCall = Boolean(activeCall) || presence === 'ON_CALL' || presence === 'RESERVED';
  const availableBlockedReason = onCall
    ? 'Finish the call (hang up and log it) first.'
    : clockedIn
      ? ''
      : 'Clock in first — you are not on shift yet.';

  // Both counters tick from the server's snapshot plus the time since we took
  // it. `pausedSeconds` only advances while actually paused; the server already
  // counts the open segment, so this just keeps it moving between fetches.
  const elapsedSinceFetch = shiftFetchedAt.current ? secondsSince(shiftFetchedAt.current) : 0;
  const shiftSeconds = shift ? shift.shiftSeconds + (clockedIn ? elapsedSinceFetch : 0) : 0;
  const pausedSeconds = shift ? shift.pausedSeconds + (shift.presence === 'BREAK' ? elapsedSinceFetch : 0) : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Workspace</h1>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => changePresence('AVAILABLE')}
            className="btn text-sm"
            disabled={busy || !clockedIn || onCall}
            title={availableBlockedReason || undefined}
            style={
              presence === 'AVAILABLE'
                ? { background: 'var(--good)', color: '#0b1220' }
                : {
                    background: 'var(--surface-2)',
                    color: 'var(--text-dim)',
                    border: '1px solid var(--border)',
                    opacity: clockedIn ? 1 : 0.5,
                  }
            }
          >
            Available
          </button>
          <button
            onClick={() => changePresence('WRAP_UP')}
            className="btn text-sm"
            disabled={busy || onCall}
            title={onCall ? availableBlockedReason : undefined}
            style={
              presence === 'WRAP_UP'
                ? { background: 'var(--accent)', color: '#0b1220' }
                : { background: 'var(--surface-2)', color: 'var(--text-dim)', border: '1px solid var(--border)' }
            }
          >
            Wrap up
          </button>
          <PauseCodeMenu
            activeCode={shift?.pauseCode ?? null}
            onBreak={presence === 'BREAK'}
            disabled={busy}
            onSelect={goOnBreak}
          />
          <button
            onClick={() => changePresence('OFFLINE')}
            className="btn text-sm"
            disabled={busy || onCall}
            title={onCall ? availableBlockedReason : undefined}
            style={
              presence === 'OFFLINE'
                ? { background: 'var(--accent)', color: '#0b1220' }
                : { background: 'var(--surface-2)', color: 'var(--text-dim)', border: '1px solid var(--border)' }
            }
          >
            Offline
          </button>
        </div>
      </div>

      {/* Time clock. Clocking in and going available are deliberately two
          separate decisions — see PresenceService.clockIn. */}
      <div
        className="flex flex-wrap items-center justify-between gap-4 rounded-xl border px-4 py-3"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        <div className="flex flex-wrap items-center gap-6">
          <div>
            <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
              Shift
            </p>
            <p className="font-mono text-lg font-bold tabular-nums">
              {clockedIn ? formatClock(shiftSeconds) : '—'}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
              Paused
            </p>
            <p className="font-mono text-lg font-bold tabular-nums" style={{ color: 'var(--text-dim)' }}>
              {clockedIn ? formatClock(pausedSeconds) : '—'}
            </p>
          </div>
          {shift?.pauseCode && presence === 'BREAK' && (
            <div>
              <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                Reason
              </p>
              <p className="text-sm font-semibold" style={{ color: 'var(--accent)' }}>
                {shift.pauseCode.replace(/_/g, ' ').toLowerCase()}
              </p>
            </div>
          )}
        </div>
        <button
          onClick={() => clock(clockedIn ? 'out' : 'in')}
          className={clockedIn ? 'btn btn-ghost text-sm' : 'btn btn-primary text-sm'}
          disabled={busy}
        >
          {clockedIn ? 'Clock out' : 'Clock in'}
        </button>
      </div>

      {shiftError && (
        <p className="text-sm" style={{ color: 'var(--bad)' }} role="alert">
          {shiftError}
        </p>
      )}

      {/* Status banner: always shows the server-truth state, unambiguously */}
      <div
        className="flex items-center gap-3 rounded-xl border px-4 py-3"
        style={{ borderColor: meta.dot, background: 'var(--surface)' }}
      >
        <span className="relative flex h-3 w-3">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ background: meta.dot }} />
          <span className="relative inline-flex h-3 w-3 rounded-full" style={{ background: meta.dot }} />
        </span>
        <div>
          <p className="text-sm font-bold">You are {meta.label}</p>
          <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
            {availableBlockedReason && presence !== 'AVAILABLE' ? availableBlockedReason : meta.hint}
          </p>
        </div>
      </div>

      {/* Wrap-up countdown for an agent with nothing docked at the bottom — a
          blind transfer leaves them wrapping up with no call bar on screen. */}
      {wrapUp && !activeCall && (
        <div
          className="flex items-center justify-between rounded-xl border px-4 py-3"
          style={{ borderColor: 'var(--accent)', background: 'var(--surface)' }}
          role="status"
        >
          <p className="text-sm">
            Wrap-up in progress. You return to Available automatically when the timer runs out.
          </p>
          <span className="font-mono text-xl font-bold tabular-nums" style={{ color: 'var(--accent)' }}>
            {formatClock(secondsUntil(wrapUp.deadline))}
          </span>
        </div>
      )}

      {showFloor && (
        <section>
          <h2 className="mb-3 font-semibold">Team</h2>
          <div className="card divide-y" style={{ borderColor: 'var(--border)' }}>
            {team.length === 0 && (
              <p className="p-4 text-sm" style={{ color: 'var(--text-dim)' }}>
                No one else is on the floor yet.
              </p>
            )}
            {team.map((member) => {
              const m = PRESENCE_META[member.presence] ?? PRESENCE_META.OFFLINE!;
              return (
                <div key={member.id} className="flex items-center justify-between px-4 py-2" style={{ borderColor: 'var(--border)' }}>
                  <div className="flex items-center gap-3">
                    <span className="inline-flex h-2.5 w-2.5 rounded-full" style={{ background: m.dot }} />
                    <span className="text-sm font-medium">{member.name}</span>
                    <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
                      {roleLabel(member)}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 text-xs" style={{ color: 'var(--text-dim)' }}>
                    <span style={{ color: m.dot }}>{m.label}</span>
                    {member.presence === 'AVAILABLE' && member.availableSince && (
                      <span>idle {Math.max(0, Math.round((Date.now() - new Date(member.availableSince).getTime()) / 60000))}m</span>
                    )}
                    <span>talk today {Math.round(member.talkTimeTodaySeconds / 60)}m</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {showFloor && (
        <section>
          <h2 className="mb-3 font-semibold">Live floor</h2>
          {Object.keys(floor).length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
              No AI calls in progress.
            </p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {Object.values(floor).map((card) => (
                <div key={card.callId} className="card p-4">
                  <div className="flex items-center justify-between">
                    <p className="font-semibold">{card.leadName}</p>
                    <span
                      className="rounded-full px-2 py-0.5 text-xs font-bold"
                      style={{
                        background: card.score >= 70 ? 'var(--good)' : 'var(--surface-2)',
                        color: card.score >= 70 ? '#0b1220' : 'var(--text-dim)',
                      }}
                    >
                      {card.score}
                    </span>
                  </div>
                  <p className="mt-1 text-xs" style={{ color: 'var(--text-dim)' }}>
                    {card.state} · {card.currentStage}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
