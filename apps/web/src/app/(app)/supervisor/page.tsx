'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';
import { SUPERVISION_MODES, type SupervisableCall, type SupervisionMode, type SupervisionSession } from '@cocally/shared';
import { api, secondsSince } from '@/lib/api';
import { useAppStore } from '@/lib/store';

const SUPERVISOR_ROLES = ['SUPERVISOR', 'ADMIN', 'OWNER'];

const MODE_COPY: Record<SupervisionMode, { label: string; detail: string }> = {
  MONITOR: {
    label: 'Monitor',
    detail: 'Listen only. Neither the agent nor the customer is told you are here, and you publish nothing.',
  },
  WHISPER: {
    label: 'Whisper',
    detail: 'Only the agent hears you. The customer does not. The agent is notified.',
  },
  BARGE: {
    label: 'Barge',
    detail: 'Everyone hears you, customer included. The agent is notified.',
  },
};

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function errorMessage(err: unknown, fallback: string): string {
  const detail = (err as { response?: { data?: { message?: string | string[] } } }).response?.data?.message;
  if (Array.isArray(detail)) return detail.join(', ');
  return typeof detail === 'string' ? detail : fallback;
}

/**
 * Supervisor live-call desk per WS-04.
 *
 * The three modes are LiveKit room grants, not a separate media path: attaching
 * hands back credentials for the agent's existing call room, and this page joins
 * it exactly as the agent's call bar does. The only client-side difference is
 * whether the microphone is published — MONITOR's token forbids it outright, so
 * publishing in that mode is not merely impolite, it fails.
 */
export default function SupervisorPage() {
  const { user } = useAppStore();
  const [calls, setCalls] = useState<SupervisableCall[]>([]);
  const [session, setSession] = useState<SupervisionSession | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [, setTick] = useState(0);

  const roomRef = useRef<Room | null>(null);
  const audioContainerRef = useRef<HTMLDivElement | null>(null);
  /** Mirrors `session` for unmount/unload handlers, which close over stale state. */
  const sessionRef = useRef<SupervisionSession | null>(null);

  const allowed = Boolean(user?.roles.some((r) => SUPERVISOR_ROLES.includes(r)));

  const loadCalls = useCallback(() => {
    api
      .get('/supervision/calls')
      .then((r) => setCalls(r.data))
      .catch((err) => setError(errorMessage(err, 'Could not load live calls.')));
  }, []);

  useEffect(() => {
    if (!allowed) return;
    loadCalls();
    const timer = setInterval(loadCalls, 5_000);
    return () => clearInterval(timer);
  }, [allowed, loadCalls]);

  // Per-second re-render so the live call durations move.
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const leaveRoom = useCallback(() => {
    roomRef.current?.disconnect();
    roomRef.current = null;
    audioContainerRef.current?.replaceChildren();
  }, []);

  /** Join (or re-join) the call room with the credentials the API just minted. */
  const joinRoom = useCallback(async (next: SupervisionSession) => {
    leaveRoom();
    const room = new Room();
    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind !== Track.Kind.Audio) return;
      const el = track.attach();
      audioContainerRef.current?.appendChild(el);
      el.play().catch(() => setError('Your browser blocked audio — click anywhere on the page, then re-attach.'));
    });
    await room.connect(next.livekitUrl, next.livekitToken);
    // MONITOR's token carries canPublish:false — asking for the mic there would
    // throw. WHISPER and BARGE both publish; who actually HEARS the supervisor
    // is decided server-side by subscription, not here.
    if (next.mode !== 'MONITOR') await room.localParticipant.setMicrophoneEnabled(true);
    roomRef.current = room;
  }, [leaveRoom]);

  async function attach(callId: string, mode: SupervisionMode) {
    setBusy(callId);
    setError('');
    try {
      if (sessionRef.current && sessionRef.current.callId !== callId) await detach();
      const r = await api.post(`/supervision/calls/${callId}/attach`, { mode });
      const next: SupervisionSession = r.data;
      await joinRoom(next);
      sessionRef.current = next;
      setSession(next);
      loadCalls();
    } catch (err) {
      setError(errorMessage(err, 'Could not attach to that call.'));
      leaveRoom();
    } finally {
      setBusy('');
    }
  }

  async function changeMode(mode: SupervisionMode) {
    const current = sessionRef.current;
    if (!current) return;
    setBusy(current.callId);
    setError('');
    try {
      const r = await api.post(`/supervision/calls/${current.callId}/mode`, { mode });
      const next: SupervisionSession & { rejoinRequired?: boolean } = r.data;
      if (next.rejoinRequired) {
        // Publish rights are signed into the token, so anything crossing the
        // MONITOR boundary needs a fresh connection with the new one.
        await joinRoom(next);
      } else if (roomRef.current) {
        // WHISPER ↔ BARGE is a subscription change only: stay connected (no gap
        // in audio) and just make sure the mic is up.
        await roomRef.current.localParticipant.setMicrophoneEnabled(true);
      }
      sessionRef.current = next;
      setSession(next);
      loadCalls();
    } catch (err) {
      setError(errorMessage(err, 'Could not change mode.'));
    } finally {
      setBusy('');
    }
  }

  const detach = useCallback(async () => {
    const current = sessionRef.current;
    sessionRef.current = null;
    setSession(null);
    leaveRoom();
    if (!current) return;
    await api.post(`/supervision/calls/${current.callId}/detach`).catch(() => undefined);
  }, [leaveRoom]);

  // Leaving the page must not leave a supervisor sitting in a room, audible on
  // BARGE, with the call still claiming they are attached. The server evicts on
  // detach; this covers navigation, and the beforeunload covers a closed tab
  // (best effort — the server's own eviction is the real backstop).
  useEffect(() => {
    function onUnload() {
      const current = sessionRef.current;
      roomRef.current?.disconnect();
      if (!current) return;
      void api.post(`/supervision/calls/${current.callId}/detach`).catch(() => undefined);
    }
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      onUnload();
    };
  }, []);

  if (!allowed) {
    return (
      <div className="card p-6">
        <h1 className="text-xl font-bold">Supervisor desk</h1>
        <p className="mt-2 text-sm" style={{ color: 'var(--text-dim)' }}>
          You need the supervisor, admin or owner role to listen in on live calls.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Supervisor desk</h1>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
            Every live call on the floor, refreshed every 5 seconds.
          </p>
        </div>
        {session && (
          <button className="btn btn-danger text-sm" onClick={() => void detach()}>
            Detach
          </button>
        )}
      </div>

      {error && (
        <p className="text-sm" role="alert" style={{ color: 'var(--bad)' }}>
          {error}
        </p>
      )}

      {session && (
        <div
          className="rounded-xl border p-4"
          style={{ borderColor: session.mode === 'BARGE' ? 'var(--bad)' : 'var(--accent)', background: 'var(--surface)' }}
          role="status"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-bold">
                Attached in{' '}
                <span style={{ color: session.mode === 'BARGE' ? 'var(--bad)' : 'var(--accent)' }}>
                  {MODE_COPY[session.mode].label.toUpperCase()}
                </span>
              </p>
              <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
                {MODE_COPY[session.mode].detail}
              </p>
            </div>
            <div className="flex gap-2">
              {SUPERVISION_MODES.map((mode) => (
                <button
                  key={mode}
                  className="btn text-sm"
                  disabled={Boolean(busy)}
                  aria-pressed={session.mode === mode}
                  onClick={() => void changeMode(mode)}
                  style={
                    session.mode === mode
                      ? { background: mode === 'BARGE' ? 'var(--bad)' : 'var(--accent)', color: '#0b1220' }
                      : { background: 'var(--surface-2)', color: 'var(--text-dim)', border: '1px solid var(--border)' }
                  }
                >
                  {MODE_COPY[mode].label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="card divide-y" style={{ borderColor: 'var(--border)' }}>
        <div
          className="grid grid-cols-12 gap-2 px-4 py-2 text-xs font-semibold uppercase tracking-wide"
          style={{ color: 'var(--text-dim)' }}
        >
          <span className="col-span-3">Agent</span>
          <span className="col-span-3">Customer</span>
          <span className="col-span-2">Campaign</span>
          <span className="col-span-1">Time</span>
          <span className="col-span-3 text-right">Listen in</span>
        </div>
        {calls.length === 0 && (
          <p className="p-4 text-sm" style={{ color: 'var(--text-dim)' }}>
            No live calls right now.
          </p>
        )}
        {calls.map((call) => {
          const attachedHere = session?.callId === call.callId;
          // `supervised` is another supervisor's mode when it is set and this
          // is not our session — one supervisor per call, so those rows are
          // not attachable and the buttons say so.
          const takenByOther = Boolean(call.supervised) && !attachedHere;
          return (
            <div key={call.callId} className="grid grid-cols-12 items-center gap-2 px-4 py-3 text-sm" style={{ borderColor: 'var(--border)' }}>
              <span className="col-span-3 truncate font-medium">
                {call.agentName ?? <span style={{ color: 'var(--text-dim)' }}>AI only</span>}
              </span>
              <span className="col-span-3 truncate">{call.leadName}</span>
              <span className="col-span-2 truncate text-xs" style={{ color: 'var(--text-dim)' }}>
                {call.campaignName}
              </span>
              <span className="col-span-1 font-mono text-xs tabular-nums" style={{ color: 'var(--text-dim)' }}>
                {formatDuration(secondsSince(call.startedAt))}
              </span>
              <span className="col-span-3 flex items-center justify-end gap-1">
                {takenByOther ? (
                  <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
                    supervised ({call.supervised?.toLowerCase()})
                  </span>
                ) : (
                  SUPERVISION_MODES.map((mode) => (
                    <button
                      key={mode}
                      className="btn px-2 py-1 text-xs"
                      disabled={busy === call.callId}
                      aria-label={`${MODE_COPY[mode].label} ${call.agentName ?? 'this call'}`}
                      title={MODE_COPY[mode].detail}
                      onClick={() => void (attachedHere ? changeMode(mode) : attach(call.callId, mode))}
                      style={
                        attachedHere && session?.mode === mode
                          ? { background: mode === 'BARGE' ? 'var(--bad)' : 'var(--accent)', color: '#0b1220' }
                          : { background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }
                      }
                    >
                      {MODE_COPY[mode].label}
                    </button>
                  ))
                )}
              </span>
            </div>
          );
        })}
      </div>

      <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
        Monitoring is silent: the agent is not notified and hears nothing from you. Whisper and barge both announce
        themselves to the agent, and every attach is written to the call&apos;s compliance log either way.
      </p>

      <div ref={audioContainerRef} style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden' }} />
    </div>
  );
}
