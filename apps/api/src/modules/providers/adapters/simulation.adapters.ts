import type {
  LlmAdapter,
  LlmRequest,
  LlmResult,
  SttAdapter,
  SttRequest,
  SttResult,
  TtsAdapter,
  TtsRequest,
  TtsResult,
} from '../types';

/**
 * Deterministic simulation adapters: always registered, used when no real
 * provider key is configured and by the flow simulator (FLOW-05) and the
 * evaluation suite (PLAT-09), so the whole pilot loop runs with zero
 * external dependencies.
 */

export class SimulationTts implements TtsAdapter {
  readonly info = {
    id: 'sim-tts',
    label: 'Simulation TTS',
    capability: 'TTS' as const,
    unitCost: { amountCentsPer: 0, unit: '1k_chars' as const },
    credentialSchema: [],
  };

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    // ~150 wpm speaking rate ≈ 60ms per character of audio.
    const durationMs = Math.max(300, request.text.length * 60);
    return { audio: Buffer.from(`SIM_AUDIO:${request.text}`), mimeType: 'audio/wav', durationMs, costCents: 0 };
  }

  async listVoices() {
    return [
      { id: 'sim-aria', label: 'Aria (simulated en-AU female)' },
      { id: 'sim-jack', label: 'Jack (simulated en-AU male)' },
    ];
  }

  async healthy(): Promise<boolean> {
    return true;
  }
}

export class SimulationStt implements SttAdapter {
  readonly info = {
    id: 'sim-stt',
    label: 'Simulation STT',
    capability: 'STT' as const,
    unitCost: { amountCentsPer: 0, unit: 'minute' as const },
    credentialSchema: [],
  };

  async transcribe(request: SttRequest): Promise<SttResult> {
    // Simulation audio carries its own transcript payload.
    const text = request.audio.toString('utf8').replace(/^SIM_AUDIO:/, '');
    return { text, confidence: 0.99, costCents: 0 };
  }

  async healthy(): Promise<boolean> {
    return true;
  }
}

/**
 * Scripted-persona LLM: emits deterministic JSON turns matching the AI
 * engine's expected envelope, driven by simple keyword rules. Good enough
 * to exercise qualification, objection, opt-out, and transfer paths.
 */
export class SimulationLlm implements LlmAdapter {
  readonly info = {
    id: 'sim-llm',
    label: 'Simulation LLM',
    capability: 'LLM' as const,
    unitCost: { amountCentsPer: 0, unit: '1k_tokens' as const },
    credentialSchema: [],
    models: [],
  };

  async complete(request: LlmRequest): Promise<LlmResult> {
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const lower = lastUser.toLowerCase();

    let payload: Record<string, unknown>;
    if (/don'?t call|do not call|stop calling|remove me/.test(lower)) {
      payload = { reply: 'Understood — I will remove you from our list right away. Sorry to have bothered you.', intent: 'opt_out', captured: {}, objection: null };
    } else if (/not interested|no thanks/.test(lower)) {
      payload = {
        reply: 'No worries at all. Before I let you go — many homeowners found their bills dropped significantly. Would a quick no-obligation chat be worth it?',
        intent: 'objection',
        captured: {},
        objection: 'not_interested',
      };
    } else if (/own|owner|yes.*house/.test(lower)) {
      payload = { reply: 'Great, thanks for confirming. And roughly how much is your quarterly power bill?', intent: 'continue', captured: { owner: true, dwellingHouse: true }, objection: null };
    } else if (/\$?\s*\d{3,4}|bill/.test(lower)) {
      payload = { reply: 'Thanks — that is right in the range where solar pays off. Would you be open to a quick visit from one of our specialists?', intent: 'continue', captured: { billHigh: true }, objection: null };
    } else if (/yes|sure|okay|ok/.test(lower)) {
      payload = { reply: 'Fantastic. Let me get a specialist on the line to lock in a time that suits you.', intent: 'qualified', captured: { appointmentInterest: true }, objection: null };
    } else if (request.jsonMode && /summar/i.test(request.messages[0]?.content ?? '')) {
      payload = { summary: 'Simulated summary of the conversation.' };
    } else {
      payload = { reply: 'Thanks for that. Can I confirm — do you own your home?', intent: 'continue', captured: {}, objection: null };
    }

    const text = request.jsonMode ? JSON.stringify(payload) : String(payload.reply ?? '');
    return { text, inputTokens: 100, outputTokens: 50, costCents: 0 };
  }

  async healthy(): Promise<boolean> {
    return true;
  }
}
