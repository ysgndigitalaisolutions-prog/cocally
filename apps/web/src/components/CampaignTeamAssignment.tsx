'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface TeamRow {
  id: string;
  name: string;
  email: string;
  presence: string;
  assigned: boolean;
  unrestricted: boolean;
}

/**
 * Who receives this campaign's warm transfers. Eligibility is skill-based:
 * assigned agents, plus any agent with no campaign restrictions at all.
 */
export default function CampaignTeamAssignment({
  campaignId,
  onChanged,
}: {
  campaignId: string;
  onChanged?: () => void;
}) {
  const [rows, setRows] = useState<TeamRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const { data } = await api.get<TeamRow[]>(`/campaigns/${campaignId}/team`);
    setRows(data);
    setSelected(new Set(data.filter((r) => r.assigned).map((r) => r.id)));
  }, [campaignId]);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  function toggle(id: string) {
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
      await api.post(`/campaigns/${campaignId}/team`, { agentIds: [...selected] });
      setMessage('Team saved.');
      setTimeout(() => setMessage(''), 2500);
      await load();
      onChanged?.();
    } finally {
      setSaving(false);
    }
  }

  const dirty =
    rows.length > 0 &&
    (rows.some((r) => r.assigned !== selected.has(r.id)));
  const assignedCount = selected.size;
  // With nobody assigned, routing falls back to every unrestricted agent.
  const fallbackAgents = rows.filter((r) => r.unrestricted && !selected.has(r.id));

  return (
    <section className="card space-y-3 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">Team — who receives these calls</h2>
          <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
            Warm transfers from this campaign are only offered to these agents (XFER-01 skill match).
          </p>
        </div>
        <div className="flex items-center gap-2">
          {message && <span className="text-sm" style={{ color: 'var(--good)' }}>{message}</span>}
          <button className="btn btn-primary text-sm" onClick={save} disabled={!dirty || saving}>
            {saving ? 'Saving…' : dirty ? 'Save team *' : 'Team saved'}
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--text-dim)' }}>No active agents in this account yet.</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((row) => (
            <label
              key={row.id}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm"
              style={{
                border: `1px solid ${selected.has(row.id) ? 'var(--accent)' : 'var(--border)'}`,
                background: selected.has(row.id) ? 'var(--surface-2)' : undefined,
              }}
            >
              <input type="checkbox" checked={selected.has(row.id)} onChange={() => toggle(row.id)} />
              <span className="flex-1">
                {row.name}
                <span className="ml-1 text-xs" style={{ color: 'var(--text-dim)' }}>
                  {row.presence.toLowerCase().replace('_', '-')}
                </span>
              </span>
              {row.unrestricted && !selected.has(row.id) && (
                <span className="text-xs" style={{ color: 'var(--accent)' }} title="No campaign restrictions — eligible for every campaign">
                  any
                </span>
              )}
            </label>
          ))}
        </div>
      )}

      <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
        {assignedCount === 0 ? (
          <>
            <b style={{ color: 'var(--accent)' }}>Nobody is assigned.</b> Transfers fall back to every agent with no
            campaign restrictions ({fallbackAgents.length} agent{fallbackAgents.length === 1 ? '' : 's'}{' '}
            marked &ldquo;any&rdquo;). Assign agents to route this campaign deliberately.
          </>
        ) : (
          <>
            {assignedCount} agent{assignedCount === 1 ? '' : 's'} assigned.
            {fallbackAgents.length > 0 && (
              <>
                {' '}
                {fallbackAgents.length} unrestricted agent{fallbackAgents.length === 1 ? '' : 's'} (&ldquo;any&rdquo;)
                can also receive these transfers — assign them to a campaign to stop that.
              </>
            )}
          </>
        )}
      </p>
    </section>
  );
}
