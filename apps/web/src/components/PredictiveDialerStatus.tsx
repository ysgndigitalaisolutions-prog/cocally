'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

export interface PredictiveDialStatus {
  campaignId: string;
  campaignName: string;
  dialing: boolean;
  reason: string | null;
  detail: string;
  ratio: number;
  method: 'FIXED_RATIO' | 'ADAPT_HARD_LIMIT';
  metrics: {
    eligibleAgents: number;
    availableAgentsNow: number;
    activeLines: number;
    dialsToday: number;
    dailyDialBudget: number;
    abandonRatePercent: number | null;
    abandonSampleSize: number;
    maxAbandonRatePercent: number;
    dialableLeads: number;
  };
}

/** Live ratio/abandon-rate readout for the human-agent predictive dialer — the operational twin of DialerStatusCard for the AI dialer. */
export function PredictiveDialerStatusCard({ campaignId }: { campaignId: string }) {
  const [status, setStatus] = useState<PredictiveDialStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .get<PredictiveDialStatus>(`/predictive-dialer/status/${campaignId}`)
        .then((r) => !cancelled && setStatus(r.data))
        .catch(() => undefined);
    load();
    const timer = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [campaignId]);

  if (!status) return null;

  const color = status.dialing ? 'var(--good)' : 'var(--text-dim)';
  const abandonOver =
    status.metrics.abandonRatePercent !== null && status.metrics.abandonRatePercent > status.metrics.maxAbandonRatePercent;

  return (
    <div className="space-y-2 rounded-lg p-3" style={{ background: 'var(--surface-2)' }}>
      <div className="flex items-center justify-between">
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
          {status.dialing ? 'Dialing' : 'Idle'} · ratio {status.ratio.toFixed(2)}× ({status.method === 'ADAPT_HARD_LIMIT' ? 'auto' : 'fixed'})
        </span>
        <span
          className="text-xs font-bold"
          style={{ color: abandonOver ? 'var(--bad)' : 'var(--text-dim)' }}
          title="FCC/TCPA-style abandon-rate cap"
        >
          {status.metrics.abandonRatePercent === null
            ? 'abandon rate: gathering data'
            : `abandon rate ${status.metrics.abandonRatePercent.toFixed(1)}% / ${status.metrics.maxAbandonRatePercent}% cap`}
        </span>
      </div>
      <p className="text-xs" style={{ color: 'var(--text-dim)' }}>{status.detail}</p>
      <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
        {status.metrics.activeLines} live line(s) · {status.metrics.eligibleAgents} agent(s) logged in (
        {status.metrics.availableAgentsNow} free now) · {status.metrics.dialsToday}/{status.metrics.dailyDialBudget} dials
        today · {status.metrics.dialableLeads} lead(s) ready
        {status.metrics.abandonSampleSize > 0 && ` · n=${status.metrics.abandonSampleSize} (last hour)`}
      </p>
    </div>
  );
}
