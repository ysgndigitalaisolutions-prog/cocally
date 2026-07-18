'use client';

import { useEffect, useRef, useState } from 'react';
import type { FloorCallCard, TransferCard } from '@cocally/shared';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { useAppStore } from '@/lib/store';

const PRESENCE_OPTIONS = ['AVAILABLE', 'WRAP_UP', 'BREAK', 'OFFLINE'] as const;
const DISPOSITIONS = [
  ['BOOKED', 'Booked'],
  ['CALLBACK', 'Callback'],
  ['NOT_INTERESTED', 'Not interested'],
  ['NOT_QUALIFIED', 'Not qualified'],
  ['WRONG_NUMBER', 'Wrong number'],
  ['DO_NOT_CALL', 'Do not call'],
  ['FOLLOW_UP', 'Follow up'],
] as const;

export default function WorkspacePage() {
  const { presence, setPresence, transferOffer, setTransferOffer, activeCallId, setActiveCallId } = useAppStore();
  const [floor, setFloor] = useState<Record<string, FloorCallCard>>({});
  const [transcript, setTranscript] = useState<Array<{ speaker: string; text: string }>>([]);
  const [summary, setSummary] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [notes, setNotes] = useState('');
  const offerRef = useRef<TransferCard | null>(null);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

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
      socket.off('transfer.offer');
      socket.off('transfer.cancelled');
      socket.off('transfer.bridged');
      socket.off('floor.call.updated');
      socket.off('floor.call.removed');
      socket.off('transcript.segment');
      socket.off('call.summary.updated');
    };
  }, [setActiveCallId, setTransferOffer]);

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

  async function changePresence(state: (typeof PRESENCE_OPTIONS)[number]) {
    await api.post('/workspace/presence', { state });
    setPresence(state);
  }

  async function acceptOffer() {
    if (!transferOffer) return;
    await api.post(`/workspace/transfers/${transferOffer.transferId}/accept`);
  }

  async function declineOffer() {
    if (!transferOffer) return;
    await api.post(`/workspace/transfers/${transferOffer.transferId}/decline`);
    setTransferOffer(null);
  }

  async function setDisposition(disposition: string) {
    if (!activeCallId) return;
    await api.post(`/calls/${activeCallId}/disposition`, { disposition, notes: notes || undefined });
    setActiveCallId(null);
    setTranscript([]);
    setSummary('');
    setNotes('');
    setPresence('WRAP_UP');
  }

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
          <h2 className="mb-2 font-semibold" style={{ color: 'var(--good)' }}>
            On call
          </h2>
          {summary && (
            <div className="mb-4 rounded-lg p-3 text-sm" style={{ background: 'var(--surface-2)' }}>
              <span className="font-semibold">Summary: </span>
              {summary}
            </div>
          )}
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
        </div>
      )}

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
