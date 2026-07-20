'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

export interface DialStatus {
  campaignId: string;
  campaignName: string;
  status: string;
  dialing: boolean;
  reason: string | null;
  detail: string;
  resumesAt: string | null;
  resumesAtTimezone: string | null;
  metrics: {
    dialsToday: number;
    dailyDialBudget: number;
    activeCalls: number;
    maxConcurrentCalls: number;
    availableAgents: number;
    dialsPerAvailableAgent: number;
    dialableLeads: number;
  };
}

/** Reasons the operator fixes themselves vs. ones that clear on their own. */
const NEEDS_ACTION = new Set(['CAMPAIGN_NOT_ACTIVE', 'TENANT_PAUSED', 'NO_FLOW_VERSION', 'NO_AGENTS_AVAILABLE']);

function countdown(target: string): string {
  const ms = new Date(target).getTime() - Date.now();
  if (ms <= 0) return 'any moment now';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return `in ${hours}h${rem ? ` ${rem}m` : ''}`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function whenLabel(target: string, timeZone?: string): string {
  return new Date(target).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
}

/** Short zone name for the label, e.g. "Australia/Melbourne" → "Melbourne". */
function zoneShort(tz: string): string {
  return (tz.split('/').pop() ?? tz).replace(/_/g, ' ');
}

/** Fetches and renders one campaign's live dialer state. */
export function DialerStatusCard({ campaignId }: { campaignId: string }) {
  const [status, setStatus] = useState<DialStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .get<DialStatus>(`/dialer/status/${campaignId}`)
        .then((r) => !cancelled && setStatus(r.data))
        .catch(() => undefined);
    load();
    const timer = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [campaignId]);

  if (!status) return <p className="text-sm" style={{ color: 'var(--text-dim)' }}>Checking dialer…</p>;
  return <DialerStatusBody status={status} verbose />;
}

export function DialerStatusBody({ status, verbose = false }: { status: DialStatus; verbose?: boolean }) {
  // Re-render on a timer so the countdown stays honest between fetches.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  const needsAction = status.reason ? NEEDS_ACTION.has(status.reason) : false;
  const color = status.dialing ? 'var(--good)' : needsAction ? 'var(--text-dim)' : 'var(--accent)';
  const label = status.dialing ? 'Dialing' : needsAction ? 'Idle' : 'Waiting';

  return (
    <div className="space-y-1">
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold" style={{ color }}>
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: color,
            display: 'inline-block',
            boxShadow: status.dialing ? `0 0 0 3px color-mix(in srgb, ${color} 25%, transparent)` : undefined,
          }}
        />
        {label}
      </span>
      <p className="text-xs" style={{ color: 'var(--text-dim)', maxWidth: 420 }}>
        {status.detail}
      </p>
      {status.resumesAt && (
        <p className="text-xs font-medium" style={{ color: 'var(--accent)' }}>
          ▸ Resumes{' '}
          {status.resumesAtTimezone ? (
            <>
              {whenLabel(status.resumesAt, status.resumesAtTimezone)} {zoneShort(status.resumesAtTimezone)} time
              <span style={{ color: 'var(--text-dim)' }}> ({whenLabel(status.resumesAt)} yours)</span>
            </>
          ) : (
            whenLabel(status.resumesAt)
          )}{' '}
          · {countdown(status.resumesAt)}
        </p>
      )}
      {verbose && (
        <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
          {status.metrics.dialsToday}/{status.metrics.dailyDialBudget} dials today · {status.metrics.activeCalls}/
          {status.metrics.maxConcurrentCalls} live · {status.metrics.availableAgents} agent(s) available ·{' '}
          {status.metrics.dialableLeads} lead(s) ready
        </p>
      )}
    </div>
  );
}
