'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface Campaign {
  _id: string;
  name: string;
  status: string;
  countryPackCode: string;
  dailyDialBudget: number;
  maxConcurrentCalls: number;
  dialsPerAvailableAgent: number;
  voicemailPolicy: string;
  transcriptionMode: string;
  whisperEnabled: boolean;
  routingStrategy: string;
  transferAcceptWindowSeconds: number;
  frequencyCapDays: number;
  aiSelfIdentification: boolean;
  activeFlowVersionId?: string;
}

interface Lead {
  _id: string;
  phone: string;
  firstName?: string;
  state_: string;
}

export default function CampaignDetailPage() {
  const params = useParams<{ id: string }>();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [message, setMessage] = useState('');

  async function load() {
    const [campaignRes, leadsRes] = await Promise.all([
      api.get(`/campaigns/${params.id}`),
      api.get(`/leads/campaign/${params.id}`),
    ]);
    setCampaign(campaignRes.data);
    setLeads(leadsRes.data);
  }

  useEffect(() => {
    load().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  async function save(patch: Record<string, unknown>) {
    await api.patch(`/campaigns/${params.id}`, patch);
    setMessage('Saved.');
    await load();
    setTimeout(() => setMessage(''), 2000);
  }

  async function devDial(leadId: string) {
    await api.post('/calls/dev-dial', { campaignId: params.id, leadId });
    setMessage('Simulated call started — watch the Workspace floor feed.');
    setTimeout(() => setMessage(''), 4000);
  }

  if (!campaign) return <p style={{ color: 'var(--text-dim)' }}>Loading…</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{campaign.name}</h1>
        <span
          className="rounded-full px-3 py-1 text-sm font-bold"
          style={{
            background: campaign.status === 'ACTIVE' ? 'var(--good)' : 'var(--surface-2)',
            color: campaign.status === 'ACTIVE' ? '#0b1220' : 'var(--text-dim)',
          }}
        >
          {campaign.status}
        </span>
      </div>
      {message && <p style={{ color: 'var(--good)' }}>{message}</p>}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card space-y-4 p-6">
          <h2 className="font-semibold">Pacing &amp; policy (ADM-03)</h2>
          <Field
            label="Daily dial budget"
            value={campaign.dailyDialBudget}
            onSave={(v) => save({ dailyDialBudget: Number(v) })}
          />
          <Field
            label="Max concurrent calls"
            value={campaign.maxConcurrentCalls}
            onSave={(v) => save({ maxConcurrentCalls: Number(v) })}
          />
          <Field
            label="Dials per available agent"
            value={campaign.dialsPerAvailableAgent}
            onSave={(v) => save({ dialsPerAvailableAgent: Number(v) })}
          />
          <Field
            label="Frequency cap (days)"
            value={campaign.frequencyCapDays}
            onSave={(v) => save({ frequencyCapDays: Number(v) })}
          />
          <SelectField
            label="Voicemail policy (TEL-05)"
            value={campaign.voicemailPolicy}
            options={['SILENT_HANGUP', 'PRERECORDED_DROP', 'AI_DROP']}
            onSave={(v) => save({ voicemailPolicy: v })}
          />
          <SelectField
            label="Transcription display (PAL-10)"
            value={campaign.transcriptionMode}
            options={['LIVE', 'SUMMARY', 'BOTH']}
            onSave={(v) => save({ transcriptionMode: v })}
          />
          <SelectField
            label="Routing strategy (XFER-01)"
            value={campaign.routingStrategy}
            options={['LONGEST_IDLE', 'ROUND_ROBIN', 'LEAST_TALK_TIME', 'SKILL_PRIORITY', 'STICKY']}
            onSave={(v) => save({ routingStrategy: v })}
          />
        </section>

        <section className="card p-6">
          <h2 className="mb-3 font-semibold">Leads · simulated dial</h2>
          <p className="mb-3 text-xs" style={{ color: 'var(--text-dim)' }}>
            Fire a simulated AI call for any lead (dev driver). Set yourself AVAILABLE in the Workspace first to
            receive the warm transfer.
          </p>
          <ul className="space-y-2 text-sm">
            {leads.map((lead) => (
              <li key={lead._id} className="flex items-center justify-between">
                <span>
                  {lead.firstName ?? 'Lead'} · <span className="font-mono text-xs">{lead.phone}</span> ·{' '}
                  <span style={{ color: 'var(--text-dim)' }}>{lead.state_}</span>
                </span>
                <button className="btn btn-ghost text-xs" onClick={() => devDial(lead._id)}>
                  Dial (sim)
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function Field({ label, value, onSave }: { label: string; value: number; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <div className="flex items-end gap-2">
      <div className="flex-1">
        <label className="mb-1 block text-sm">{label}</label>
        <input className="input" type="number" value={draft} onChange={(e) => setDraft(e.target.value)} />
      </div>
      {draft !== String(value) && (
        <button className="btn btn-primary text-xs" onClick={() => onSave(draft)}>
          Save
        </button>
      )}
    </div>
  );
}

function SelectField({
  label,
  value,
  options,
  onSave,
}: {
  label: string;
  value: string;
  options: string[];
  onSave: (v: string) => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-sm">{label}</label>
      <select className="input" value={value} onChange={(e) => onSave(e.target.value)}>
        {options.map((option) => (
          <option key={option} value={option}>
            {option.replace(/_/g, ' ')}
          </option>
        ))}
      </select>
    </div>
  );
}
