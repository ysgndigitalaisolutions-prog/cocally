import { BadRequestException, Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { LLM_ROLES, PROVIDER_CAPABILITIES, type LlmRole, type ProviderCapability } from '@cocally/shared';
import { ArrayNotEmpty, IsArray, IsIn, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { AuditService } from '../audit/audit.service';
import { PalService } from './pal.service';
import type { ResolvedChainEntry } from './types';
import { VaultService } from './vault.service';

class SetCredentialsDto {
  @IsString()
  @IsNotEmpty()
  providerId: string;

  /** Field values per the provider's credentialSchema, e.g. {apiKey}, {apiKey, region}, {baseUrl, model}. */
  @IsObject()
  credentials: Record<string, string>;
}

class SetChainDto {
  @IsIn(PROVIDER_CAPABILITIES)
  capability: ProviderCapability;

  @IsOptional()
  @IsIn(LLM_ROLES)
  llmRole?: LlmRole;

  /** Ordered: first is primary, rest are fallbacks (PAL-05). */
  @IsArray()
  @ArrayNotEmpty()
  chain: ResolvedChainEntry[];

  /** TENANT (default) or CAMPAIGN with scopeId = campaign id (PAL-04). */
  @IsOptional()
  @IsIn(['TENANT', 'CAMPAIGN'])
  level?: 'TENANT' | 'CAMPAIGN';

  @IsOptional()
  @IsString()
  scopeId?: string;
}

@Controller('providers')
export class ProvidersController {
  constructor(
    private readonly pal: PalService,
    private readonly vault: VaultService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Full registry for the admin console: every adapter's credential schema,
   * models/languages/params, whether this tenant has stored credentials,
   * and the currently-resolved chain per capability (per LLM role).
   */
  @Get()
  @Roles('ADMIN')
  async registry(@CurrentUser() user: AuthenticatedUser) {
    const providers = this.pal.listProviders();
    const configured = new Set(await this.vault.configuredProviderIds(user.tenantId));
    const withConfigured = (list: typeof providers.tts) =>
      list.map((info) => ({ ...info, configured: configured.has(info.id) || info.id.startsWith('sim-') }));

    const scope = { tenantId: user.tenantId };
    const [ttsChain, sttChain, convChain, summaryChain, scoringChain] = await Promise.all([
      this.pal.resolveChain('TTS', scope),
      this.pal.resolveChain('STT', scope),
      this.pal.resolveChain('LLM', { ...scope, llmRole: 'CONVERSATION' }),
      this.pal.resolveChain('LLM', { ...scope, llmRole: 'SUMMARY' }),
      this.pal.resolveChain('LLM', { ...scope, llmRole: 'SCORING' }),
    ]);

    return {
      tts: withConfigured(providers.tts),
      stt: withConfigured(providers.stt),
      llm: withConfigured(providers.llm),
      chains: {
        TTS: ttsChain,
        STT: sttChain,
        LLM: { CONVERSATION: convChain, SUMMARY: summaryChain, SCORING: scoringChain },
      },
    };
  }

  /** Store a provider's credential bundle in the vault (PAL-12). */
  @Post('secrets')
  @Roles('ADMIN')
  async setCredentials(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetCredentialsDto) {
    const all = this.pal.listProviders();
    const info = [...all.tts, ...all.stt, ...all.llm].find((p) => p.id === dto.providerId);
    if (!info) throw new BadRequestException(`Unknown provider ${dto.providerId}`);

    // Validate against the provider's schema: required fields present, no unknown fields.
    const allowed = new Set(info.credentialSchema.map((f) => f.key));
    for (const field of info.credentialSchema) {
      if (field.required && !dto.credentials[field.key]?.trim()) {
        throw new BadRequestException(`Missing required credential field "${field.label}"`);
      }
    }
    for (const key of Object.keys(dto.credentials)) {
      if (!allowed.has(key)) throw new BadRequestException(`Unknown credential field "${key}" for ${info.label}`);
    }

    const trimmed = Object.fromEntries(
      Object.entries(dto.credentials)
        .filter(([, value]) => value?.trim())
        .map(([key, value]) => [key, value.trim()]),
    );
    await this.vault.setCredentials(user.tenantId, dto.providerId, trimmed);

    // Never audit values (PAL-12) — only which fields changed.
    await this.audit.record({
      tenantId: user.tenantId,
      actorId: user.userId,
      actorLabel: user.email,
      action: 'provider.secret_set',
      entityType: 'ProviderSecret',
      after: { providerId: dto.providerId, fields: Object.keys(trimmed) },
    });
    return { ok: true };
  }

  /** Set the fallback chain for a capability at tenant or campaign level (PAL-04/05). */
  @Put('chains')
  @Roles('ADMIN')
  async setChain(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetChainDto) {
    const all = this.pal.listProviders();
    const byCapability = { TTS: all.tts, STT: all.stt, LLM: all.llm }[dto.capability];
    const known = new Set(byCapability.map((p) => p.id));
    for (const entry of dto.chain) {
      if (!known.has(entry.providerId)) {
        throw new BadRequestException(`Provider ${entry.providerId} is not a ${dto.capability} provider`);
      }
    }
    if (dto.level === 'CAMPAIGN' && !dto.scopeId) {
      throw new BadRequestException('scopeId (campaign id) required for CAMPAIGN level');
    }

    await this.pal.setOverride({
      tenantId: user.tenantId,
      level: dto.level ?? 'TENANT',
      scopeId: dto.scopeId,
      capability: dto.capability,
      llmRole: dto.llmRole,
      chain: dto.chain,
    });
    await this.audit.record({
      tenantId: user.tenantId,
      actorId: user.userId,
      actorLabel: user.email,
      action: 'provider.chain_set',
      entityType: 'ProviderOverride',
      after: { capability: dto.capability, llmRole: dto.llmRole, level: dto.level ?? 'TENANT', chain: dto.chain },
    });
    return { ok: true };
  }

  /** Voice picker for a TTS provider using the tenant's stored credentials (PAL-06). */
  @Get(':id/voices')
  @Roles('ADMIN')
  voices(@CurrentUser() user: AuthenticatedUser, @Param('id') providerId: string) {
    return this.pal.listVoices(user.tenantId, providerId);
  }
}
