'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import CallConversation, { type CallEvent, type TranscriptLine, type TurnMetric } from '@/components/ops/CallConversation';
import type { Targets } from '@/components/ops/latency';
import { fmtDateTime, Pill, secs } from '@/components/ops/ui';
import { inr, num } from '@/lib/billing';
import { opsApi, opsError } from '@/lib/ops-api';

interface CallDetail {
  id: string;
  tenantId: string;
  tenantName: string;
  campaignName: string;
  lead: { name: string | null; phone: string } | null;
  agentName: string | null;
  kind: string;
  cli: string | null;
  state: string;
  outcome: string | null;
  endReason: string | null;
  sipStatus: number | null;
  amdClass: string | null;
  amdLatencyMs: number | null;
  disposition: string | null;
  dispositionNotes: string | null;
  score: number | null;
  summary: string;
  timeline: { startedAt: string; answeredAt: string | null; aiDispatchedAt: string | null; bridgedAt: string | null; endedAt: string | null };
  usage: { ringSeconds: number; aiSeconds: number; humanSeconds: number; recordedSeconds: number; ttsChars: number } | null;
  costUsd: Record<string, number> | null;
  costInr: number;
  inrPerUsd: number;
  billedLines: Array<{ label: string; quantity: number; unit: string; rateInr: number; amountInr: number }>;
  billedInr: number;
  complianceEvents: Array<{ kind?: string; at?: string; detail?: string }>;
  turnMetrics: TurnMetric[];
  events: CallEvent[];
  providersUsed: Record<string, string>;
  latencyTargets: Targets;
  recorded: boolean;
  recordingUri: string | null;
  transcriptRedacted: boolean;
  transcript: TranscriptLine[];
}

const pretty = (s: string | null) => (s ? s.toLowerCase().replace(/_/g, ' ') : '—');

const COST_LABELS: Array<[string, string]> = [
  ['tts', 'Voice (TTS)'],
  ['aiAgent', 'LiveKit AI agent'],
  ['stt', 'Speech-to-text'],
  ['llm', 'Language model'],
  ['phoneLine', 'LiveKit phone line'],
  ['recording', 'Recording'],
  ['agentBrowser', 'Agent browser'],
  ['carrier', 'Carrier'],
];

export default function OpsCallPage() {
  const { id } = useParams<{ id: string }>();
  const [call, setCall] = useState<CallDetail | null>(null);
  const [audio, setAudio] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(
    async (unredacted = false) => {
      try {
        const r = await opsApi.get<CallDetail>(`/calls/${id}${unredacted ? '/unredacted' : ''}`);
        setCall(r.data);
      } catch (err) {
        setError(opsError(err, 'Call not found.'));
      }
    },
    [id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function play() {
    try {
      const r = await opsApi.get<{ url: string }>(`/calls/${id}/recording`);
      setAudio(r.data.url);
    } catch (err) {
      setError(opsError(err, 'Recording not available.'));
    }
  }

  if (!call) return <p style={{ color: error ? 'var(--bad)' : 'var(--text-dim)' }}>{error || 'Loading…'}</p>;
  const t = call.timeline;

  return (
    <div className="space-y-5">
      <div>
        <Link href="/ops/calls" className="text-sm hover:underline" style={{ color: 'var(--text-dim)' }}>← Calls</Link>
        <h1 className="text-2xl font-bold">
          {call.lead?.name ?? 'Customer'} <span className="font-mono text-base" style={{ color: 'var(--text-dim)' }}>{call.lead?.phone}</span>
        </h1>
        <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
          <Link href={`/ops/tenants/${call.tenantId}`} className="hover:underline">{call.tenantName}</Link> · {call.campaignName} · {call.kind}
          {call.agentName ? ` · agent ${call.agentName}` : ''} · from {call.cli ?? 'trunk default'}
        </p>
      </div>
      {error && <p className="text-sm" style={{ color: 'var(--bad)' }}>{error}</p>}

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="card space-y-2 p-5 text-sm">
          <h2 className="font-semibold">What happened</h2>
          <Row label="Outcome"><Pill text={pretty(call.outcome ?? call.state)} tone={call.outcome === 'ANSWERED_HUMAN' ? 'good' : 'dim'} /></Row>
          <Row label="Answered by">{pretty(call.amdClass)}{call.amdLatencyMs != null ? ` (${num(call.amdLatencyMs)} ms)` : ''}</Row>
          <Row label="End reason">{pretty(call.endReason)}{call.sipStatus ? ` · SIP ${call.sipStatus}` : ''}</Row>
          <Row label="Score">{call.score ?? '—'}</Row>
          <Row label="Disposition">{pretty(call.disposition)}</Row>
          {call.dispositionNotes && <p className="text-xs" style={{ color: 'var(--text-dim)' }}>{call.dispositionNotes}</p>}
          {call.summary && <p className="border-t pt-2 text-xs" style={{ borderColor: 'var(--border)', color: 'var(--text-dim)' }}>{call.summary}</p>}
        </section>

        <section className="card space-y-2 p-5 text-sm">
          <h2 className="font-semibold">Timeline</h2>
          <Row label="Dialled">{fmtDateTime(t.startedAt)}</Row>
          <Row label="Answered">{fmtDateTime(t.answeredAt)}</Row>
          <Row label="AI joined">{fmtDateTime(t.aiDispatchedAt)}</Row>
          <Row label="Transferred">{fmtDateTime(t.bridgedAt)}</Row>
          <Row label="Ended">{fmtDateTime(t.endedAt)}</Row>
          {call.usage && (
            <p className="border-t pt-2 text-xs" style={{ borderColor: 'var(--border)', color: 'var(--text-dim)' }}>
              Ringing {secs(call.usage.ringSeconds)} · AI {secs(call.usage.aiSeconds)} · Agent {secs(call.usage.humanSeconds)} · AI spoke {num(call.usage.ttsChars)} chars
            </p>
          )}
        </section>

        <section className="card space-y-2 p-5 text-sm">
          <h2 className="font-semibold">Money</h2>
          {call.costUsd &&
            COST_LABELS.filter(([k]) => (call.costUsd?.[k] ?? 0) > 0).map(([k, label]) => (
              <Row key={k} label={label}>{inr((call.costUsd?.[k] ?? 0) * call.inrPerUsd)}</Row>
            ))}
          <Row label={<span className="font-semibold">Our cost</span>}><span className="font-semibold">{inr(call.costInr)}</span></Row>
          <div className="border-t pt-2" style={{ borderColor: 'var(--border)' }}>
            {call.billedLines.map((l) => (
              <Row key={l.label} label={l.unit === 'min' ? `AI ${num(l.quantity, 2)} min × ${inr(l.rateInr)}` : `${num(l.quantity)} dial × ${inr(l.rateInr)}`}>{inr(l.amountInr)}</Row>
            ))}
            <Row label={<span className="font-semibold">Billed (base rate)</span>}><span className="font-semibold">{inr(call.billedInr)}</span></Row>
          </div>
        </section>
      </div>

      <section className="card space-y-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Recording</h2>
          {call.recorded ? (
            !audio && <button className="btn btn-primary text-sm" onClick={() => void play()}>Load recording</button>
          ) : (
            <span className="text-sm" style={{ color: 'var(--text-dim)' }}>No recording for this call.</span>
          )}
        </div>
        {audio && <audio controls src={audio} className="w-full" />}
        {call.recordingUri && <p className="break-all font-mono text-xs" style={{ color: 'var(--text-dim)' }}>{call.recordingUri}</p>}
      </section>

      <CallConversation
        startedAt={t.startedAt}
        transcript={call.transcript}
        redacted={call.transcriptRedacted}
        onUnredact={() => void load(true)}
        turns={call.turnMetrics ?? []}
        events={call.events ?? []}
        providersUsed={call.providersUsed ?? {}}
        targets={call.latencyTargets}
      />

      {call.complianceEvents.length > 0 && (
        <section className="card space-y-2 p-5 text-sm">
          <h2 className="font-semibold">Compliance</h2>
          <ul className="space-y-1">
            {call.complianceEvents.map((e, i) => (
              <li key={i} className="text-xs">
                <span className="font-mono">{e.kind}</span> <span style={{ color: 'var(--text-dim)' }}>{fmtDateTime(e.at)} {e.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Row({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <p className="flex justify-between gap-3">
      <span style={{ color: 'var(--text-dim)' }}>{label}</span>
      <span className="text-right tabular-nums">{children}</span>
    </p>
  );
}
