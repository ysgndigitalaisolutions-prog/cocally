'use client';

import { useEffect, useRef, useState } from 'react';
import { AGENT_TRANSFER_KINDS, type AgentTransferKind } from '@cocally/shared';
import { api } from '@/lib/api';
import { useAppStore } from '@/lib/store';

interface TeamMember {
  id: string;
  name: string;
  roles: string[];
  presence: string;
  availableSince: string | null;
  talkTimeTodaySeconds: number;
}

/** Offer result handed back to GlobalCallBar, which owns the waiting/cancel UI. */
export interface OfferedTransfer {
  transferId: string;
  kind: AgentTransferKind;
  toAgentName: string;
  acceptDeadline: number;
  /**
   * Non-null when the server parked the customer to make this offer (BLIND and
   * WARM do; CONFERENCE does not). The browser — not the server — has to
   * actually produce that audio, so the bar needs this URL.
   */
  holdMusicUrl: string | null;
}

interface Props {
  callId: string;
  onClose: () => void;
  onOffered: (offered: OfferedTransfer) => void;
  /** The customer has been handed off-platform; the call is over for this agent. */
  onExternalTransferred: (destination: string) => void;
}

const KIND_COPY: Record<AgentTransferKind, { label: string; detail: string }> = {
  BLIND: {
    label: 'Blind',
    detail: 'Hands the customer straight over. You drop off as soon as they accept — no introduction.',
  },
  WARM: {
    label: 'Warm',
    detail: 'Customer waits on hold while you brief the other agent, then you complete the handover.',
  },
  CONFERENCE: {
    label: 'Conference',
    detail: 'Both of you stay on with the customer. Nobody is put on hold.',
  },
};

function errorMessage(err: unknown, fallback: string): string {
  const detail = (err as { response?: { data?: { message?: string | string[] } } }).response?.data?.message;
  if (Array.isArray(detail)) return detail.join(', ');
  return typeof detail === 'string' ? detail : fallback;
}

/**
 * Transfer picker for a live call: agent-to-agent (blind / warm / conference)
 * on one tab, off-platform on the other.
 *
 * The two are deliberately separated rather than being one "destination" field.
 * An in-platform transfer keeps the customer on a call we can record, supervise
 * and disposition; an external one hands them to a number we have no visibility
 * into and bills a second carrier leg for the whole of the onward conversation.
 * They are different decisions and the UI says so.
 */
export default function TransferDialog({ callId, onClose, onOffered, onExternalTransferred }: Props) {
  const { user } = useAppStore();
  const [tab, setTab] = useState<'agent' | 'external'>('agent');
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [kind, setKind] = useState<AgentTransferKind>('WARM');
  const [toAgentId, setToAgentId] = useState('');
  const [note, setNote] = useState('');
  const [destination, setDestination] = useState('');
  const [externalConfirmed, setExternalConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // The roster is polled while the dialog is open: "available" goes stale in
  // seconds on a live floor, and offering to someone who just went on a call
  // is a guaranteed rejection ("… is not available right now").
  useEffect(() => {
    const load = () =>
      api
        .get('/workspace/team')
        .then((r) => setTeam(r.data))
        .catch(() => undefined);
    load();
    const timer = setInterval(load, 5_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    dialogRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Only AVAILABLE agents/supervisors can be offered a call — the API rejects
  // anyone else, so showing them here would only produce a failed click.
  const candidates = team.filter(
    (m) =>
      m.id !== user?.id &&
      m.presence === 'AVAILABLE' &&
      (m.roles.includes('AGENT') || m.roles.includes('SUPERVISOR')),
  );

  async function offerToAgent() {
    if (!toAgentId) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.post(`/call-control/calls/${callId}/transfer/agent`, {
        kind,
        toAgentId,
        note: note.trim() || undefined,
      });
      onOffered({
        transferId: r.data.transferId,
        kind,
        toAgentName: candidates.find((c) => c.id === toAgentId)?.name ?? 'the other agent',
        acceptDeadline: r.data.acceptDeadline,
        holdMusicUrl: r.data.holdMusicUrl ?? null,
      });
      onClose();
    } catch (err) {
      setError(errorMessage(err, 'Could not offer the transfer.'));
    } finally {
      setBusy(false);
    }
  }

  async function transferExternal() {
    if (!destination.trim() || !externalConfirmed) return;
    setBusy(true);
    setError('');
    try {
      await api.post(`/call-control/calls/${callId}/transfer/external`, { destination: destination.trim() });
      onExternalTransferred(destination.trim());
      onClose();
    } catch (err) {
      setError(errorMessage(err, 'Could not transfer the call.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Transfer this call"
        tabIndex={-1}
        className="card w-full max-w-xl overflow-hidden outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-5 py-3" style={{ borderColor: 'var(--border)' }}>
          <h2 className="text-lg font-bold">Transfer call</h2>
          <button className="btn btn-ghost text-sm" onClick={onClose} aria-label="Close transfer dialog">
            ✕
          </button>
        </div>

        <div className="flex gap-1 border-b px-5 pt-3" style={{ borderColor: 'var(--border)' }}>
          {(['agent', 'external'] as const).map((value) => (
            <button
              key={value}
              role="tab"
              aria-selected={tab === value}
              onClick={() => {
                setTab(value);
                setError('');
              }}
              className="rounded-t-lg px-3 py-2 text-sm font-semibold"
              style={
                tab === value
                  ? { background: 'var(--surface-2)', color: 'var(--accent)' }
                  : { color: 'var(--text-dim)' }
              }
            >
              {value === 'agent' ? 'To an agent' : 'External number'}
            </button>
          ))}
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
          {error && (
            <p className="mb-3 text-sm" style={{ color: 'var(--bad)' }}>
              {error}
            </p>
          )}

          {tab === 'agent' ? (
            <>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                How
              </p>
              <div className="mb-2 flex gap-2">
                {AGENT_TRANSFER_KINDS.map((value) => (
                  <button
                    key={value}
                    onClick={() => setKind(value)}
                    className="btn flex-1 text-sm"
                    aria-pressed={kind === value}
                    style={
                      kind === value
                        ? { background: 'var(--accent)', color: '#0b1220' }
                        : { background: 'var(--surface-2)', color: 'var(--text-dim)', border: '1px solid var(--border)' }
                    }
                  >
                    {KIND_COPY[value].label}
                  </button>
                ))}
              </div>
              <p className="mb-4 text-xs" style={{ color: 'var(--text-dim)' }}>
                {KIND_COPY[kind].detail}
              </p>

              <p className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                Who — available now
              </p>
              {candidates.length === 0 ? (
                <p className="mb-4 rounded-lg p-3 text-sm" style={{ background: 'var(--surface-2)', color: 'var(--text-dim)' }}>
                  Nobody is available to take a transfer right now. Keep the customer with you, or use an external
                  number.
                </p>
              ) : (
                <div className="mb-4 divide-y rounded-lg" style={{ background: 'var(--surface-2)' }}>
                  {candidates.map((member) => (
                    <button
                      key={member.id}
                      onClick={() => setToAgentId(member.id)}
                      aria-pressed={toAgentId === member.id}
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-sm"
                      style={
                        toAgentId === member.id
                          ? { border: '1px solid var(--accent)', borderRadius: '0.5rem', color: 'var(--accent)' }
                          : { borderColor: 'var(--border)' }
                      }
                    >
                      <span className="flex items-center gap-2">
                        <span className="inline-flex h-2 w-2 rounded-full" style={{ background: 'var(--good)' }} />
                        <span className="font-medium">{member.name}</span>
                        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
                          {member.roles.join(', ').toLowerCase()}
                        </span>
                      </span>
                      <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
                        {member.availableSince
                          ? `idle ${Math.max(0, Math.round((Date.now() - new Date(member.availableSince).getTime()) / 60000))}m`
                          : ''}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide" htmlFor="transfer-note" style={{ color: 'var(--text-dim)' }}>
                Note for the receiving agent (optional)
              </label>
              <textarea
                id="transfer-note"
                className="input mb-4 h-16"
                maxLength={280}
                placeholder="e.g. wants the 3-year plan, already price-matched…"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />

              <div className="flex justify-end gap-2">
                <button className="btn btn-ghost text-sm" onClick={onClose} disabled={busy}>
                  Cancel
                </button>
                <button className="btn btn-primary text-sm" onClick={offerToAgent} disabled={busy || !toAgentId}>
                  {busy ? 'Offering…' : `Offer ${KIND_COPY[kind].label.toLowerCase()} transfer`}
                </button>
              </div>
            </>
          ) : (
            <>
              <div
                className="mb-4 rounded-lg border p-3 text-sm"
                style={{ borderColor: 'var(--bad)', background: 'var(--surface-2)' }}
              >
                <p className="font-bold" style={{ color: 'var(--bad)' }}>
                  This hands the customer off the platform.
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5" style={{ color: 'var(--text-dim)' }}>
                  <li>You cannot get them back, monitor the rest of the call, or record it.</li>
                  <li>A second carrier leg is billed for as long as the onward call lasts.</li>
                  <li>You still have to disposition the call afterwards.</li>
                </ul>
              </div>

              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide" htmlFor="transfer-destination" style={{ color: 'var(--text-dim)' }}>
                Destination
              </label>
              <input
                id="transfer-destination"
                className="input mb-1"
                placeholder="+61399998888"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
              />
              <p className="mb-4 text-xs" style={{ color: 'var(--text-dim)' }}>
                Full international format (+61…), or a <code>sip:</code> / <code>tel:</code> URI.
              </p>

              <label className="mb-4 flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={externalConfirmed}
                  onChange={(e) => setExternalConfirmed(e.target.checked)}
                />
                <span>I have told the customer they are being transferred out.</span>
              </label>

              <div className="flex justify-end gap-2">
                <button className="btn btn-ghost text-sm" onClick={onClose} disabled={busy}>
                  Cancel
                </button>
                <button
                  className="btn btn-danger text-sm"
                  onClick={transferExternal}
                  disabled={busy || !destination.trim() || !externalConfirmed}
                >
                  {busy ? 'Transferring…' : 'Transfer off platform'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
