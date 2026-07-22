'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface CampaignOption {
  _id: string;
  name: string;
  status: string;
  activeFlowVersionId?: string | null;
}

interface ManualLeadRow {
  id: string;
  name: string;
  campaignId: string;
}

/**
 * Admin console control for the no-SIP live voice demo: real LiveKit audio,
 * either a browser "lead" join link or a real Twilio SIP dial-out to a phone
 * number. Separate from the agent workspace — agents only ever see the
 * resulting transfer offer + on-call audio, never the dial trigger itself.
 * See claude-dev/2026-07-22-live-voice-build-progress.md.
 */
export default function LiveDemoPage() {
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);
  const [demoCampaignId, setDemoCampaignId] = useState('');
  const [demoLeads, setDemoLeads] = useState<ManualLeadRow[]>([]);
  const [demoLeadId, setDemoLeadId] = useState('');
  const [demoStarting, setDemoStarting] = useState(false);
  const [demoLink, setDemoLink] = useState<{ callId: string; url: string } | null>(null);
  const [dialMode, setDialMode] = useState<'browser' | 'phone'>('browser');
  // Prepopulated with the verified Twilio test number + a friendly default
  // name (whoever is actually answering the demo call is rarely the seeded
  // lead) — both editable, not hardcoded requirements.
  const [demoPhoneNumber, setDemoPhoneNumber] = useState('+919902352425');
  const [demoLeadName, setDemoLeadName] = useState('Nithin');
  const [demoDialed, setDemoDialed] = useState<string | null>(null);
  const [demoError, setDemoError] = useState('');

  useEffect(() => {
    api.get('/campaigns').then((r) => setCampaigns(r.data)).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!demoCampaignId) {
      setDemoLeads([]);
      return;
    }
    api
      .get('/manual-dial/queue', { params: { campaignId: demoCampaignId } })
      .then((r) => setDemoLeads(r.data))
      .catch(() => setDemoLeads([]));
  }, [demoCampaignId]);

  async function startLiveDemo() {
    if (!demoCampaignId || !demoLeadId) return;
    if (dialMode === 'phone' && !demoPhoneNumber.trim()) return;
    setDemoStarting(true);
    setDemoError('');
    setDemoLink(null);
    setDemoDialed(null);
    try {
      const { data } = await api.post('/calls/live-demo', {
        campaignId: demoCampaignId,
        leadId: demoLeadId,
        dialMode,
        phoneNumber: dialMode === 'phone' ? demoPhoneNumber.trim() : undefined,
        leadFirstName: demoLeadName.trim() || undefined,
      });
      if (data.leadJoinPath) setDemoLink({ callId: data.callId, url: `${window.location.origin}${data.leadJoinPath}` });
      if (data.dialed) setDemoDialed(data.dialed);
    } catch (e) {
      setDemoError(
        (e as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Could not start the call.',
      );
    } finally {
      setDemoStarting(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Live voice demo</h1>

      <div className="card p-6">
        <h2 className="mb-1 font-semibold">Start live demo call</h2>
        <p className="mb-3 text-xs" style={{ color: 'var(--text-dim)' }}>
          Pick a campaign and lead, then either share a browser join link or dial a real phone. The AI voice
          agent talks for real over LiveKit; a qualifying call transfers to whichever agent is next in the pool
          — the agent only ever sees the transfer offer and on-call audio, not this control.
        </p>
        <div className="mb-3 flex gap-2">
          <button
            onClick={() => setDialMode('browser')}
            className="btn text-xs"
            style={dialMode === 'browser' ? { background: 'var(--accent)', color: '#0b1220' } : { background: 'var(--surface-2)', color: 'var(--text-dim)' }}
          >
            Browser link
          </button>
          <button
            onClick={() => setDialMode('phone')}
            className="btn text-xs"
            style={dialMode === 'phone' ? { background: 'var(--accent)', color: '#0b1220' } : { background: 'var(--surface-2)', color: 'var(--text-dim)' }}
          >
            Real phone (Twilio)
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="input w-auto"
            value={demoCampaignId}
            onChange={(e) => {
              setDemoCampaignId(e.target.value);
              setDemoLeadId('');
            }}
          >
            <option value="">Select campaign…</option>
            {campaigns.map((c) => {
              const ready = c.status === 'ACTIVE' && Boolean(c.activeFlowVersionId);
              return (
                <option key={c._id} value={c._id} disabled={!ready}>
                  {c.name}
                  {!ready ? ` (${c.status.toLowerCase()}, not dialable)` : ''}
                </option>
              );
            })}
          </select>
          <select className="input w-auto" value={demoLeadId} onChange={(e) => setDemoLeadId(e.target.value)} disabled={!demoCampaignId}>
            <option value="">Select lead…</option>
            {demoLeads.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          {demoCampaignId && demoLeads.length === 0 && (
            <span className="text-xs" style={{ color: 'var(--bad)' }}>
              No dialable leads in this campaign.
            </span>
          )}
          {dialMode === 'phone' && (
            <input
              className="input w-auto"
              placeholder="+91XXXXXXXXXX"
              value={demoPhoneNumber}
              onChange={(e) => setDemoPhoneNumber(e.target.value)}
            />
          )}
          <input
            className="input w-auto"
            placeholder="Caller's name"
            value={demoLeadName}
            onChange={(e) => setDemoLeadName(e.target.value)}
          />
          <button
            onClick={startLiveDemo}
            disabled={!demoCampaignId || !demoLeadId || demoStarting || (dialMode === 'phone' && !demoPhoneNumber.trim())}
            className="btn btn-primary"
          >
            {demoStarting ? 'Starting…' : dialMode === 'phone' ? 'Call this number' : 'Start call'}
          </button>
        </div>
        {dialMode === 'phone' && (
          <p className="mt-2 text-xs" style={{ color: 'var(--text-dim)' }}>
            On a Twilio Trial account this only works for a number you&apos;ve verified in the Twilio console
            (Console → Phone Numbers → Verified Caller IDs).
          </p>
        )}
        {demoLink && (
          <div className="mt-3 rounded-lg p-3 text-sm" style={{ background: 'var(--surface-2)' }}>
            <p className="mb-1 font-semibold">Share this link with whoever is playing the lead:</p>
            <div className="flex items-center gap-2">
              <input className="input flex-1" readOnly value={demoLink.url} onFocus={(e) => e.currentTarget.select()} />
              <button className="btn btn-ghost" onClick={() => navigator.clipboard.writeText(demoLink.url)}>
                Copy
              </button>
            </div>
          </div>
        )}
        {demoDialed && (
          <p className="mt-3 text-sm" style={{ color: 'var(--good)' }}>
            📞 Dialing {demoDialed} — it should ring shortly.
          </p>
        )}
        {demoError && (
          <p className="mt-3 text-sm" style={{ color: 'var(--bad)' }}>
            {demoError}
          </p>
        )}
      </div>
    </div>
  );
}
