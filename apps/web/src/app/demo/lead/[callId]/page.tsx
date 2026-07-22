'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { Room, RoomEvent, Track } from 'livekit-client';
import axios from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type Status = 'idle' | 'connecting' | 'connected' | 'ended' | 'error';

/**
 * Public, no-login page a person opens to play the "lead" being called in
 * the no-SIP live voice demo — see claude-dev/2026-07-22-live-voice-build-progress.md.
 * Joins the same LiveKit room as the AI worker and, later, the bridged agent.
 */
export default function LeadCallPage() {
  const { callId } = useParams<{ callId: string }>();
  const [status, setStatus] = useState<Status>('idle');
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState('');
  const roomRef = useRef<Room | null>(null);
  const audioContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => () => void roomRef.current?.disconnect(), []);

  async function join() {
    setStatus('connecting');
    setError('');
    try {
      const { data } = await axios.get(`${API_URL}/api/v1/calls/${callId}/lead-token`);
      const room = new Room();
      roomRef.current = room;

      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach();
          audioContainerRef.current?.appendChild(el);
        }
      });
      room.on(RoomEvent.Disconnected, () => setStatus('ended'));

      await room.connect(data.url, data.token);
      await room.localParticipant.setMicrophoneEnabled(true);
      setStatus('connected');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not join the call');
      setStatus('error');
    }
  }

  function toggleMute() {
    const room = roomRef.current;
    if (!room) return;
    const next = !muted;
    room.localParticipant.setMicrophoneEnabled(!next);
    setMuted(next);
  }

  function leave() {
    roomRef.current?.disconnect();
    setStatus('ended');
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0b1220', color: '#fff', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 420, textAlign: 'center' }}>
        <p style={{ fontSize: 12, letterSpacing: 1, textTransform: 'uppercase', color: '#8b9bb4', marginBottom: 8 }}>
          CoCally live voice demo
        </p>
        <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 16 }}>You are the lead</h1>
        <p style={{ color: '#8b9bb4', marginBottom: 24, fontSize: 14 }}>
          Allow microphone access and you&apos;ll be talking to CoCally&apos;s AI voice agent, exactly as a real
          customer would experience the call.
        </p>

        {status === 'idle' && (
          <button onClick={join} style={btnPrimary}>
            Join the call
          </button>
        )}
        {status === 'connecting' && <p>Connecting…</p>}
        {status === 'connected' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 20 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
              <span style={{ fontSize: 14 }}>Live — talking to the AI agent</span>
            </div>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
              <button onClick={toggleMute} style={btnSecondary}>
                {muted ? 'Unmute' : 'Mute'}
              </button>
              <button onClick={leave} style={btnDanger}>
                Leave call
              </button>
            </div>
          </>
        )}
        {status === 'ended' && <p>Call ended. You can close this tab.</p>}
        {status === 'error' && (
          <>
            <p style={{ color: '#f87171', marginBottom: 12 }}>{error}</p>
            <button onClick={join} style={btnPrimary}>
              Try again
            </button>
          </>
        )}

        <div ref={audioContainerRef} />
      </div>
    </div>
  );
}

const btnPrimary: React.CSSProperties = {
  background: '#22c55e',
  color: '#0b1220',
  fontWeight: 700,
  padding: '12px 28px',
  borderRadius: 999,
  border: 'none',
  cursor: 'pointer',
  fontSize: 15,
};
const btnSecondary: React.CSSProperties = {
  background: '#1e2a3f',
  color: '#fff',
  fontWeight: 600,
  padding: '10px 20px',
  borderRadius: 999,
  border: '1px solid #2c3b54',
  cursor: 'pointer',
};
const btnDanger: React.CSSProperties = {
  background: '#7f1d1d',
  color: '#fff',
  fontWeight: 600,
  padding: '10px 20px',
  borderRadius: 999,
  border: 'none',
  cursor: 'pointer',
};
