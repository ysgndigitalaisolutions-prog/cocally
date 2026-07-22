'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface TimelineEntry {
  at: string;
  kind: string;
  detail: string;
  state?: string;
  callId?: string;
}

interface LeadDetail {
  _id: string;
  phone: string;
  altPhones?: string[];
  email?: string;
  firstName?: string;
  lastName?: string;
  suburb?: string;
  state?: string;
  postcode?: string;
  timezone: string;
  state_: string;
  score: number;
  attempts: number;
  source?: string;
  tags?: string[];
  ownerId?: string;
  nextAttemptAt?: string;
  lastContactedAt?: string;
  custom?: Record<string, string>;
  timeline: TimelineEntry[];
}

interface Note {
  _id: string;
  authorLabel: string;
  text: string;
  createdAt: string;
}

interface CallRow {
  _id: string;
  startedAt: string;
  outcome?: string;
  disposition?: string;
  amdClass?: string;
  agentName?: string | null;
  finalScore?: number;
}

interface TeamMember {
  id: string;
  name: string;
  roles: string[];
}

const LEAD_STATES = [
  'FRESH',
  'ATTEMPTED',
  'CONTACTED',
  'QUALIFIED',
  'TRANSFERRED',
  'BOOKED',
  'CALLBACK',
  'NURTURE',
  'EXHAUSTED',
  'DNC',
];

const STATE_COLORS: Record<string, string> = {
  BOOKED: 'var(--good)',
  QUALIFIED: 'var(--good)',
  TRANSFERRED: 'var(--accent)',
  DNC: 'var(--bad)',
  EXHAUSTED: 'var(--bad)',
};

type Tab = 'details' | 'notes' | 'timeline' | 'calls';

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Lead detail drawer — the CRM record behind a row.
 *
 * Everything a caller or supervisor needs on one lead without leaving the list:
 * correct bad data, read the history, leave a note, see every call, and (for a
 * supervisor) move the lead's state or owner. Editing is deliberately restricted
 * to contact fields; state and ownership move through their own audited paths.
 */
export function LeadDrawer({
  leadId,
  canManage,
  onClose,
  onChanged,
}: {
  leadId: string;
  /** Supervisor/admin: may change state and reassign the owner. */
  canManage: boolean;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [lead, setLead] = useState<LeadDetail | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [tab, setTab] = useState<Tab>('details');
  const [draft, setDraft] = useState<Partial<LeadDetail>>({});
  const [noteText, setNoteText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    const { data } = await api.get<LeadDetail>(`/leads/${leadId}`);
    setLead(data);
    setDraft({
      firstName: data.firstName ?? '',
      lastName: data.lastName ?? '',
      email: data.email ?? '',
      suburb: data.suburb ?? '',
      state: data.state ?? '',
      postcode: data.postcode ?? '',
    });
    // Notes and call history are supplementary — an AGENT is not permitted to
    // list calls, so a 403 there must not blank out the whole drawer.
    const [n, c] = await Promise.all([
      api.get<Note[]>(`/leads/${leadId}/notes`).catch(() => ({ data: [] as Note[] })),
      api.get<CallRow[]>('/calls', { params: { leadId, limit: 50 } }).catch(() => ({ data: [] as CallRow[] })),
    ]);
    setNotes(n.data);
    setCalls(c.data);
  }, [leadId]);

  useEffect(() => {
    load().catch(() => setMsg('Could not load this lead.'));
  }, [load]);

  useEffect(() => {
    if (!canManage) return;
    api
      .get<TeamMember[]>('/workspace/team')
      .then((r) => setTeam(r.data))
      .catch(() => undefined);
  }, [canManage]);

  // Escape closes, matching the rest of the app's overlay behaviour.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function flash(text: string) {
    setMsg(text);
    setTimeout(() => setMsg(''), 3500);
  }

  async function saveDetails() {
    setBusy(true);
    try {
      await api.patch(`/leads/${leadId}`, draft);
      flash('Saved.');
      await load();
      onChanged?.();
    } catch {
      flash('Could not save.');
    } finally {
      setBusy(false);
    }
  }

  async function addNote() {
    if (!noteText.trim()) return;
    setBusy(true);
    try {
      await api.post(`/leads/${leadId}/notes`, { text: noteText });
      setNoteText('');
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function changeState(to: string) {
    const reason = window.prompt(`Reason for moving this lead to ${to}?`);
    if (!reason) return;
    setBusy(true);
    try {
      await api.post(`/leads/${leadId}/state`, { state: to, reason });
      flash(`Moved to ${to}.`);
      await load();
      onChanged?.();
    } catch (err) {
      const detail = (err as { response?: { data?: { message?: string } } }).response?.data;
      flash(typeof detail?.message === 'string' ? detail.message : 'Could not change state.');
    } finally {
      setBusy(false);
    }
  }

  async function reassign(toAgentId: string) {
    setBusy(true);
    try {
      await api.post('/leads/assignment/reassign', {
        leadIds: [leadId],
        toAgentId: toAgentId || null,
      });
      flash(toAgentId ? 'Reassigned.' : 'Returned to the pool.');
      await load();
      onChanged?.();
    } finally {
      setBusy(false);
    }
  }

  const tabs: Array<[Tab, string]> = [
    ['details', 'Details'],
    ['notes', `Notes${notes.length ? ` (${notes.length})` : ''}`],
    ['timeline', 'Timeline'],
    ['calls', `Calls${calls.length ? ` (${calls.length})` : ''}`],
  ];

  return (
    <div className="fixed inset-0 z-50 flex justify-end" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-xl flex-col overflow-hidden shadow-2xl"
        style={{ background: 'var(--surface)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b p-5" style={{ borderColor: 'var(--border)' }}>
          <div className="min-w-0">
            <h2 className="truncate text-xl font-bold">
              {[lead?.firstName, lead?.lastName].filter(Boolean).join(' ') || lead?.phone || 'Lead'}
            </h2>
            <p className="font-mono text-sm" style={{ color: 'var(--text-dim)' }}>{lead?.phone}</p>
            {lead && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span
                  className="rounded-full px-2 py-0.5 text-xs font-semibold"
                  style={{ background: 'var(--surface-2)', color: STATE_COLORS[lead.state_] ?? 'var(--text-dim)' }}
                >
                  {lead.state_}
                </span>
                <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
                  score {lead.score} · {lead.attempts} attempt{lead.attempts === 1 ? '' : 's'} · {lead.timezone}
                </span>
              </div>
            )}
          </div>
          <button className="btn btn-ghost text-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {msg && (
          <p className="px-5 pt-3 text-sm" style={{ color: 'var(--accent)' }}>{msg}</p>
        )}

        {/* Tabs */}
        <div className="flex gap-1 border-b px-5 pt-3" style={{ borderColor: 'var(--border)' }}>
          {tabs.map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className="rounded-t-lg px-3 py-2 text-sm font-semibold"
              style={
                tab === key
                  ? { background: 'var(--surface-2)', color: 'var(--accent)' }
                  : { color: 'var(--text-dim)' }
              }
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {!lead && <p style={{ color: 'var(--text-dim)' }}>Loading…</p>}

          {lead && tab === 'details' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                {(
                  [
                    ['firstName', 'First name'],
                    ['lastName', 'Last name'],
                    ['email', 'Email'],
                    ['suburb', 'Suburb'],
                    ['state', 'State'],
                    ['postcode', 'Postcode'],
                  ] as Array<[keyof LeadDetail, string]>
                ).map(([field, label]) => (
                  <label key={field} className="text-xs" style={{ color: 'var(--text-dim)' }}>
                    {label}
                    <input
                      className="input mt-1"
                      value={(draft[field] as string) ?? ''}
                      onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
                    />
                  </label>
                ))}
              </div>
              <button className="btn btn-primary text-sm" disabled={busy} onClick={saveDetails}>
                Save details
              </button>

              <dl className="grid grid-cols-2 gap-3 border-t pt-4 text-xs" style={{ borderColor: 'var(--border)' }}>
                {[
                  ['Source', lead.source ?? '—'],
                  ['Tags', lead.tags?.length ? lead.tags.join(', ') : '—'],
                  ['Next attempt', lead.nextAttemptAt ? when(lead.nextAttemptAt) : '—'],
                  ['Last contacted', lead.lastContactedAt ? when(lead.lastContactedAt) : '—'],
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt style={{ color: 'var(--text-dim)' }}>{k}</dt>
                    <dd className="font-medium">{v}</dd>
                  </div>
                ))}
              </dl>

              {lead.custom && Object.keys(lead.custom).length > 0 && (
                <div className="border-t pt-4" style={{ borderColor: 'var(--border)' }}>
                  <p className="mb-2 text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                    Imported fields
                  </p>
                  <dl className="grid grid-cols-2 gap-2 text-xs">
                    {Object.entries(lead.custom).map(([k, v]) => (
                      <div key={k}>
                        <dt style={{ color: 'var(--text-dim)' }}>{k}</dt>
                        <dd>{v}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}

              {canManage && (
                <div className="space-y-3 border-t pt-4" style={{ borderColor: 'var(--border)' }}>
                  <div>
                    <p className="mb-1 text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                      Owner
                    </p>
                    <select
                      className="input"
                      value={lead.ownerId ?? ''}
                      disabled={busy}
                      onChange={(e) => reassign(e.target.value)}
                    >
                      <option value="">— Unassigned (shared pool) —</option>
                      {team.map((m) => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <p className="mb-1 text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                      Move state
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {LEAD_STATES.filter((s) => s !== lead.state_).map((s) => (
                        <button
                          key={s}
                          className="btn btn-ghost text-xs"
                          disabled={busy}
                          onClick={() => changeState(s)}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {lead && tab === 'notes' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <textarea
                  className="input h-20"
                  placeholder="Add a note about this lead…"
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                />
                <button className="btn btn-primary text-sm" disabled={busy || !noteText.trim()} onClick={addNote}>
                  Add note
                </button>
              </div>
              {notes.length === 0 && (
                <p className="text-sm" style={{ color: 'var(--text-dim)' }}>No notes yet.</p>
              )}
              {notes.map((n) => (
                <div key={n._id} className="rounded-lg p-3" style={{ background: 'var(--surface-2)' }}>
                  <p className="text-sm">{n.text}</p>
                  <p className="mt-1 text-xs" style={{ color: 'var(--text-dim)' }}>
                    {n.authorLabel} · {when(n.createdAt)}
                  </p>
                </div>
              ))}
            </div>
          )}

          {lead && tab === 'timeline' && (
            <div className="space-y-2">
              {lead.timeline.length === 0 && (
                <p className="text-sm" style={{ color: 'var(--text-dim)' }}>Nothing recorded yet.</p>
              )}
              {[...lead.timeline].reverse().map((t, i) => (
                <div
                  key={`${t.at}-${i}`}
                  className="rounded-lg p-3"
                  style={{ background: 'var(--surface-2)', borderLeft: '3px solid var(--accent-dim)' }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold" style={{ color: 'var(--accent)' }}>{t.kind}</span>
                    <span className="text-xs" style={{ color: 'var(--text-dim)' }}>{when(t.at)}</span>
                  </div>
                  <p className="mt-1 text-sm">{t.detail}</p>
                </div>
              ))}
            </div>
          )}

          {lead && tab === 'calls' && (
            <div className="space-y-2">
              {calls.length === 0 && (
                <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
                  No calls recorded for this lead.
                </p>
              )}
              {calls.map((c) => (
                <div key={c._id} className="rounded-lg p-3" style={{ background: 'var(--surface-2)' }}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{c.disposition ?? c.outcome ?? 'In progress'}</span>
                    <span className="text-xs" style={{ color: 'var(--text-dim)' }}>{when(c.startedAt)}</span>
                  </div>
                  <p className="mt-1 text-xs" style={{ color: 'var(--text-dim)' }}>
                    {[c.agentName ?? 'AI only', c.amdClass, c.finalScore != null ? `score ${c.finalScore}` : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
