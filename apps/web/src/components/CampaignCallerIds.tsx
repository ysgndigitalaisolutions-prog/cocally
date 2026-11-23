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

/** "+61390728793" → "+61 3 9072 8793"; "+61485049494" → "+61 485 049 494". Other numbers as stored. */
export function formatCli(n: string): string {
  const au = /^\+61(\d{9})$/.exec(n);
  if (!au) return n;
  const d = au[1]!;
  return d.startsWith('4') ? `+61 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : `+61 ${d[0]} ${d.slice(1, 5)} ${d.slice(5)}`;
}

const STATUS_COLOR: Record<CliRow['status'], string> = {
  ACTIVE: 'var(--good)',
  RESTING: 'var(--accent)',
  QUARANTINED: 'var(--bad)',
};

/**
 * Which caller IDs this campaign dials from, with each number's health. None
 * ticked means the carrier's default number, so a newly added number only goes
 * out where someone ticks it.
 */
export default function CampaignCallerIds({
  campaignId,
  countryPackCode,
  maxConcurrentCalls,
  dialGapSeconds,
}: {
  campaignId: string;
  countryPackCode: string;
  maxConcurrentCalls?: number;
  dialGapSeconds?: { min: number; max: number };
}) {
  const [rows, setRows] = useState<CliRow[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [carrierDefault, setCarrierDefault] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [numbers, campaign, defaults] = await Promise.all([
      api.get<CliRow[]>('/cli'),
      api.get<{ cliPool?: string[] }>(`/campaigns/${campaignId}`),
      api.get<{ au: string | null; other: string | null }>('/cli/default').catch(() => null),
    ]);
    const d = defaults?.data;
    setCarrierDefault((countryPackCode === 'AU' ? d?.au : d?.other) ?? null);
    const pool = new Set((campaign.data.cliPool ?? []).map(String));
    // The numbers in use first, then the rest.
    setRows(
      numbers.data
        .filter((n) => n.countryPackCode === countryPackCode)
        .sort((a, b) => Number(pool.has(b._id)) - Number(pool.has(a._id)) || a.number.localeCompare(b.number)),
    );
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
  const inUse = rows.filter((r) => saved.has(r._id)).map((r) => formatCli(r.number));
  const gap = dialGapSeconds && dialGapSeconds.max > 0
    ? dialGapSeconds.min === dialGapSeconds.max
      ? `${dialGapSeconds.max} seconds apart`
      : `${dialGapSeconds.min}–${dialGapSeconds.max} seconds apart`
    : 'with no wait between dials';
  const list = inUse.length > 1 ? `${inUse.slice(0, -1).join(', ')} and ${inUse[inUse.length - 1]}` : inUse[0];

  return (
    <section className="card p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Caller IDs</h2>
        <Link href="/cli-numbers" className="text-sm text-dim hover:underline">Manage numbers</Link>
      </div>
      <p className="mt-1 text-sm">
        {inUse.length > 0 ? (
          <>
            Calls show <b className="font-mono">{list}</b>
            {maxConcurrentCalls
              ? `. Up to ${maxConcurrentCalls} call${maxConcurrentCalls === 1 ? '' : 's'} at a time${inUse.length > 1 ? ', each on a different number' : ''}, dialled ${gap}.`
              : '.'}
          </>
        ) : (
          <span className="text-dim">
            None ticked: calls show the carrier&apos;s default number{carrierDefault ? ` (${formatCli(carrierDefault)})` : ''}.
          </span>
        )}
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
                  <td className="py-2 font-mono text-xs">{formatCli(row.number)}</td>
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
