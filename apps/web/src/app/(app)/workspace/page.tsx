'use client';

import { useEffect, useRef, useState } from 'react';
import type { FloorCallCard, TransferCard } from '@cocally/shared';
import { Room, RoomEvent, Track } from 'livekit-client';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { useAppStore } from '@/lib/store';

const PRESENCE_OPTIONS = ['AVAILABLE', 'WRAP_UP', 'BREAK', 'OFFLINE'] as const;

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
const DISPOSITIONS = [
  ['BOOKED', 'Booked'],
  ['CALLBACK', 'Callback'],
  ['NOT_INTERESTED', 'Not interested'],
  ['NOT_QUALIFIED', 'Not qualified'],
  ['WRONG_NUMBER', 'Wrong number'],
  ['DO_NOT_CALL', 'Do not call'],
  ['FOLLOW_UP', 'Follow up'],
] as const;

interface CallBriefing {
  callId: string;
  leadName: string;
  location: string;
  score: number;
  summary: string;
  facts: Array<{ label: string; value: string; confirmed: boolean }>;
  objection: string | null;
  campaignName: string;
  rebuttals: Array<{ objection: string; rebuttal: string }>;
}

export default function WorkspacePage() {
  const { presence, setPresence, transferOffer, setTransferOffer, activeCallId, setActiveCallId } = useAppStore();
  const [floor, setFloor] = useState<Record<string, FloorCallCard>>({});
  const [transcript, setTranscript] = useState<Array<{ speaker: string; text: string }>>([]);
  const [summary, setSummary] = useState('');
  const [briefing, setBriefing] = useState<CallBriefing | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [notes, setNotes] = useState('');
  const [team, setTeam] = useState<TeamMember[]>([]);
  const offerRef = useRef<TransferCard | null>(null);

  // Real LiveKit audio bridge for a bridged transfer (the live-voice-demo
  // dial trigger itself lives on the admin-only /live-demo page — an agent
  // only ever sees the resulting transfer offer + on-call audio here). See
  // claude-dev/2026-07-22-live-voice-build-progress.md.
  const liveKitRoomRef = useRef<Room | null>(null);
  const liveKitAudioRef = useRef<HTMLDivElement | null>(null);
  const [audioStatus, setAudioStatus] = useState<'idle' | 'connecting' | 'live' | 'blocked' | 'error'>('idle');
  const [audioError, setAudioError] = useState('');
  const [audioRetryCount, setAudioRetryCount] = useState(0);
  const [micMuted, setMicMuted] = useState(false);

  // Server truth on load: own presence + team roster. The buttons and banner
  // always reflect what the SERVER believes, never a stale local default.
  useEffect(() => {
    api.get('/workspace/me').then((r) => setPresence(r.data.presence)).catch(() => undefined);
    api.get('/workspace/team').then((r) => setTeam(r.data)).catch(() => undefined);
    const timer = setInterval(() => {
      api.get('/workspace/team').then((r) => setTeam(r.data)).catch(() => undefined);
    }, 15_000);
    return () => clearInterval(timer);
  }, [setPresence]);

  // Bridge real audio into a live-voice-demo call: when this agent gets
  // bridged (activeCallId set), join the same LiveKit room the AI worker and
  // the browser "lead" are in, publish mic, and play back what they hear —
  // the human takes over the mic where the AI worker leaves off.
  useEffect(() => {
    if (!activeCallId) {
      liveKitRoomRef.current?.disconnect();
      liveKitRoomRef.current = null;
      setAudioStatus('idle');
      setMicMuted(false);
      return;
    }
    let cancelled = false;
    setAudioStatus('connecting');
    setAudioError('');
    api
      .get(`/calls/${activeCallId}/agent-token`)
      .then(async (r) => {
        if (cancelled) return;
        const room = new Room();
        room.on(RoomEvent.TrackSubscribed, (track) => {
          if (track.kind !== Track.Kind.Audio) return;
          const el = track.attach();
          liveKitAudioRef.current?.appendChild(el);
          // Autoplay can still be blocked even after an earlier page
          // interaction (this connect is triggered by a socket event, not a
          // click) — surface a one-click "Enable audio" fallback instead of
          // silently failing.
          el.play().catch(() => setAudioStatus('blocked'));
        });
        await room.connect(r.data.url, r.data.token);
        await room.localParticipant.setMicrophoneEnabled(true);
        liveKitRoomRef.current = room;
        setAudioStatus((prev) => (prev === 'blocked' ? prev : 'live'));
      })
      // Not every bridged call is a live-voice-demo call (simulation-path
      // transfers have no LiveKit room), but a real failure (denied mic
      // permission, LiveKit connect error, etc.) must be visible — silently
      // swallowing it left agents with no audio and no explanation at all.
      .catch((e) => {
        setAudioError(e instanceof Error ? e.message : 'Could not connect call audio.');
        setAudioStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [activeCallId, audioRetryCount]);

  function enableAudio() {
    liveKitAudioRef.current?.querySelectorAll('audio').forEach((el) => void (el as HTMLAudioElement).play());
    setAudioStatus('live');
  }

  function toggleMic() {
    const room = liveKitRoomRef.current;
    if (!room) return;
    const next = !micMuted;
    void room.localParticipant.setMicrophoneEnabled(!next);
    setMicMuted(next);
  }

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    socket.on('presence.updated', ({ userId, state }: { userId: string; state: string }) => {
      setTeam((prev) => prev.map((m) => (m.id === userId ? { ...m, presence: state } : m)));
      const me = JSON.parse(localStorage.getItem('cocally.user') ?? '{}') as { id?: string };
      if (me.id === userId) setPresence(state as (typeof PRESENCE_OPTIONS)[number]);
    });

    socket.on('transfer.offer', (card: TransferCard) => {
      offerRef.current = card;
      setTransferOffer(card);
      setTranscript([]);
      setSummary('');
    });
    socket.on('transfer.cancelled', ({ transferId }: { transferId: string }) => {
      if (offerRef.current?.transferId === transferId) {
        offerRef.current = null;
        setTransferOffer(null);
      }
    });
    socket.on('transfer.bridged', ({ callId }: { callId: string }) => {
      setActiveCallId(callId);
      setTransferOffer(null);
    });
    socket.on('floor.call.updated', (card: FloorCallCard) => {
      setFloor((prev) => ({ ...prev, [card.callId]: card }));
    });
    socket.on('floor.call.removed', ({ callId }: { callId: string }) => {
      setFloor((prev) => {
        const next = { ...prev };
        delete next[callId];
        return next;
      });
    });
    socket.on('transcript.segment', (segment: { speaker: string; text: string }) => {
      setTranscript((prev) => [...prev, segment]);
    });
    socket.on('call.summary.updated', ({ summary: s }: { summary: string }) => setSummary(s));

    return () => {
      socket.off('presence.updated');
      socket.off('transfer.offer');
      socket.off('transfer.cancelled');
      socket.off('transfer.bridged');
      socket.off('floor.call.updated');
      socket.off('floor.call.removed');
      socket.off('transcript.segment');
      socket.off('call.summary.updated');
    };
  }, [setActiveCallId, setTransferOffer, setPresence]);

  // Countdown ring per WS-03.
  useEffect(() => {
    if (!transferOffer) return;
    const timer = setInterval(() => {
      const remaining = Math.max(0, Math.round((transferOffer.acceptDeadline - Date.now()) / 1000));
      setCountdown(remaining);
      if (remaining === 0) setTransferOffer(null);
    }, 250);
    return () => clearInterval(timer);
  }, [transferOffer, setTransferOffer]);

  // On bridge, pull the call briefing (summary + campaign playbook). The summary
  // socket event fires during the AI leg — before this agent is assigned — so a
  // fetch is what reliably gives a just-bridged agent the context and script.
  useEffect(() => {
    if (!activeCallId) {
      setBriefing(null);
      return;
    }
    api
      .get(`/calls/${activeCallId}/briefing`)
      .then((r) => setBriefing(r.data))
      .catch(() => undefined);
  }, [activeCallId]);

  async function changePresence(state: (typeof PRESENCE_OPTIONS)[number]) {
    await api.post('/workspace/presence', { state });
    setPresence(state);
  }

  async function acceptOffer() {
    if (!transferOffer) return;
    try {
      await api.post(`/workspace/transfers/${transferOffer.transferId}/accept`);
    } catch {
      // The 13s(ish) accept window can lapse between the card rendering and
      // the click landing (server already cascaded to the next agent) — was
      // previously an uncaught 404 that crashed the page instead of just
      // clearing the stale card with an explanation.
      alert('This offer has expired — it was likely already offered to someone else. Wait for the next one.');
      setTransferOffer(null);
    }
  }

  async function declineOffer() {
    if (!transferOffer) return;
    try {
      await api.post(`/workspace/transfers/${transferOffer.transferId}/decline`);
    } catch {
      // Already expired — nothing to decline, just clear it below.
    }
    setTransferOffer(null);
  }

  async function setDisposition(disposition: string) {
    if (!activeCallId) return;
    await api.post(`/calls/${activeCallId}/disposition`, { disposition, notes: notes || undefined });
    liveKitRoomRef.current?.disconnect();
    liveKitRoomRef.current = null;
    setAudioStatus('idle');
    setMicMuted(false);
    setActiveCallId(null);
    setTranscript([]);
    setSummary('');
    setBriefing(null);
    setNotes('');
    setPresence('WRAP_UP');
  }

  const meta = PRESENCE_META[presence] ?? PRESENCE_META.OFFLINE!;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Agent workspace</h1>
        <div className="flex gap-2">
          {PRESENCE_OPTIONS.map((option) => (
            <button
              key={option}
              onClick={() => changePresence(option)}
              className="btn text-sm"
              style={
                presence === option
                  ? { background: option === 'AVAILABLE' ? 'var(--good)' : 'var(--accent)', color: '#0b1220' }
                  : { background: 'var(--surface-2)', color: 'var(--text-dim)', border: '1px solid var(--border)' }
              }
            >
              {option.replace('_', ' ')}
            </button>
          ))}
        </div>
      </div>

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
            {meta.hint}
          </p>
        </div>
      </div>

      {transferOffer && (
        <div className="card border-2 p-6" style={{ borderColor: 'var(--accent)' }}>
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-semibold" style={{ color: 'var(--accent)' }}>
                Incoming transfer — {transferOffer.campaignName}
              </p>
              <h2 className="mt-1 text-xl font-bold">
                {transferOffer.name} · {transferOffer.location}
              </h2>
              <p className="mt-1 text-sm" style={{ color: 'var(--text-dim)' }}>
                Score <span className="font-bold" style={{ color: 'var(--good)' }}>{transferOffer.score}</span>
                {transferOffer.flaggedObjection && <> · objection: {transferOffer.flaggedObjection}</>}
              </p>
            </div>
            <div
              className="flex h-14 w-14 items-center justify-center rounded-full border-4 text-lg font-bold"
              style={{ borderColor: countdown <= 4 ? 'var(--bad)' : 'var(--accent)' }}
            >
              {countdown}
            </div>
          </div>
          <ul className="mt-4 grid grid-cols-2 gap-1 text-sm md:grid-cols-3">
            {transferOffer.facts.map((fact) => (
              <li key={fact.label}>
                <span style={{ color: fact.confirmed ? 'var(--good)' : 'var(--text-dim)' }}>
                  {fact.confirmed ? '✓' : '·'} {fact.label}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm italic" style={{ color: 'var(--text-dim)' }}>
            {transferOffer.suggestedOpener}
          </p>
          <div className="mt-4 flex gap-3">
            <button onClick={acceptOffer} className="btn btn-primary flex-1">
              Accept transfer
            </button>
            <button onClick={declineOffer} className="btn btn-ghost">
              Decline
            </button>
          </div>
        </div>
      )}

      {activeCallId && (
        <div className="card p-6">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="font-semibold" style={{ color: 'var(--good)' }}>
              On call{briefing ? ` · ${briefing.leadName}` : ''}
            </h2>
            {briefing && (
              <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
                {briefing.campaignName}
                {briefing.location ? ` · ${briefing.location}` : ''}
                {' · score '}
                <span className="font-bold" style={{ color: 'var(--good)' }}>{briefing.score}</span>
              </span>
            )}
          </div>

          {/* Real LiveKit audio status for the live-voice-demo path. Absent
              (idle) for simulation-path transfers, which have no LiveKit
              room — but a real failure (denied mic, bad token, etc.) must
              always be visible, never silently hidden like "error" used to be. */}
          {audioStatus !== 'idle' && (
            <div
              className="mb-4 flex items-center justify-between rounded-lg p-3 text-sm"
              style={{ background: 'var(--surface-2)' }}
            >
              {audioStatus === 'connecting' && <span>Connecting call audio…</span>}
              {audioStatus === 'live' && (
                <span style={{ color: 'var(--good)' }}>🎙 Live audio connected — talk normally, your mic is on.</span>
              )}
              {audioStatus === 'blocked' && (
                <span style={{ color: 'var(--accent)' }}>Audio is connected but your browser blocked autoplay.</span>
              )}
              {audioStatus === 'error' && (
                <span style={{ color: 'var(--bad)' }}>
                  Could not connect call audio{audioError ? ` — ${audioError}` : ''}. Check your mic permission for
                  this site.
                </span>
              )}
              <div className="flex gap-2">
                {audioStatus === 'blocked' && (
                  <button onClick={enableAudio} className="btn btn-primary text-xs">
                    Enable audio
                  </button>
                )}
                {audioStatus === 'live' && (
                  <button onClick={toggleMic} className="btn btn-ghost text-xs">
                    {micMuted ? 'Unmute' : 'Mute'}
                  </button>
                )}
                {audioStatus === 'error' && (
                  <button onClick={() => setAudioRetryCount((n) => n + 1)} className="btn btn-primary text-xs">
                    Retry
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Summary + campaign script, side by side, so the agent has both in view */}
          <div className="mb-4 grid gap-4 md:grid-cols-2">
            <div className="rounded-lg p-3 text-sm" style={{ background: 'var(--surface-2)' }}>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                AI summary
              </p>
              <p>{briefing?.summary || summary || 'No summary captured yet.'}</p>
              {briefing && briefing.facts.length > 0 && (
                <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5">
                  {briefing.facts.map((fact) => (
                    <li key={fact.label} style={{ color: fact.confirmed ? 'var(--good)' : 'var(--text-dim)' }}>
                      {fact.confirmed ? '✓' : '·'} {fact.label}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-lg p-3 text-sm" style={{ background: 'var(--surface-2)' }}>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                Script &amp; rebuttals
              </p>
              {briefing && briefing.objection && (
                <p className="mb-2" style={{ color: 'var(--accent)' }}>
                  Flagged objection: <span className="font-semibold">{briefing.objection.replace(/_/g, ' ')}</span>
                </p>
              )}
              {briefing && briefing.rebuttals.length > 0 ? (
                <ul className="space-y-2">
                  {briefing.rebuttals.map((r) => {
                    const active = briefing.objection === r.objection;
                    return (
                      <li
                        key={r.objection}
                        className="rounded p-2"
                        style={active ? { background: 'var(--surface)', border: '1px solid var(--accent)' } : undefined}
                      >
                        <p className="font-semibold capitalize">{r.objection.replace(/_/g, ' ')}</p>
                        <p style={{ color: 'var(--text-dim)' }}>{r.rebuttal}</p>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p style={{ color: 'var(--text-dim)' }}>No rebuttal playbook configured for this campaign.</p>
              )}
            </div>
          </div>

          {transcript.length > 0 && (
            <div className="mb-4 max-h-48 space-y-1 overflow-y-auto text-sm">
              {transcript.map((line, i) => (
                <p key={i}>
                  <span style={{ color: 'var(--text-dim)' }}>{line.speaker}: </span>
                  {line.text}
                </p>
              ))}
            </div>
          )}
          <input
            className="input mb-3"
            placeholder="Disposition notes…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            {DISPOSITIONS.map(([value, label]) => (
              <button
                key={value}
                onClick={() => setDisposition(value)}
                className={value === 'BOOKED' ? 'btn btn-primary' : value === 'DO_NOT_CALL' ? 'btn btn-danger' : 'btn btn-ghost'}
              >
                {label}
              </button>
            ))}
          </div>
          <div ref={liveKitAudioRef} style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden' }} />
        </div>
      )}

      <section>
        <h2 className="mb-3 font-semibold">Team</h2>
        <div className="card divide-y" style={{ borderColor: 'var(--border)' }}>
          {team.length === 0 && (
            <p className="p-4 text-sm" style={{ color: 'var(--text-dim)' }}>
              No agents on this tenant yet.
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
                    {member.roles.join(', ').toLowerCase()}
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
    </div>
  );
}
