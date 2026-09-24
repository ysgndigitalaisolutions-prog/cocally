'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { DialerStatusBody, type DialStatus } from '@/components/DialerStatus';

interface Campaign {
  _id: string;
  name: string;
  status: string;
  countryPackCode: string;
  dailyDialBudget: number;
  maxConcurrentCalls: number;
  transcriptionMode: string;
}

interface Client {
  _id: string;
  name: string;
}

const NEW_CLIENT = '__new__';

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [name, setName] = useState('');
  const [clientId, setClientId] = useState('');
  const [newClientName, setNewClientName] = useState('');
  const [countryPackCode, setCountryPackCode] = useState('AU');
  const [packs, setPacks] = useState<{ code: string; name: string }[]>([]);
  const [creating, setCreating] = useState(false);
  const [dialStatus, setDialStatus] = useState<Record<string, DialStatus>>({});

  async function load() {
    const [campaignRes, clientRes] = await Promise.all([api.get('/campaigns'), api.get('/tenants/clients')]);
    setCampaigns(campaignRes.data);
    setClients(clientRes.data);
    api.get('/country-packs').then((r) => setPacks(r.data)).catch(() => undefined);
    if (clientRes.data[0] && !clientId) setClientId(clientRes.data[0]._id);
  }

  useEffect(() => {
    load().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live dialer state: why each campaign is or isn't placing calls right now.
  useEffect(() => {
    let cancelled = false;
    const poll = () =>
      api
        .get<DialStatus[]>('/dialer/status')
        .then((r) => {
          if (cancelled) return;
          setDialStatus(Object.fromEntries(r.data.map((s) => [s.campaignId, s])));
        })
        .catch(() => undefined);
    poll();
    const timer = setInterval(poll, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  async function createCampaign(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      let targetClient = clientId;
      if (!targetClient || targetClient === NEW_CLIENT) {
        // First campaign on a new tenant, or the admin chose to add a client here.
        const { data } = await api.post('/tenants/clients', { name: newClientName.trim() });
        targetClient = data._id;
        setClientId(data._id);
        setNewClientName('');
      }
      await api.post('/campaigns', { name, clientId: targetClient, countryPackCode });
      setName('');
      await load();
    } finally {
      setCreating(false);
    }
  }

  async function setStatus(id: string, status: string) {
    await api.post(`/campaigns/${id}/status`, { status });
    await load();
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Campaigns</h1>

      <form onSubmit={createCampaign} className="card flex flex-wrap items-end gap-3 p-4">
        <div className="flex-1">
          <label className="mb-1 block text-sm">Name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Aurora Solar — NSW" />
        </div>
        {clients.length > 0 && (
          <div>
            <label className="mb-1 block text-sm">Client</label>
            <select className="input" value={clientId} onChange={(e) => setClientId(e.target.value)} required>
              {clients.map((c) => (
                <option key={c._id} value={c._id}>
                  {c.name}
                </option>
              ))}
              <option value={NEW_CLIENT}>+ New client…</option>
            </select>
          </div>
        )}
        {(clients.length === 0 || clientId === NEW_CLIENT) && (
          <div>
            <label className="mb-1 block text-sm">New client name</label>
            <input
              className="input"
              value={newClientName}
              onChange={(e) => setNewClientName(e.target.value)}
              required
              placeholder="e.g. Aurora Solar"
            />
          </div>
        )}
        {packs.length > 1 && (
          <div>
            <label className="mb-1 block text-sm">Country</label>
            <select className="input" value={countryPackCode} onChange={(e) => setCountryPackCode(e.target.value)}>
              {packs.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <button className="btn btn-primary" disabled={creating}>
          Create
        </button>
      </form>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left" style={{ color: 'var(--text-dim)' }}>
              <th className="p-4">Name</th>
              <th className="p-4">Status</th>
              <th className="p-4">Dialer</th>
              <th className="p-4">Pack</th>
              <th className="p-4">Daily budget</th>
              <th className="p-4">Channels</th>
              <th className="p-4" />
            </tr>
          </thead>
          <tbody>
            {campaigns.map((campaign) => (
              <tr key={campaign._id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                <td className="p-4 font-medium">
                  <Link href={`/campaigns/${campaign._id}`} style={{ color: 'var(--accent)' }}>
                    {campaign.name}
                  </Link>
                </td>
                <td className="p-4">
                  <span
                    className="rounded-full px-2 py-0.5 text-xs font-bold"
                    style={{
                      background: campaign.status === 'ACTIVE' ? 'var(--good)' : 'var(--surface-2)',
                      color: campaign.status === 'ACTIVE' ? '#0b1220' : 'var(--text-dim)',
                    }}
                  >
                    {campaign.status}
                  </span>
                </td>
                <td className="p-4">
                  {dialStatus[campaign._id] ? (
                    <DialerStatusBody status={dialStatus[campaign._id]} />
                  ) : (
                    <span className="text-xs" style={{ color: 'var(--text-dim)' }}>checking…</span>
                  )}
                </td>
                <td className="p-4">{campaign.countryPackCode}</td>
                <td className="p-4">{campaign.dailyDialBudget}</td>
                <td className="p-4">{campaign.maxConcurrentCalls}</td>
                <td className="p-4">
                  {campaign.status === 'ACTIVE' ? (
                    <button className="btn btn-ghost text-xs" onClick={() => setStatus(campaign._id, 'PAUSED')}>
                      Pause
                    </button>
                  ) : (
                    <button className="btn btn-primary text-xs" onClick={() => setStatus(campaign._id, 'ACTIVE')}>
                      Activate
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
