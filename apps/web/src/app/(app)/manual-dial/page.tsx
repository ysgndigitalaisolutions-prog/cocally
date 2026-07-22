'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface ManualLead {
  id: string;
  name: string;
  phone: string;
  location: string;
  state_: string;
  score: number;
  attempts: number;
  campaignId: string;
  campaignName: string;
  claimedByMe: boolean;
  claimedByOther: boolean;
  callableNow: boolean;
  blockReason: string | null;
  resumesAt: string | null;
}

interface Campaign {
  _id: string;
  name: string;
}

interface ActiveCall {
  callId: string;
  leadName: string;
  phone: string;
}

interface CallbackRow {
  id: string;
  leadId: string;
  leadName: string;
  phone: string;
  campaignId: string;
  dueAt: string;
  overdue: boolean;
  notes: string | null;
}

const DISPOSITIONS: Array<[string, string]> = [
  ['BOOKED', 'Booked'],
  ['CALLBACK', 'Callback'],
  ['NOT_INTERESTED', 'Not interested'],
  ['NOT_QUALIFIED', 'Not qualified'],
  ['WRONG_NUMBER', 'Wrong number'],
  ['DO_NOT_CALL', 'Do not call'],
  ['FOLLOW_UP', 'Follow up'],
];

/** Dispositions that must capture a date before they can be logged. */
const NEEDS_SCHEDULE = new Set(['BOOKED', 'CALLBACK']);

function resumeLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/** `datetime-local` needs a local (not UTC) value, trimmed to minutes. */
function localInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dueLabel(iso: string): string {
  const due = new Date(iso);
  const mins = Math.round((due.getTime() - Date.now()) / 60000);
  if (mins < -60) return `${Math.round(-mins / 60)}h overdue`;
  if (mins < 0) return `${-mins}m overdue`;
  if (mins < 60) return `in ${mins}m`;
  return due.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/** Simulated call lifecycle for the manual dialer (no real audio leg yet). */
type CallPhase = 'dialing' | 'ringing' | 'connected';
const PHASE_META: Record<CallPhase, { label: string; dot: string }> = {
  dialing: { label: 'Dialing…', dot: 'var(--accent)' },
  ringing: { label: 'Ringing…', dot: 'var(--accent)' },
  connected: { label: 'Connected', dot: 'var(--good)' },
};

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function ManualDialPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignId, setCampaignId] = useState('');
  const [leads, setLeads] = useState<ManualLead[]>([]);
  const [active, setActive] = useState<ActiveCall | null>(null);
  const [callPhase, setCallPhase] = useState<CallPhase>('dialing');
  const [elapsed, setElapsed] = useState(0);
  const [notes, setNotes] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [callbacks, setCallbacks] = useState<CallbackRow[]>([]);
  // When a disposition needs a date (BOOKED/CALLBACK) we stage it here first.
  const [pending, setPending] = useState<{ value: string; when: string } | null>(null);

  useEffect(() => {
    api.get('/campaigns').then((r) => setCampaigns(r.data)).catch(() => undefined);
  }, []);

  const loadQueue = useCallback(async () => {
    const { data } = await api.get<ManualLead[]>('/manual-dial/queue', {
      params: campaignId ? { campaignId } : {},
    });
    setLeads(data);
  }, [campaignId]);

  const loadCallbacks = useCallback(async () => {
    const { data } = await api.get<CallbackRow[]>('/leads/callbacks/mine', { params: { withinHours: 24 } });
    setCallbacks(data);
  }, []);

  useEffect(() => {
    loadQueue().catch(() => undefined);
    loadCallbacks().catch(() => undefined);
    // Refresh so calling-window verdicts stay current, but not while on a call.
    const timer = setInterval(() => {
      if (!active) {
        loadQueue().catch(() => undefined);
        loadCallbacks().catch(() => undefined);
      }
    }, 20_000);
    return () => clearInterval(timer);
  }, [loadQueue, loadCallbacks, active]);

  // Simulated dial progression: dialing → ringing → connected once a call starts.
  useEffect(() => {
    if (!active) {
      setCallPhase('dialing');
      setElapsed(0);
      return;
    }
    setCallPhase('dialing');
    setElapsed(0);
    const toRinging = setTimeout(() => setCallPhase('ringing'), 1200);
    const toConnected = setTimeout(() => setCallPhase('connected'), 3800);
    return () => {
      clearTimeout(toRinging);
      clearTimeout(toConnected);
    };
  }, [active]);

  // Live call timer, running only once "connected".
  useEffect(() => {
    if (callPhase !== 'connected') return;
    const timer = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(timer);
  }, [callPhase]);

  function flash(text: string) {
    setMessage(text);
    setTimeout(() => setMessage(''), 3500);
  }

  async function claim(lead: ManualLead) {
    await api.post(`/manual-dial/leads/${lead.id}/claim`).catch(() => undefined);
    await loadQueue();
  }

  async function release(lead: ManualLead) {
    await api.post(`/manual-dial/leads/${lead.id}/release`).catch(() => undefined);
    await loadQueue();
  }

  async function dialById(leadId: string) {
    setBusy(true);
    try {
      const { data } = await api.post<ActiveCall>(`/manual-dial/leads/${leadId}/dial`);
      setActive(data);
      setNotes('');
      setPending(null);
    } catch (err) {
      const detail = (err as { response?: { data?: { message?: string } } }).response?.data;
      flash(typeof detail?.message === 'string' ? detail.message : 'Could not place the call.');
    } finally {
      setBusy(false);
    }
  }

  const dial = (lead: ManualLead) => dialById(lead.id);

  /**
   * BOOKED and CALLBACK are meaningless without a date — a booking with no time
   * creates no appointment, and a callback with no time is a promise nobody can
   * work. Stage those for a date, and log everything else immediately.
   */
  function chooseDisposition(value: string) {
    if (!NEEDS_SCHEDULE.has(value)) {
      void submitDisposition(value);
      return;
    }
    const suggested = new Date(Date.now() + (value === 'CALLBACK' ? 2 : 24) * 3600 * 1000);
    setPending({ value, when: localInputValue(suggested) });
  }

  async function submitDisposition(value: string, when?: string) {
    if (!active) return;
    setBusy(true);
    try {
      await api.post(`/calls/${active.callId}/disposition`, {
        disposition: value,
        notes: notes || undefined,
        scheduledFor: when ? new Date(when).toISOString() : undefined,
        ...(value === 'BOOKED' && when ? { durationMinutes: 60 } : {}),
      });
      flash(
        when
          ? `Logged: ${value.replace(/_/g, ' ')} for ${new Date(when).toLocaleString()}.`
          : `Logged: ${value.replace(/_/g, ' ')}.`,
      );
      setActive(null);
      setPending(null);
      await Promise.all([loadQueue(), loadCallbacks()]);
    } catch (err) {
      const detail = (err as { response?: { data?: { message?: string } } }).response?.data;
      flash(typeof detail?.message === 'string' ? detail.message : 'Could not log the disposition.');
    } finally {
      setBusy(false);
    }
  }

  const claimedByMe = leads.filter((l) => l.claimedByMe);
  const available = leads.filter((l) => !l.claimedByOther);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Manual dial</h1>
          <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
            Your personal worklist — these leads are assigned to you, so no other caller sees them. It tops itself up as
            you work through it. Claimed leads are also held out of the automatic dialer.
          </p>
        </div>
        <select className="input max-w-xs" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
          <option value="">All my campaigns</option>
          {campaigns.map((c) => (
            <option key={c._id} value={c._id}>{c.name}</option>
          ))}
        </select>
      </div>

      {message && <p className="text-sm" style={{ color: 'var(--accent)' }}>{message}</p>}

      {/* Simulation notice — the call workflow is real, the audio is not yet. */}
      <div className="card p-3 text-xs" style={{ color: 'var(--text-dim)', borderColor: 'var(--accent-dim)' }}>
        Telephony runs in <b>simulation</b>: the call is created, attributed to you, and closed with a disposition just
        like a live call — but there is no audio leg until the SIP integration is wired. The compliance gates (calling
        window, DNC, suppression, kill switch) are enforced for real.
      </div>

      {active ? (
        <section className="card space-y-4 p-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span
                className={`relative inline-flex h-3 w-3 rounded-full ${callPhase !== 'connected' ? 'animate-pulse' : ''}`}
                style={{
                  background: PHASE_META[callPhase].dot,
                  boxShadow: `0 0 0 4px color-mix(in srgb, ${PHASE_META[callPhase].dot} 25%, transparent)`,
                }}
              />
              <div>
                <h2 className="text-lg font-bold">
                  {callPhase === 'connected' ? 'On call' : PHASE_META[callPhase].label} · {active.leadName}
                </h2>
                <p className="font-mono text-sm" style={{ color: 'var(--text-dim)' }}>{active.phone}</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                {PHASE_META[callPhase].label}
              </p>
              {callPhase === 'connected' && (
                <p className="font-mono text-lg font-bold tabular-nums" style={{ color: 'var(--good)' }}>
                  {formatDuration(elapsed)}
                </p>
              )}
            </div>
          </div>

          {callPhase !== 'connected' ? (
            <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
              Connecting the call… (simulated — no audio leg yet)
            </p>
          ) : (
            <>
              <textarea
                className="input h-24"
                placeholder="Call notes (optional)…"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
              {pending ? (
                <div className="rounded-lg p-4" style={{ background: 'var(--surface-2)' }}>
                  <p className="mb-2 text-sm font-semibold">
                    {pending.value === 'BOOKED' ? 'When is the appointment?' : 'When should we call back?'}
                  </p>
                  <p className="mb-3 text-xs" style={{ color: 'var(--text-dim)' }}>
                    {pending.value === 'BOOKED'
                      ? 'Creates the appointment against this lead.'
                      : 'Creates a callback task in your book and holds the lead for you until then.'}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="datetime-local"
                      className="input max-w-xs"
                      value={pending.when}
                      onChange={(e) => setPending({ ...pending, when: e.target.value })}
                    />
                    <button
                      className="btn btn-primary text-sm"
                      disabled={busy || !pending.when}
                      onClick={() => submitDisposition(pending.value, pending.when)}
                    >
                      Confirm {pending.value === 'BOOKED' ? 'booking' : 'callback'}
                    </button>
                    <button className="btn btn-ghost text-sm" disabled={busy} onClick={() => setPending(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  <p className="mb-2 text-sm font-semibold">Disposition to end the call</p>
                  <div className="flex flex-wrap gap-2">
                    {DISPOSITIONS.map(([value, label]) => (
                      <button
                        key={value}
                        className="btn btn-ghost text-sm"
                        disabled={busy}
                        onClick={() => chooseDisposition(value)}
                        style={value === 'BOOKED' ? { borderColor: 'var(--good)', color: 'var(--good)' } : undefined}
                      >
                        {label}
                        {NEEDS_SCHEDULE.has(value) && ' …'}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      ) : (
        <>
          {/* Promises come first: a missed callback is the most expensive thing on this screen. */}
          {callbacks.length > 0 && (
            <section className="card p-4">
              <div className="mb-3 flex items-center gap-2">
                <h2 className="text-sm font-semibold">Your callbacks</h2>
                {callbacks.some((c) => c.overdue) && (
                  <span
                    className="rounded-full px-2 py-0.5 text-xs font-semibold"
                    style={{ background: 'var(--bad)', color: '#0b1220' }}
                  >
                    {callbacks.filter((c) => c.overdue).length} overdue
                  </span>
                )}
              </div>
              <div className="space-y-2">
                {callbacks.map((cb) => (
                  <div
                    key={cb.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg p-3"
                    style={{
                      background: 'var(--surface-2)',
                      borderLeft: `3px solid ${cb.overdue ? 'var(--bad)' : 'var(--accent)'}`,
                    }}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{cb.leadName}</p>
                      <p className="font-mono text-xs" style={{ color: 'var(--text-dim)' }}>
                        {cb.phone}
                        {cb.notes ? ` · ${cb.notes}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span
                        className="text-xs font-semibold"
                        style={{ color: cb.overdue ? 'var(--bad)' : 'var(--text-dim)' }}
                      >
                        {dueLabel(cb.dueAt)}
                      </span>
                      <button className="btn btn-primary text-xs" disabled={busy} onClick={() => dialById(cb.leadId)}>
                        ☎ Call
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {claimedByMe.length > 0 && (
            <section className="card p-4">
              <h2 className="mb-2 text-sm font-semibold">Your claimed leads ({claimedByMe.length})</h2>
              <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
                These are reserved to you and hidden from the AI dialer until you call or release them.
              </p>
            </section>
          )}

          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left" style={{ color: 'var(--text-dim)' }}>
                  <th className="p-3">Name</th>
                  <th className="p-3">Phone</th>
                  <th className="p-3">Campaign</th>
                  <th className="p-3">Location</th>
                  <th className="p-3">State</th>
                  <th className="p-3">Score</th>
                  <th className="p-3">Attempts</th>
                  <th className="p-3" />
                </tr>
              </thead>
              <tbody>
                {available.length === 0 && (
                  <tr>
                    <td colSpan={8} className="p-4 text-center" style={{ color: 'var(--text-dim)' }}>
                      Your worklist is empty — either the campaign pool is exhausted or you have no campaigns assigned.
                    </td>
                  </tr>
                )}
                {available.map((lead) => (
                  <tr key={lead.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td className="p-3 font-medium">
                      {lead.name}
                      {lead.claimedByMe && (
                        <span className="ml-2 text-xs" style={{ color: 'var(--accent)' }}>claimed</span>
                      )}
                    </td>
                    <td className="p-3 font-mono text-xs">{lead.phone}</td>
                    <td className="p-3">{lead.campaignName}</td>
                    <td className="p-3">{lead.location || '—'}</td>
                    <td className="p-3">{lead.state_}</td>
                    <td className="p-3 font-semibold">{lead.score}</td>
                    <td className="p-3">{lead.attempts}</td>
                    <td className="p-3">
                      <div className="flex items-center justify-end gap-2">
                        {!lead.callableNow && lead.blockReason ? (
                          <span className="text-xs" style={{ color: 'var(--text-dim)' }} title={lead.blockReason}>
                            {lead.resumesAt ? `opens ${resumeLabel(lead.resumesAt)}` : lead.blockReason}
                          </span>
                        ) : (
                          <>
                            {lead.claimedByMe ? (
                              <button className="btn btn-ghost text-xs" onClick={() => release(lead)}>Release</button>
                            ) : (
                              <button className="btn btn-ghost text-xs" onClick={() => claim(lead)}>Claim</button>
                            )}
                            <button
                              className="btn btn-primary text-xs"
                              disabled={busy}
                              onClick={() => dial(lead)}
                            >
                              ☎ Call
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
