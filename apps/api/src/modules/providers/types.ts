import type { LlmRole, ProviderCapability } from '@cocally/shared';

/**
 * PAL adapter contracts per PAL-01/02/03. Every AI capability is a registry
 * of interchangeable providers behind one internal interface; adding a
 * provider is a plugin (implement the interface, register it), not a rebuild.
 */

/**
 * One credential field a provider needs. Providers differ: a plain API key
 * (ElevenLabs, Deepgram, Anthropic), key + region (Azure), a service-account
 * JSON blob (Google Cloud), or a base URL + optional key (self-hosted).
 * The vault stores whatever shape the schema declares, encrypted as one blob.
 */
export interface CredentialField {
  key: string;
  label: string;
  type: 'secret' | 'text' | 'url' | 'json';
  required: boolean;
  help?: string;
  placeholder?: string;
}

/** Decrypted credential bundle passed to adapters. */
export type ProviderCredentials = Record<string, string>;

export interface ProviderInfo {
  id: string;
  label: string;
  capability: ProviderCapability;
  /** Unit cost surfaced in admin per PAL-08. */
  unitCost: { amountCentsPer: number; unit: 'minute' | '1k_chars' | '1k_tokens' };
  /** What credentials this provider needs (drives the admin form). */
  credentialSchema: CredentialField[];
  /** Selectable models for LLM providers (first = default). */
  models?: string[];
  /** Supported STT language packs (PAL-07). */
  languages?: string[];
  /** Tunable parameters with defaults, e.g. TTS stability/speed (PAL-06). */
  params?: Array<{ key: string; label: string; type: 'number' | 'select'; default: number | string; options?: string[]; min?: number; max?: number; step?: number }>;
}

export interface TtsRequest {
  text: string;
  voiceId?: string;
  /** speed / stability / style per PAL-06. */
  params?: Record<string, unknown>;
  /** Pronunciation lexicon entries applied before synthesis. */
  lexicon?: Record<string, string>;
}

export interface TtsResult {
  audio: Buffer;
  mimeType: string;
  durationMs: number;
  costCents: number;
}

export interface TtsAdapter {
  readonly info: ProviderInfo;
  synthesize(request: TtsRequest, credentials?: ProviderCredentials): Promise<TtsResult>;
  listVoices(credentials?: ProviderCredentials): Promise<Array<{ id: string; label: string }>>;
  healthy(credentials?: ProviderCredentials): Promise<boolean>;
}

export interface SttRequest {
  audio: Buffer;
  mimeType: string;
  /** Language pack per PAL-07, e.g. "en-AU". */
  language: string;
  /** Keyword boosting from campaign vocabulary per PAL-07. */
  keywords?: string[];
  /** Number-capture mode for phone/bill read-backs per PAL-07. */
  numberCapture?: boolean;
}

export interface SttResult {
  text: string;
  confidence: number;
  costCents: number;
}

export interface SttAdapter {
  readonly info: ProviderInfo;
  transcribe(request: SttRequest, credentials?: ProviderCredentials): Promise<SttResult>;
  healthy(credentials?: ProviderCredentials): Promise<boolean>;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Ask the model for a JSON object response. */
  jsonMode?: boolean;
}

export interface LlmResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

export interface LlmAdapter {
  readonly info: ProviderInfo;
  complete(request: LlmRequest, credentials?: ProviderCredentials): Promise<LlmResult>;
  healthy(credentials?: ProviderCredentials): Promise<boolean>;
}

export type AnyAdapter = TtsAdapter | SttAdapter | LlmAdapter;

/** A resolved provider chain entry per PAL-04/05. */
export interface ResolvedChainEntry {
  providerId: string;
  model?: string;
  voiceId?: string;
  params?: Record<string, unknown>;
}

export interface ResolveScope {
  tenantId?: string;
  countryPackCode?: string;
  campaignId?: string;
  /** Flow-node override per PAL-04 (highest precedence). */
  nodeProviderId?: string;
  llmRole?: LlmRole;
}
