'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface LeadList {
  _id: string;
  name: string;
  campaignId?: string;
  status: string;
}

interface Campaign {
  _id: string;
  name: string;
}

interface Lead {
  _id: string;
  phone: string;
  firstName?: string;
  lastName?: string;
  suburb?: string;
  state?: string;
  state_: string;
  score: number;
  attempts: number;
}

interface ImportReport {
  total: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  rejects: Array<{ row: number; reason: string }>;
}

export default function LeadsPage() {
  const [lists, setLists] = useState<LeadList[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedCampaign, setSelectedCampaign] = useState('');
  const [leads, setLeads] = useState<Lead[]>([]);
  const [listId, setListId] = useState('');
  const [csv, setCsv] = useState('');
  const [phoneColumn, setPhoneColumn] = useState('phone');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    Promise.all([api.get('/leads/lists'), api.get('/campaigns')])
      .then(([listRes, campaignRes]) => {
        setLists(listRes.data);
        setCampaigns(campaignRes.data);
        if (campaignRes.data[0]) setSelectedCampaign(campaignRes.data[0]._id);
        if (listRes.data[0]) setListId(listRes.data[0]._id);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!selectedCampaign) return;
    api
      .get(`/leads/campaign/${selectedCampaign}`)
      .then((r) => setLeads(r.data))
      .catch(() => undefined);
  }, [selectedCampaign, report]);

  async function runImport(e: React.FormEvent) {
    e.preventDefault();
    setImporting(true);
    setReport(null);
    try {
      const { data } = await api.post('/leads/import', {
        listId,
        filename: 'ui-upload.csv',
        csvContent: csv,
        mapping: { phone: phoneColumn, firstName: 'firstName', lastName: 'lastName', suburb: 'suburb', state: 'state', postcode: 'postcode' },
      });
      setReport(data);
      setCsv('');
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Leads</h1>

      <section className="card p-6">
        <h2 className="mb-3 font-semibold">Import CSV</h2>
        <form onSubmit={runImport} className="space-y-3">
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="mb-1 block text-sm">List</label>
              <select className="input" value={listId} onChange={(e) => setListId(e.target.value)} required>
                {lists.map((list) => (
                  <option key={list._id} value={list._id}>
                    {list.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm">Phone column</label>
              <input className="input" value={phoneColumn} onChange={(e) => setPhoneColumn(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm">CSV content (headers on first line)</label>
            <textarea
              className="input h-32 font-mono text-xs"
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              placeholder={'phone,firstName,lastName,suburb,state\n0412 345 678,Kim,Lee,Fitzroy,VIC'}
              required
            />
          </div>
          <button className="btn btn-primary" disabled={importing}>
            {importing ? 'Importing…' : 'Import'}
          </button>
        </form>
        {report && (
          <div className="mt-4 rounded-lg p-3 text-sm" style={{ background: 'var(--surface-2)' }}>
            <p>
              Total {report.total} · accepted <span style={{ color: 'var(--good)' }}>{report.accepted}</span> ·
              duplicates {report.duplicates} · rejected{' '}
              <span style={{ color: report.rejected > 0 ? 'var(--bad)' : undefined }}>{report.rejected}</span>
            </p>
            {report.rejects.slice(0, 5).map((reject) => (
              <p key={reject.row} className="text-xs" style={{ color: 'var(--text-dim)' }}>
                row {reject.row}: {reject.reason}
              </p>
            ))}
          </div>
        )}
      </section>

      <section className="card p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">Leads by campaign</h2>
          <select className="input max-w-xs" value={selectedCampaign} onChange={(e) => setSelectedCampaign(e.target.value)}>
            {campaigns.map((c) => (
              <option key={c._id} value={c._id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: 'var(--text-dim)' }}>
                <th className="pb-2 pr-4">Name</th>
                <th className="pb-2 pr-4">Phone</th>
                <th className="pb-2 pr-4">Location</th>
                <th className="pb-2 pr-4">State</th>
                <th className="pb-2 pr-4">Score</th>
                <th className="pb-2">Attempts</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead._id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="py-2 pr-4">{[lead.firstName, lead.lastName].filter(Boolean).join(' ') || '—'}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{lead.phone}</td>
                  <td className="py-2 pr-4">{[lead.suburb, lead.state].filter(Boolean).join(', ')}</td>
                  <td className="py-2 pr-4">
                    <span
                      className="rounded-full px-2 py-0.5 text-xs font-semibold"
                      style={{
                        background: 'var(--surface-2)',
                        color:
                          lead.state_ === 'BOOKED'
                            ? 'var(--good)'
                            : lead.state_ === 'DNC'
                              ? 'var(--bad)'
                              : 'var(--text-dim)',
                      }}
                    >
                      {lead.state_}
                    </span>
                  </td>
                  <td className="py-2 pr-4">{lead.score}</td>
                  <td className="py-2">{lead.attempts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
