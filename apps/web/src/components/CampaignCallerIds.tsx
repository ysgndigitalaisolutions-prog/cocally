'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface CliRow {
  _id: string;
  number: string;
  countryPackCode: string;
  status: 'ACTIVE' | 'RESTING' | 'QUARANTINED';
  dialsToday: number;
  answersToday: number;
  answerRate7d: number;
}

const STATUS_COLOR: Record<CliRow['status'], string> = {
  ACTIVE: 'var(--good)',
  RESTING: 'var(--accent)',
  QUARANTINED: 'var(--bad)',
};

/**
 * Which caller IDs this campaign dials from, with each number's health. None
 * ticked means every active number from the campaign's country rotates.
 */
export default function CampaignCallerIds({ campaignId, countryPackCode }: { campaignId: string; countryPackCode: string }) {
  const [rows, setRows] = useState<CliRow[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const [numbers, campaign] = await Promise.all([
      api.get<CliRow[]>('/cli'),
      api.get<{ cliPool?: string[] }>(`/campaigns/${campaignId}`),
    ]);
    const pool = new Set((campaign.data.cliPool ?? []).map(String));
    setRows(numbers.data.filter((n) => n.countryPackCode === countryPackCode));
    setSelected(pool);
    setSaved(pool);
  }, [campaignId, countryPackCode]);

  useEffect(() => {
    load().catch(() => setRows(null));
  }, [load]);

  function toggle(id: string) {
    setMessage('');
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/campaigns/${campaignId}`, { cliPool: [...selected] });
      setSaved(new Set(selected));
      setMessage('Saved.');
    } catch {
      setMessage('Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  if (rows === null) return null;
  const changed = selected.size !== saved.size || [...selected].some((id) => !saved.has(id));

  return (
    <section className="card p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Caller IDs</h2>
        <Link href="/cli-numbers" className="text-sm text-dim hover:underline">Manage numbers</Link>
      </div>
      <p className="mt-1 text-sm text-dim">
        {selected.size > 0
          ? `This campaign rotates through the ${selected.size === 1 ? 'number' : `${selected.size} numbers`} ticked below.`
          : rows.length > 0
            ? `None ticked: all active ${countryPackCode} numbers rotate.`
            : `No ${countryPackCode} numbers added yet. Calls use the carrier's default caller ID.`}
      </p>

      {rows.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <thead>
              <tr className="text-left text-xs text-dim">
                <th className="pb-2 font-medium">Use</th>
                <th className="pb-2 font-medium">Number</th>
                <th className="pb-2 font-medium">Health</th>
                <th className="pb-2 text-right font-medium">Answered today</th>
                <th className="pb-2 text-right font-medium">7-day answer rate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row._id} className="border-t border-border">
                  <td className="py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(row._id)}
                      onChange={() => toggle(row._id)}
                      aria-label={`Use ${row.number} on this campaign`}
                    />
                  </td>
                  <td className="py-2 font-mono text-xs">{row.number}</td>
                  <td className="py-2 font-semibold" style={{ color: STATUS_COLOR[row.status] }}>{row.status}</td>
                  <td className="py-2 text-right tabular-nums">{row.answersToday}/{row.dialsToday}</td>
                  <td className="py-2 text-right tabular-nums">{(row.answerRate7d * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 flex items-center gap-3">
            <button className="btn btn-primary text-sm" disabled={saving || !changed} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save caller IDs'}
            </button>
            {message && <span className="text-sm text-dim">{message}</span>}
          </div>
        </div>
      )}
    </section>
  );
}
