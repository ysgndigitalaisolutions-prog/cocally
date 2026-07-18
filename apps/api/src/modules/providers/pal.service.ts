import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ProviderCapability } from '@cocally/shared';
import { Model, Types } from 'mongoose';
import { ProviderOverride, ProviderOverrideDocument } from '../../schemas/provider.schema';
import {
  AnthropicLlm,
  AzureStt,
  DeepgramStt,
  ElevenLabsTts,
  GeminiLlm,
  GoogleTts,
  OpenAiLlm,
  OpenAiWhisperStt,
  SelfHostedLlm,
} from './adapters/http.adapters';
import { SimulationLlm, SimulationStt, SimulationTts } from './adapters/simulation.adapters';
import type {
  LlmAdapter,
  LlmRequest,
  LlmResult,
  ResolveScope,
  ResolvedChainEntry,
  SttAdapter,
  SttRequest,
  SttResult,
  TtsAdapter,
  TtsRequest,
  TtsResult,
} from './types';
import { VaultService } from './vault.service';

/**
 * Provider abstraction layer per PAL-04/05: resolves the provider chain for
 * a capability by walking the override hierarchy (flow node → campaign →
 * country pack → tenant → platform default) and executes with automatic
 * fallback on failure, tracking which provider actually served the call.
 */
@Injectable()
export class PalService {
  private readonly logger = new Logger(PalService.name);

  private readonly ttsAdapters = new Map<string, TtsAdapter>();
  private readonly sttAdapters = new Map<string, SttAdapter>();
  private readonly llmAdapters = new Map<string, LlmAdapter>();

  /** Providers marked unhealthy after a failure; retried after cooldown (PAL-05). */
  private readonly unhealthyUntil = new Map<string, number>();
  private static readonly COOLDOWN_MS = 60_000;

  constructor(
    @InjectModel(ProviderOverride.name) private readonly overrideModel: Model<ProviderOverrideDocument>,
    private readonly vault: VaultService,
  ) {
    // Launch adapter set per PAL-01/02/03; registering a new provider is one line.
    for (const adapter of [new ElevenLabsTts(), new GoogleTts(), new SimulationTts()])
      this.ttsAdapters.set(adapter.info.id, adapter);
    for (const adapter of [new DeepgramStt(), new OpenAiWhisperStt(), new AzureStt(), new SimulationStt()])
      this.sttAdapters.set(adapter.info.id, adapter);
    for (const adapter of [new AnthropicLlm(), new OpenAiLlm(), new GeminiLlm(), new SelfHostedLlm(), new SimulationLlm()])
      this.llmAdapters.set(adapter.info.id, adapter);
  }

  listProviders() {
    const describe = (a: { info: TtsAdapter['info'] }) => a.info;
    return {
      tts: [...this.ttsAdapters.values()].map(describe),
      stt: [...this.sttAdapters.values()].map(describe),
      llm: [...this.llmAdapters.values()].map(describe),
    };
  }

  /** Voice picker per PAL-06: live voices from the provider using the tenant's credentials. */
  async listVoices(tenantId: string, providerId: string): Promise<Array<{ id: string; label: string }>> {
    const adapter = this.ttsAdapters.get(providerId);
    if (!adapter) return [];
    const credentials = await this.vault.getCredentials(tenantId, providerId);
    return adapter.listVoices(credentials).catch(() => []);
  }

  /** Resolve the ordered provider chain for a capability per PAL-04. */
  async resolveChain(capability: ProviderCapability, scope: ResolveScope): Promise<ResolvedChainEntry[]> {
    if (scope.nodeProviderId) {
      return [{ providerId: scope.nodeProviderId }, ...(await this.defaultChain(capability))];
    }

    const llmRoleFilter = capability === 'LLM' ? { $or: [{ llmRole: scope.llmRole }, { llmRole: { $exists: false } }] } : {};

    const levels: Array<Record<string, unknown>> = [];
    if (scope.campaignId) {
      levels.push({ level: 'CAMPAIGN', scopeId: scope.campaignId, tenantId: new Types.ObjectId(scope.tenantId) });
    }
    if (scope.countryPackCode) {
      levels.push({ level: 'COUNTRY_PACK', scopeId: scope.countryPackCode });
    }
    if (scope.tenantId) {
      levels.push({ level: 'TENANT', tenantId: new Types.ObjectId(scope.tenantId) });
    }
    levels.push({ level: 'PLATFORM' });

    for (const levelFilter of levels) {
      const override = await this.overrideModel
        .findOne({ capability, ...levelFilter, ...llmRoleFilter })
        .sort({ llmRole: -1 }) // role-specific beats role-agnostic
        .lean()
        .exec();
      if (override?.chain?.length) return override.chain;
    }

    return this.defaultChain(capability);
  }

  private async defaultChain(capability: ProviderCapability): Promise<ResolvedChainEntry[]> {
    // Simulation adapters guarantee a working chain with no keys configured.
    const defaults: Record<ProviderCapability, ResolvedChainEntry[]> = {
      TTS: [{ providerId: 'elevenlabs' }, { providerId: 'sim-tts' }],
      STT: [{ providerId: 'deepgram' }, { providerId: 'openai-whisper' }, { providerId: 'sim-stt' }],
      LLM: [{ providerId: 'anthropic' }, { providerId: 'openai' }, { providerId: 'gemini' }, { providerId: 'sim-llm' }],
    };
    return defaults[capability];
  }

  async setOverride(input: {
    tenantId?: string;
    level: 'PLATFORM' | 'TENANT' | 'COUNTRY_PACK' | 'CAMPAIGN';
    scopeId?: string;
    capability: ProviderCapability;
    llmRole?: 'CONVERSATION' | 'SUMMARY' | 'SCORING';
    chain: ResolvedChainEntry[];
  }): Promise<void> {
    const filter = {
      level: input.level,
      capability: input.capability,
      ...(input.tenantId ? { tenantId: new Types.ObjectId(input.tenantId) } : {}),
      ...(input.scopeId ? { scopeId: input.scopeId } : {}),
      ...(input.llmRole ? { llmRole: input.llmRole } : {}),
    };
    await this.overrideModel.updateOne(filter, { ...filter, chain: input.chain }, { upsert: true }).exec();
  }

  private isCoolingDown(providerId: string): boolean {
    const until = this.unhealthyUntil.get(providerId);
    return until !== undefined && until > Date.now();
  }

  private markUnhealthy(providerId: string): void {
    this.unhealthyUntil.set(providerId, Date.now() + PalService.COOLDOWN_MS);
    this.logger.warn(`Provider ${providerId} marked unhealthy for ${PalService.COOLDOWN_MS / 1000}s`);
  }

  /** Execute TTS through the resolved chain with automatic failover per PAL-05. */
  async tts(scope: ResolveScope, request: TtsRequest): Promise<TtsResult & { providerId: string }> {
    const chain = await this.resolveChain('TTS', scope);
    return this.executeChain(chain, async (entry) => {
      const adapter = this.ttsAdapters.get(entry.providerId);
      if (!adapter) throw new Error(`Unknown TTS provider ${entry.providerId}`);
      const credentials = scope.tenantId ? await this.vault.getCredentials(scope.tenantId, entry.providerId) : undefined;
      const result = await adapter.synthesize({ ...request, voiceId: request.voiceId ?? entry.voiceId, params: { ...entry.params, ...request.params } }, credentials);
      return { ...result, providerId: entry.providerId };
    });
  }

  async stt(scope: ResolveScope, request: SttRequest): Promise<SttResult & { providerId: string }> {
    const chain = await this.resolveChain('STT', scope);
    return this.executeChain(chain, async (entry) => {
      const adapter = this.sttAdapters.get(entry.providerId);
      if (!adapter) throw new Error(`Unknown STT provider ${entry.providerId}`);
      const credentials = scope.tenantId ? await this.vault.getCredentials(scope.tenantId, entry.providerId) : undefined;
      const result = await adapter.transcribe(request, credentials);
      return { ...result, providerId: entry.providerId };
    });
  }

  async llm(scope: ResolveScope, request: LlmRequest): Promise<LlmResult & { providerId: string }> {
    const chain = await this.resolveChain('LLM', scope);
    return this.executeChain(chain, async (entry) => {
      const adapter = this.llmAdapters.get(entry.providerId);
      if (!adapter) throw new Error(`Unknown LLM provider ${entry.providerId}`);
      const credentials = scope.tenantId ? await this.vault.getCredentials(scope.tenantId, entry.providerId) : undefined;
      const result = await adapter.complete({ ...request, model: request.model ?? entry.model }, credentials);
      return { ...result, providerId: entry.providerId };
    });
  }

  private async executeChain<T>(chain: ResolvedChainEntry[], run: (entry: ResolvedChainEntry) => Promise<T>): Promise<T> {
    const errors: string[] = [];
    for (const entry of chain) {
      if (this.isCoolingDown(entry.providerId)) continue;
      try {
        return await run(entry);
      } catch (err) {
        errors.push(`${entry.providerId}: ${(err as Error).message}`);
        this.markUnhealthy(entry.providerId);
      }
    }
    // Last resort: retry cooling-down providers once rather than failing the call.
    for (const entry of chain) {
      try {
        return await run(entry);
      } catch (err) {
        errors.push(`${entry.providerId} (retry): ${(err as Error).message}`);
      }
    }
    throw new Error(`All providers in chain failed: ${errors.join('; ')}`);
  }
}
