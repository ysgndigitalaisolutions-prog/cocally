import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { LLM_ROLES, PROVIDER_CAPABILITIES, type LlmRole, type ProviderCapability } from '@cocally/shared';
import { HydratedDocument, Types } from 'mongoose';

/**
 * PAL configuration per PAL-04: hierarchy platform default → tenant →
 * country pack → campaign → flow node. Each level stores an override
 * document; resolution walks most-specific-first.
 */
@Schema({ timestamps: true })
export class ProviderOverride {
  /** Null for the platform-default level. */
  @Prop({ type: Types.ObjectId, ref: 'Tenant', index: true })
  tenantId?: Types.ObjectId;

  @Prop({ type: String, enum: ['PLATFORM', 'TENANT', 'COUNTRY_PACK', 'CAMPAIGN'], required: true })
  level: 'PLATFORM' | 'TENANT' | 'COUNTRY_PACK' | 'CAMPAIGN';

  /** CountryPack code / campaign id, depending on level. */
  @Prop()
  scopeId?: string;

  @Prop({ type: String, enum: PROVIDER_CAPABILITIES, required: true })
  capability: ProviderCapability;

  /** For LLM capability: which role this override applies to (PAL-03). */
  @Prop({ type: String, enum: LLM_ROLES })
  llmRole?: LlmRole;

  /** Ordered provider chain: first is primary, rest are fallbacks (PAL-05). */
  @Prop({ type: [Object], required: true })
  chain: Array<{
    providerId: string;
    model?: string;
    voiceId?: string;
    params?: Record<string, unknown>;
  }>;
}

export type ProviderOverrideDocument = HydratedDocument<ProviderOverride>;
export const ProviderOverrideSchema = SchemaFactory.createForClass(ProviderOverride);
ProviderOverrideSchema.index({ level: 1, tenantId: 1, scopeId: 1, capability: 1, llmRole: 1 });

/** Encrypted provider API keys per PAL-12 (AES-256-GCM via the vault service). */
@Schema({ timestamps: true })
export class ProviderSecret {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ required: true })
  providerId: string;

  @Prop({ required: true, select: false })
  ciphertext: string;

  @Prop({ required: true, select: false })
  iv: string;

  @Prop({ required: true, select: false })
  authTag: string;
}

export type ProviderSecretDocument = HydratedDocument<ProviderSecret>;
export const ProviderSecretSchema = SchemaFactory.createForClass(ProviderSecret);
ProviderSecretSchema.index({ tenantId: 1, providerId: 1 }, { unique: true });

/** Voice/pronunciation configuration per PAL-06, scoped per campaign+locale. */
@Schema({ timestamps: true })
export class PronunciationLexicon {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Campaign', index: true })
  campaignId?: Types.ObjectId;

  @Prop({ required: true })
  locale: string;

  /** term → phonetic/replacement, e.g. "Woolloomooloo" → "wool-uh-muh-loo". */
  @Prop({ type: Object, default: {} })
  entries: Record<string, string>;
}

export type PronunciationLexiconDocument = HydratedDocument<PronunciationLexicon>;
export const PronunciationLexiconSchema = SchemaFactory.createForClass(PronunciationLexicon);
