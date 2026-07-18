import type {
  LlmAdapter,
  LlmRequest,
  LlmResult,
  ProviderCredentials,
  SttAdapter,
  SttRequest,
  SttResult,
  TtsAdapter,
  TtsRequest,
  TtsResult,
} from '../types';

/**
 * Real provider adapters per PAL-01/02/03. Each declares its own credential
 * schema — providers genuinely differ (plain API key vs key+region vs
 * service-account JSON vs base URL) — and the registry passes the decrypted
 * bundle back at call time. Streaming variants land with the SIP telephony
 * driver; the REST forms below serve the simulation driver, voice previews,
 * and voicemail-drop synthesis.
 */

function applyLexicon(text: string, lexicon?: Record<string, string>): string {
  if (!lexicon) return text;
  let out = text;
  for (const [term, replacement] of Object.entries(lexicon)) {
    out = out.replaceAll(term, replacement);
  }
  return out;
}

export class ElevenLabsTts implements TtsAdapter {
  readonly info = {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    capability: 'TTS' as const,
    unitCost: { amountCentsPer: 30, unit: '1k_chars' as const },
    credentialSchema: [
      { key: 'apiKey', label: 'API key', type: 'secret' as const, required: true, placeholder: 'sk_…', help: 'ElevenLabs → Profile → API keys' },
    ],
    params: [
      { key: 'stability', label: 'Stability', type: 'number' as const, default: 0.5, min: 0, max: 1, step: 0.05 },
      { key: 'similarity_boost', label: 'Similarity boost', type: 'number' as const, default: 0.75, min: 0, max: 1, step: 0.05 },
      { key: 'speed', label: 'Speed', type: 'number' as const, default: 1, min: 0.7, max: 1.2, step: 0.05 },
    ],
  };

  async synthesize(request: TtsRequest, credentials?: ProviderCredentials): Promise<TtsResult> {
    const apiKey = credentials?.apiKey;
    if (!apiKey) throw new Error('ElevenLabs API key not configured');
    const voiceId = request.voiceId ?? 'EXAVITQu4vr4xnSDxMaL';
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: applyLexicon(request.text, request.lexicon),
        model_id: 'eleven_turbo_v2_5',
        voice_settings: request.params ?? { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
    if (!response.ok) throw new Error(`ElevenLabs TTS failed: ${response.status}`);
    const audio = Buffer.from(await response.arrayBuffer());
    const costCents = Math.ceil((request.text.length / 1000) * this.info.unitCost.amountCentsPer);
    return { audio, mimeType: 'audio/mpeg', durationMs: request.text.length * 60, costCents };
  }

  async listVoices(credentials?: ProviderCredentials) {
    if (!credentials?.apiKey) return [];
    const response = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': credentials.apiKey } });
    if (!response.ok) return [];
    const data = (await response.json()) as { voices: Array<{ voice_id: string; name: string }> };
    return data.voices.map((v) => ({ id: v.voice_id, label: v.name }));
  }

  async healthy(credentials?: ProviderCredentials): Promise<boolean> {
    if (!credentials?.apiKey) return false;
    try {
      const response = await fetch('https://api.elevenlabs.io/v1/user', { headers: { 'xi-api-key': credentials.apiKey } });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export class GoogleTts implements TtsAdapter {
  readonly info = {
    id: 'google-tts',
    label: 'Google Cloud TTS',
    capability: 'TTS' as const,
    unitCost: { amountCentsPer: 2, unit: '1k_chars' as const },
    credentialSchema: [
      {
        key: 'apiKey',
        label: 'API key',
        type: 'secret' as const,
        required: true,
        help: 'Google Cloud Console → APIs & Services → Credentials (Cloud Text-to-Speech API enabled). Service-account OAuth lands with the streaming driver.',
      },
    ],
    params: [
      { key: 'speakingRate', label: 'Speaking rate', type: 'number' as const, default: 1, min: 0.5, max: 2, step: 0.05 },
      { key: 'pitch', label: 'Pitch', type: 'number' as const, default: 0, min: -10, max: 10, step: 0.5 },
    ],
  };

  async synthesize(request: TtsRequest, credentials?: ProviderCredentials): Promise<TtsResult> {
    const apiKey = credentials?.apiKey;
    if (!apiKey) throw new Error('Google Cloud API key not configured');
    const response = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: { text: applyLexicon(request.text, request.lexicon) },
        voice: { languageCode: 'en-AU', name: request.voiceId ?? 'en-AU-Neural2-A' },
        audioConfig: { audioEncoding: 'MP3', ...(request.params ?? {}) },
      }),
    });
    if (!response.ok) throw new Error(`Google TTS failed: ${response.status}`);
    const data = (await response.json()) as { audioContent: string };
    const audio = Buffer.from(data.audioContent, 'base64');
    const costCents = Math.ceil((request.text.length / 1000) * this.info.unitCost.amountCentsPer);
    return { audio, mimeType: 'audio/mpeg', durationMs: request.text.length * 60, costCents };
  }

  async listVoices(credentials?: ProviderCredentials) {
    if (!credentials?.apiKey) return [];
    const response = await fetch(`https://texttospeech.googleapis.com/v1/voices?languageCode=en-AU&key=${credentials.apiKey}`);
    if (!response.ok) return [];
    const data = (await response.json()) as { voices: Array<{ name: string }> };
    return data.voices.map((v) => ({ id: v.name, label: v.name }));
  }

  async healthy(credentials?: ProviderCredentials): Promise<boolean> {
    return Boolean(credentials?.apiKey);
  }
}

export class DeepgramStt implements SttAdapter {
  readonly info = {
    id: 'deepgram',
    label: 'Deepgram',
    capability: 'STT' as const,
    unitCost: { amountCentsPer: 1, unit: 'minute' as const },
    credentialSchema: [
      { key: 'apiKey', label: 'API key', type: 'secret' as const, required: true, help: 'Deepgram Console → API Keys' },
    ],
    languages: ['en-AU', 'en-US', 'en-GB', 'en-NZ', 'en-IN', 'hi'],
  };

  async transcribe(request: SttRequest, credentials?: ProviderCredentials): Promise<SttResult> {
    const apiKey = credentials?.apiKey;
    if (!apiKey) throw new Error('Deepgram API key not configured');
    const params = new URLSearchParams({ model: 'nova-2', language: request.language, smart_format: 'true' });
    for (const keyword of request.keywords ?? []) params.append('keywords', keyword);
    const response = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'content-type': request.mimeType },
      body: new Uint8Array(request.audio),
    });
    if (!response.ok) throw new Error(`Deepgram STT failed: ${response.status}`);
    const data = (await response.json()) as {
      results: { channels: Array<{ alternatives: Array<{ transcript: string; confidence: number }> }> };
    };
    const alt = data.results.channels[0]?.alternatives[0];
    return { text: alt?.transcript ?? '', confidence: alt?.confidence ?? 0, costCents: 1 };
  }

  async healthy(credentials?: ProviderCredentials): Promise<boolean> {
    return Boolean(credentials?.apiKey);
  }
}

export class OpenAiWhisperStt implements SttAdapter {
  readonly info = {
    id: 'openai-whisper',
    label: 'Whisper (OpenAI hosted)',
    capability: 'STT' as const,
    unitCost: { amountCentsPer: 1, unit: 'minute' as const },
    credentialSchema: [
      { key: 'apiKey', label: 'API key', type: 'secret' as const, required: true, placeholder: 'sk-…' },
      {
        key: 'baseUrl',
        label: 'Base URL (optional)',
        type: 'url' as const,
        required: false,
        placeholder: 'https://api.openai.com/v1',
        help: 'Point at a self-hosted Whisper server with an OpenAI-compatible API',
      },
    ],
    languages: ['en', 'hi', 'ta', 'te', 'zh', 'es'],
  };

  async transcribe(request: SttRequest, credentials?: ProviderCredentials): Promise<SttResult> {
    const apiKey = credentials?.apiKey;
    if (!apiKey) throw new Error('OpenAI API key not configured');
    const baseUrl = credentials?.baseUrl?.replace(/\/$/, '') || 'https://api.openai.com/v1';
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(request.audio)], { type: request.mimeType }), 'audio.wav');
    form.append('model', 'whisper-1');
    form.append('language', request.language.split('-')[0] ?? 'en');
    const response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!response.ok) throw new Error(`Whisper STT failed: ${response.status}`);
    const data = (await response.json()) as { text: string };
    return { text: data.text, confidence: 0.9, costCents: 1 };
  }

  async healthy(credentials?: ProviderCredentials): Promise<boolean> {
    return Boolean(credentials?.apiKey);
  }
}

export class AzureStt implements SttAdapter {
  readonly info = {
    id: 'azure-stt',
    label: 'Azure Speech',
    capability: 'STT' as const,
    unitCost: { amountCentsPer: 2, unit: 'minute' as const },
    credentialSchema: [
      { key: 'apiKey', label: 'Speech resource key', type: 'secret' as const, required: true },
      { key: 'region', label: 'Region', type: 'text' as const, required: true, placeholder: 'australiaeast', help: 'The Azure region of your Speech resource' },
    ],
    languages: ['en-AU', 'en-US', 'en-GB', 'en-IN', 'hi-IN'],
  };

  async transcribe(request: SttRequest, credentials?: ProviderCredentials): Promise<SttResult> {
    const { apiKey, region } = credentials ?? {};
    if (!apiKey || !region) throw new Error('Azure Speech key/region not configured');
    const response = await fetch(
      `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${request.language}`,
      {
        method: 'POST',
        headers: { 'Ocp-Apim-Subscription-Key': apiKey, 'content-type': request.mimeType },
        body: new Uint8Array(request.audio),
      },
    );
    if (!response.ok) throw new Error(`Azure STT failed: ${response.status}`);
    const data = (await response.json()) as { DisplayText?: string; RecognitionStatus: string };
    return { text: data.DisplayText ?? '', confidence: data.RecognitionStatus === 'Success' ? 0.9 : 0.3, costCents: 2 };
  }

  async healthy(credentials?: ProviderCredentials): Promise<boolean> {
    return Boolean(credentials?.apiKey && credentials?.region);
  }
}

export class AnthropicLlm implements LlmAdapter {
  readonly info = {
    id: 'anthropic',
    label: 'Anthropic Claude',
    capability: 'LLM' as const,
    unitCost: { amountCentsPer: 30, unit: '1k_tokens' as const },
    credentialSchema: [
      { key: 'apiKey', label: 'API key', type: 'secret' as const, required: true, placeholder: 'sk-ant-…', help: 'console.anthropic.com → API keys' },
    ],
    models: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-fable-5'],
  };

  async complete(request: LlmRequest, credentials?: ProviderCredentials): Promise<LlmResult> {
    const apiKey = credentials?.apiKey;
    if (!apiKey) throw new Error('Anthropic API key not configured');
    const system = request.messages.find((m) => m.role === 'system')?.content;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: request.model ?? this.info.models[0],
        max_tokens: request.maxTokens ?? 512,
        temperature: request.temperature ?? 0.7,
        system,
        messages: request.messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    if (!response.ok) throw new Error(`Anthropic completion failed: ${response.status}`);
    const data = (await response.json()) as {
      content: Array<{ type: string; text?: string }>;
      usage: { input_tokens: number; output_tokens: number };
    };
    const text = data.content.find((c) => c.type === 'text')?.text ?? '';
    const costCents = Math.ceil(((data.usage.input_tokens + data.usage.output_tokens) / 1000) * this.info.unitCost.amountCentsPer);
    return { text, inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens, costCents };
  }

  async healthy(credentials?: ProviderCredentials): Promise<boolean> {
    return Boolean(credentials?.apiKey);
  }
}

export class OpenAiLlm implements LlmAdapter {
  readonly info = {
    id: 'openai',
    label: 'OpenAI GPT',
    capability: 'LLM' as const,
    unitCost: { amountCentsPer: 20, unit: '1k_tokens' as const },
    credentialSchema: [
      { key: 'apiKey', label: 'API key', type: 'secret' as const, required: true, placeholder: 'sk-…' },
      {
        key: 'baseUrl',
        label: 'Base URL (optional)',
        type: 'url' as const,
        required: false,
        placeholder: 'https://api.openai.com/v1',
        help: 'Point at Azure OpenAI or any OpenAI-compatible self-hosted model (vLLM, Ollama, llama.cpp server)',
      },
    ],
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'],
  };

  async complete(request: LlmRequest, credentials?: ProviderCredentials): Promise<LlmResult> {
    const apiKey = credentials?.apiKey;
    if (!apiKey) throw new Error('OpenAI API key not configured');
    const baseUrl = credentials?.baseUrl?.replace(/\/$/, '') || 'https://api.openai.com/v1';
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: request.model ?? this.info.models[0],
        max_tokens: request.maxTokens ?? 512,
        temperature: request.temperature ?? 0.7,
        messages: request.messages,
        ...(request.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (!response.ok) throw new Error(`OpenAI completion failed: ${response.status}`);
    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    const costCents = Math.ceil(((data.usage.prompt_tokens + data.usage.completion_tokens) / 1000) * this.info.unitCost.amountCentsPer);
    return {
      text: data.choices[0]?.message.content ?? '',
      inputTokens: data.usage.prompt_tokens,
      outputTokens: data.usage.completion_tokens,
      costCents,
    };
  }

  async healthy(credentials?: ProviderCredentials): Promise<boolean> {
    return Boolean(credentials?.apiKey);
  }
}

export class GeminiLlm implements LlmAdapter {
  readonly info = {
    id: 'gemini',
    label: 'Google Gemini',
    capability: 'LLM' as const,
    unitCost: { amountCentsPer: 10, unit: '1k_tokens' as const },
    credentialSchema: [
      { key: 'apiKey', label: 'API key', type: 'secret' as const, required: true, help: 'aistudio.google.com → Get API key' },
    ],
    models: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-pro'],
  };

  async complete(request: LlmRequest, credentials?: ProviderCredentials): Promise<LlmResult> {
    const apiKey = credentials?.apiKey;
    if (!apiKey) throw new Error('Google API key not configured');
    const model = request.model ?? this.info.models[0];
    const system = request.messages.find((m) => m.role === 'system')?.content;
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          contents: request.messages
            .filter((m) => m.role !== 'system')
            .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
          generationConfig: {
            maxOutputTokens: request.maxTokens ?? 512,
            temperature: request.temperature ?? 0.7,
            ...(request.jsonMode ? { responseMimeType: 'application/json' } : {}),
          },
        }),
      },
    );
    if (!response.ok) throw new Error(`Gemini completion failed: ${response.status}`);
    const data = (await response.json()) as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
      usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
    };
    const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
    const costCents = Math.ceil(((inputTokens + outputTokens) / 1000) * this.info.unitCost.amountCentsPer);
    return { text: data.candidates[0]?.content.parts.map((p) => p.text).join('') ?? '', inputTokens, outputTokens, costCents };
  }

  async healthy(credentials?: ProviderCredentials): Promise<boolean> {
    return Boolean(credentials?.apiKey);
  }
}

export class SelfHostedLlm implements LlmAdapter {
  readonly info = {
    id: 'self-hosted-llm',
    label: 'Self-hosted (OpenAI-compatible)',
    capability: 'LLM' as const,
    unitCost: { amountCentsPer: 0, unit: '1k_tokens' as const },
    credentialSchema: [
      { key: 'baseUrl', label: 'Base URL', type: 'url' as const, required: true, placeholder: 'http://llm.internal:8000/v1', help: 'vLLM / Ollama / llama.cpp server exposing the OpenAI chat API' },
      { key: 'apiKey', label: 'API key (optional)', type: 'secret' as const, required: false },
      { key: 'model', label: 'Model name', type: 'text' as const, required: true, placeholder: 'llama-3.3-70b' },
    ],
    models: [],
  };

  async complete(request: LlmRequest, credentials?: ProviderCredentials): Promise<LlmResult> {
    const baseUrl = credentials?.baseUrl?.replace(/\/$/, '');
    if (!baseUrl) throw new Error('Self-hosted LLM base URL not configured');
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(credentials?.apiKey ? { Authorization: `Bearer ${credentials.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: request.model ?? credentials?.model ?? 'default',
        max_tokens: request.maxTokens ?? 512,
        temperature: request.temperature ?? 0.7,
        messages: request.messages,
      }),
    });
    if (!response.ok) throw new Error(`Self-hosted LLM failed: ${response.status}`);
    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    return {
      text: data.choices[0]?.message.content ?? '',
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      costCents: 0,
    };
  }

  async healthy(credentials?: ProviderCredentials): Promise<boolean> {
    return Boolean(credentials?.baseUrl);
  }
}
