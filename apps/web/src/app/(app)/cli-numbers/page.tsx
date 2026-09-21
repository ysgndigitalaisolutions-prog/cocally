'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface CliNumberRow {
  _id: string;
  number: string;
  geoRegion?: string;
  countryPackCode: string;
  status: 'ACTIVE' | 'RESTING' | 'QUARANTINED';
  dialsToday: number;
  answersToday: number;
  answerRate7d: number;
  restingUntil?: string;
  quarantinedAt?: string;
  quarantineReason?: string;
}

const STATUS_COLOR: Record<string, string> = {
  ACTIVE: 'var(--good)',
  RESTING: 'var(--accent)',
  QUARANTINED: 'var(--bad)',
};

export default function CliNumbersPage() {
  const [numbers, setNumbers] = useState<CliNumberRow[]>([]);
  const [message, setMessage] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reasonDrafts, setReasonDrafts] = useState<Record<string, string>>({});
  const [newNumber, setNewNumber] = useState({ number: '', geoRegion: '', countryPackCode: 'AU' });

  async function load() {
    const { data } = await api.get<CliNumberRow[]>('/cli');
    setNumbers(data);
  }

  useEffect(() => {
    load().catch(() => undefined);
    const timer = setInterval(() => load().catch(() => undefined), 30_000);
    return () => clearInterval(timer);
  }, []);

  function flash(text: string) {
    setMessage(text);
    setTimeout(() => setMessage(''), 3500);
  }

  async function addNumber() {
    if (!newNumber.number.trim()) return;
    try {
      await api.post('/cli', newNumber);
      setNewNumber({ number: '', geoRegion: '', countryPackCode: newNumber.countryPackCode });
      await load();
      flash('Number added.');
    } catch (err) {
      const detail = (err as { response?: { data?: { message?: string } } }).response?.data;
      flash(typeof detail?.message === 'string' ? detail.message : 'Could not add the number.');
    }
  }

  async function reinstate(row: CliNumberRow) {
    const reason = reasonDrafts[row._id]?.trim();
    if (!reason) {
      flash('A reason is required to reinstate a quarantined number.');
      return;
    }
    setBusyId(row._id);
    try {
      await api.post(`/cli/${row._id}/reinstate`, { reason });
      setReasonDrafts((prev) => ({ ...prev, [row._id]: '' }));
      await load();
      flash(`${row.number} reinstated.`);
    } catch (err) {
      const detail = (err as { response?: { data?: { message?: string } } }).response?.data;
      flash(typeof detail?.message === 'string' ? detail.message : 'Could not reinstate.');
    } finally {
      setBusyId(null);
    }
  }

  async function quarantine(row: CliNumberRow) {
    const reason = reasonDrafts[row._id]?.trim();
    if (!reason) {
      flash('A reason is required to quarantine a number.');
      return;
    }
    setBusyId(row._id);
    try {
      await api.post(`/cli/${row._id}/quarantine`, { reason });
      setReasonDrafts((prev) => ({ ...prev, [row._id]: '' }));
      await load();
      flash(`${row.number} quarantined.`);
    } catch (err) {
      const detail = (err as { response?: { data?: { message?: string } } }).response?.data;
      flash(typeof detail?.message === 'string' ? detail.message : 'Could not quarantine.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">CLI numbers</h1>
        <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
          Caller-ID pool health. Once a number is carrier-labelled ("Spam Likely"), remediation takes days to
          weeks — it is auto-quarantined below an 8% 7-day answer rate (min 20 dials) and stays out of
          rotation until manually reinstated with a reason, for the audit trail.
        </p>
      </div>

      {message && <p className="text-sm" style={{ color: 'var(--accent)' }}>{message}</p>}

      <div className="card flex flex-wrap items-end gap-2 p-4">
        <div>
          <label className="mb-1 block text-xs" style={{ color: 'var(--text-dim)' }}>Number (E.164)</label>
          <input
            className="input"
            placeholder="+61312345678"
            value={newNumber.number}
            onChange={(e) => setNewNumber({ ...newNumber, number: e.target.value })}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs" style={{ color: 'var(--text-dim)' }}>Geo region</label>
          <input
            className="input"
            placeholder="VIC"
            value={newNumber.geoRegion}
            onChange={(e) => setNewNumber({ ...newNumber, geoRegion: e.target.value })}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs" style={{ color: 'var(--text-dim)' }}>Country pack</label>
          <input
            className="input w-24"
            value={newNumber.countryPackCode}
            onChange={(e) => setNewNumber({ ...newNumber, countryPackCode: e.target.value })}
          />
        </div>
        <button className="btn btn-primary text-sm" onClick={addNumber}>Add number</button>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left" style={{ color: 'var(--text-dim)' }}>
              <th className="p-3">Number</th>
              <th className="p-3">Geo</th>
              <th className="p-3">Status</th>
              <th className="p-3">Today</th>
              <th className="p-3">7d answer rate</th>
              <th className="p-3">Detail</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {numbers.length === 0 && (
              <tr>
                <td colSpan={7} className="p-4 text-center" style={{ color: 'var(--text-dim)' }}>
                  No CLI numbers yet — add one above.
                </td>
              </tr>
            )}
            {numbers.map((row) => (
              <tr key={row._id} className="border-t align-top" style={{ borderColor: 'var(--border)' }}>
                <td className="p-3 font-mono text-xs">{row.number}</td>
                <td className="p-3">{row.geoRegion ?? '—'}</td>
                <td className="p-3">
                  <span className="font-semibold" style={{ color: STATUS_COLOR[row.status] }}>{row.status}</span>
                </td>
                <td className="p-3 font-mono text-xs">{row.answersToday}/{row.dialsToday}</td>
                <td className="p-3 font-mono text-xs">{(row.answerRate7d * 100).toFixed(1)}%</td>
                <td className="p-3 max-w-xs text-xs" style={{ color: 'var(--text-dim)' }}>
                  {row.status === 'QUARANTINED' ? row.quarantineReason : row.status === 'RESTING' && row.restingUntil ? `rests until ${new Date(row.restingUntil).toLocaleString()}` : '—'}
                </td>
                <td className="p-3">
                  <div className="flex items-center gap-2">
                    <input
                      className="input w-40 text-xs"
                      placeholder="reason…"
                      value={reasonDrafts[row._id] ?? ''}
                      onChange={(e) => setReasonDrafts((prev) => ({ ...prev, [row._id]: e.target.value }))}
                    />
                    {row.status === 'QUARANTINED' ? (
                      <button className="btn btn-primary text-xs" disabled={busyId === row._id} onClick={() => reinstate(row)}>
                        Reinstate
                      </button>
                    ) : (
                      <button className="btn btn-ghost text-xs" disabled={busyId === row._id} onClick={() => quarantine(row)}>
                        Quarantine
                      </button>
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
