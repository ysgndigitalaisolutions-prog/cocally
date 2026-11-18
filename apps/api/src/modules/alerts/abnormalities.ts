import type { AlertFinding } from '../../schemas/call-alert.schema';

/** The parts of a call the checks read. */
export interface AlertCall {
  id: string;
  startedAt: Date;
  answeredAt?: Date | null;
  endedAt?: Date | null;
  bridgedAt?: Date | null;
  outcome?: string | null;
  sipStatusCode?: number | null;
  /** Who spoke, in order: 'ai' or 'customer'. */
  speakers: string[];
  workerLog: string[];
  events: Array<{ kind: string; detail?: string }>;
  leadLabel?: string;
}

export interface AlertCampaign {
  id: string;
  name: string;
  status: string;
  calls: AlertCall[];
  /** Calls started in the window before this one: a dialler that was working and then stopped. */
  callsInPreviousWindow: number;
}

/** SIP answers that mean the carrier, not the customer, refused the call. */
const CARRIER_REFUSAL_CODES = new Set([403, 404, 480, 500, 502, 503, 603, 604]);
const MIN_CALLS_FOR_RATES = 10;
const REFUSAL_SHARE_WARN = 0.3;
const REFUSAL_SHARE_CRIT = 0.6;
const REFUSAL_RUN_CRIT = 10;
const LLM_FAILOVER_SHARE = 0.2;
const LLM_FAILOVER_MIN = 5;

const TTS_FAILOVER = /(tts|cartesia|elevenlabs|texttospeech|aura)[^\n]*(failed, switching|recovery failed)/i;
const STT_FAILOVER = /(\bstt\b|deepgram\.stt|plugins\.deepgram\.stt)[^\n]*(failed, switching|recovery failed)/i;
const LLM_FAILOVER = /\bllm\b[^\n]*failed, switching/i;

export function isCarrierRefusal(c: AlertCall): boolean {
  return c.outcome === 'FAILED' || (c.sipStatusCode != null && CARRIER_REFUSAL_CODES.has(c.sipStatusCode));
}

function pct(n: number, of: number): string {
  return `${Math.round((100 * n) / Math.max(of, 1))}%`;
}

function sample(labels: string[], max = 5): string {
  return labels.slice(0, max).join(', ') + (labels.length > max ? ` and ${labels.length - max} more` : '');
}

/** What looks wrong with one campaign's calls in one window. Empty when all is normal. */
export function findAbnormalities(campaign: AlertCampaign): AlertFinding[] {
  const out: AlertFinding[] = [];
  const base = { campaignId: campaign.id, campaignName: campaign.name };
  const ended = campaign.calls.filter((c) => c.endedAt).sort((a, b) => +a.startedAt - +b.startedAt);

  // 1. The carrier refusing calls: by share, and by an unbroken run (all calls dead).
  const refused = ended.filter(isCarrierRefusal);
  let run = 0;
  let longest = 0;
  for (const c of ended) {
    run = isCarrierRefusal(c) ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  if (ended.length >= MIN_CALLS_FOR_RATES && (refused.length / ended.length >= REFUSAL_SHARE_WARN || longest >= REFUSAL_RUN_CRIT)) {
    const codes: Record<string, number> = {};
    for (const c of refused) codes[String(c.sipStatusCode ?? c.outcome)] = (codes[String(c.sipStatusCode ?? c.outcome)] ?? 0) + 1;
    const share = refused.length / ended.length;
    out.push({
      ...base,
      severity: share >= REFUSAL_SHARE_CRIT || longest >= REFUSAL_RUN_CRIT ? 'CRITICAL' : 'WARNING',
      check: 'CARRIER_REFUSALS',
      title: `Carrier refused ${refused.length} of ${ended.length} calls (${pct(refused.length, ended.length)})`,
      detail:
        `SIP codes: ${Object.entries(codes).map(([k, v]) => `${k} ×${v}`).join(', ')}. ` +
        `Longest unbroken run of refused calls: ${longest}.` +
        (longest >= REFUSAL_RUN_CRIT ? ' Every recent call is failing: the trunk may be down. Consider pausing the campaign.' : ''),
    });
  }

  // 2. Someone answered and talked, and the AI never said a word.
  const silent = ended.filter(
    (c) => c.answeredAt && c.endedAt && +c.endedAt - +c.answeredAt > 8000 && c.speakers.includes('customer') && !c.speakers.includes('ai'),
  );
  if (silent.length) {
    out.push({
      ...base,
      severity: 'CRITICAL',
      check: 'SILENT_AI',
      title: `${silent.length} answered call${silent.length > 1 ? 's' : ''} where the AI never spoke`,
      detail: `Call ids: ${sample(silent.map((c) => c.id))}. Check the voice provider and the worker.`,
    });
  }

  // 3. The voice or speech-to-text provider failing over to its backup.
  const tts = ended.filter((c) => c.workerLog.some((l) => TTS_FAILOVER.test(l) && !/\bllm\b/i.test(l)));
  if (tts.length) {
    out.push({
      ...base,
      severity: 'WARNING',
      check: 'VOICE_FAILOVER',
      title: `Main voice failed on ${tts.length} call${tts.length > 1 ? 's' : ''}; the backup voice was used`,
      detail: `Out of credits or an outage at the voice provider. Call ids: ${sample(tts.map((c) => c.id))}.`,
    });
  }
  const stt = ended.filter((c) => c.workerLog.some((l) => STT_FAILOVER.test(l)));
  if (stt.length) {
    out.push({
      ...base,
      severity: 'CRITICAL',
      check: 'STT_FAILOVER',
      title: `Speech-to-text failed on ${stt.length} call${stt.length > 1 ? 's' : ''}`,
      detail: `The AI cannot hear the customer when this fails. Call ids: ${sample(stt.map((c) => c.id))}.`,
    });
  }

  // 4. The main AI model failing over on a large share of calls (rate limits).
  const llm = ended.filter((c) => c.workerLog.some((l) => LLM_FAILOVER.test(l)));
  if (llm.length >= LLM_FAILOVER_MIN && llm.length / Math.max(ended.length, 1) >= LLM_FAILOVER_SHARE) {
    out.push({
      ...base,
      severity: 'WARNING',
      check: 'LLM_FAILOVER',
      title: `Main AI model failed over on ${llm.length} of ${ended.length} calls`,
      detail: 'Usually rate limits (429). Calls continue on the backup model, a little slower.',
    });
  }

  // 5. A qualified lead asked to be transferred and nobody took the call.
  const lost = ended.filter((c) => c.events.some((e) => e.kind === 'transfer') && !c.bridgedAt);
  if (lost.length) {
    out.push({
      ...base,
      severity: 'WARNING',
      check: 'LOST_TRANSFER',
      title: `${lost.length} qualified lead${lost.length > 1 ? 's were' : ' was'} not handed to an agent`,
      detail:
        `${sample(lost.map((c) => `${c.leadLabel ?? c.id} (${c.events.find((e) => e.kind === 'transfer')?.detail ?? 'no agent'})`))}. ` +
        'Make sure an agent is logged in and accepting transfers.',
    });
  }

  // 6. The dialler stopped: active, was calling in the last window, nothing in this one.
  if (campaign.status === 'ACTIVE' && campaign.calls.length === 0 && campaign.callsInPreviousWindow > 0) {
    out.push({
      ...base,
      severity: 'CRITICAL',
      check: 'DIALLER_STALLED',
      title: 'Campaign is active but placed no calls in this window',
      detail: `It placed ${campaign.callsInPreviousWindow} in the window before. Check agents' availability, fresh leads, calling hours and the API logs.`,
    });
  }

  return out;
}
