'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAppStore } from '@/lib/store';

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

interface DialResponse {
  callId: string;
  leadName: string;
  phone: string;
  cli: string | null;
  livekitUrl: string;
  livekitToken: string;
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

function resumeLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function dueLabel(iso: string): string {
  const due = new Date(iso);
  const mins = Math.round((due.getTime() - Date.now()) / 60000);
  if (mins < -60) return `${Math.round(-mins / 60)}h overdue`;
  if (mins < 0) return `${-mins}m overdue`;
  if (mins < 60) return `in ${mins}m`;
  return due.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/**
 * The worklist only — the live call itself (audio, mute, DTMF, briefing,
 * disposition) is owned by GlobalCallBar (mounted once in the app layout),
 * so an agent can dial from here, then click over to check something on
 * Leads or Campaigns without the call disappearing from under them.
 */
export default function ManualDialPage() {
  const { activeCall, setActiveCall } = useAppStore();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignId, setCampaignId] = useState('');
  const [leads, setLeads] = useState<ManualLead[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [callbacks, setCallbacks] = useState<CallbackRow[]>([]);

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
      if (!activeCall) {
        loadQueue().catch(() => undefined);
        loadCallbacks().catch(() => undefined);
      }
    }, 20_000);
    return () => clearInterval(timer);
  }, [loadQueue, loadCallbacks, activeCall]);

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
    if (activeCall) {
      flash('Finish your current call first.');
      return;
    }
    setBusy(true);
    try {
      const { data } = await api.post<DialResponse>(`/manual-dial/leads/${leadId}/dial`);
      setActiveCall({
        callId: data.callId,
        source: 'manual',
        leadName: data.leadName,
        phone: data.phone,
        cli: data.cli,
        livekitUrl: data.livekitUrl,
        livekitToken: data.livekitToken,
      });
    } catch (err) {
      const detail = (err as { response?: { data?: { message?: string } } }).response?.data;
      flash(typeof detail?.message === 'string' ? detail.message : 'Could not place the call.');
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

      {activeCall && (
        <div className="card p-3 text-sm" style={{ borderColor: 'var(--accent)' }}>
          You're on a call with <span className="font-semibold">{activeCall.leadName}</span> — see the call bar at the
          bottom of the screen to control it and log a disposition.
        </div>
      )}

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
                  <button className="btn btn-primary text-xs" disabled={busy || !!activeCall} onClick={() => dialById(cb.leadId)}>
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
                          disabled={busy || !!activeCall}
                          onClick={() => dialById(lead.id)}
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
    </div>
  );
}
