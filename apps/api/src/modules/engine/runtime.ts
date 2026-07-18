import type { AmdClass } from '@cocally/shared';

/**
 * CallRuntime abstracts the media layer from the flow executor. The
 * simulation runtime implements it for dev/test/simulator (FLOW-05) and the
 * evaluation suite (PLAT-09); the SIP runtime implements it against real
 * trunks. The executor and AI loop are identical across both — which is
 * what keeps "the agent that talks is the agent that thinks" true.
 */
export interface CallRuntime {
  /** Speak text to the customer (TTS through PAL). Resolves when playback ends or barge-in occurs. */
  say(text: string, options?: { interruptible?: boolean }): Promise<{ bargedIn: boolean }>;
  /** Play a pre-recorded prompt asset per FLOW-03. */
  playAsset(assetId: string): Promise<void>;
  /** Wait for the customer's next utterance (STT through PAL). Null on silence timeout. */
  listen(options?: { timeoutMs?: number; numberCapture?: boolean }): Promise<string | null>;
  /** Classify who answered per TEL-04. */
  amdClassify(): Promise<{ amdClass: AmdClass; latencyMs: number }>;
  /** Send DTMF digits per TEL-06. */
  sendDtmf(digits: string): Promise<void>;
  /** End the call. */
  hangup(): Promise<void>;
  /**
   * Ask the transfer orchestrator for a warm transfer. Resolves once the
   * bridge completes or every fallback is exhausted.
   */
  requestTransfer(input: {
    whisperEnabled: boolean;
    acceptWindowSeconds: number;
  }): Promise<'BRIDGED' | 'NO_AGENT' | 'FAILED'>;
}

/** Mutable per-call state threaded through the executor. */
export interface CallContext {
  callId: string;
  tenantId: string;
  campaignId: string;
  leadId: string;
  /** Template variables: lead fields + captured facts. */
  vars: Record<string, unknown>;
  /** Structured qualification facts per AI-06. */
  facts: Record<string, unknown>;
  score: number;
  amdClass?: AmdClass;
  attempt: number;
  objections: Array<{ label: string; recovered: boolean }>;
  startedAt: number;
}

export type ExecutionOutcome =
  | { kind: 'COMPLETED'; disposition?: string; endOutcome: string }
  | { kind: 'TRANSFERRED' }
  | { kind: 'OPT_OUT' }
  | { kind: 'VOICEMAIL'; dropped: boolean }
  | { kind: 'ABORTED'; reason: string };

export function interpolate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const value = key.split('.').reduce<unknown>((acc, part) => {
      if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[part];
      return undefined;
    }, vars);
    return value === undefined || value === null ? '' : String(value);
  });
}
