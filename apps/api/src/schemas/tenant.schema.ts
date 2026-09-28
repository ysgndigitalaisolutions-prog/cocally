import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/** Tenant = the call-centre operator. Multi-tenant root per PLAT-01. */
@Schema({ timestamps: true })
export class Tenant {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true, unique: true })
  slug: string;

  /** Data-residency region for recordings/transcripts per REC-02 (e.g. "au"). */
  @Prop({ required: true, default: 'au' })
  region: string;

  /** White-label settings per PLAT-02. */
  @Prop({ type: Object, default: {} })
  branding: { logoUrl?: string; primaryColor?: string; customDomain?: string };

  /** Retention defaults in days per REC-03. */
  @Prop({ default: 365 })
  retentionDays: number;

  /** Per-tenant dial quota per PLAT-08 (0 = unlimited). */
  @Prop({ default: 0 })
  dailyDialQuota: number;

  /** Kill switch per PLAT-08 / global pause per ADM-03. */
  @Prop({ default: false })
  paused: boolean;

  @Prop({ default: true })
  active: boolean;

  /**
   * AI voice for every call this tenant places. Set by CoCally on the
   * Platform screen, not by the tenant. Unset = the worker's default
   * (TTS_PROVIDER / TTS_VOICE).
   */
  @Prop({ type: Object })
  voice?: TenantVoice;

  /** What CoCally charges this tenant, in rupees. Set on the Platform screen. */
  @Prop({ type: Object })
  billing?: TenantBilling;
}

export const TTS_PROVIDERS = ['elevenlabs', 'cartesia', 'deepgram'] as const;
export type TtsProvider = (typeof TTS_PROVIDERS)[number];

export interface TenantVoice {
  provider: TtsProvider;
  /** Provider voice id (ElevenLabs voice id, Cartesia voice id, Deepgram Aura model). Blank = provider default. */
  voiceId?: string;
}

/** One price band. The band a month falls in is set by its total AI minutes and applies to ALL of that month's usage. */
export interface BillingTier {
  /** Band starts at this many AI minutes in the month (the first band is 0). */
  fromMinutes: number;
  /** ₹ per minute of live AI-to-customer conversation. */
  aiPerMinInr: number;
  /** ₹ per dialled attempt. */
  perDialInr: number;
}

/**
 * CARRY_FORWARD: unused advance stays as credit until used.
 * MONTHLY: the advance only covers its own month; what is left expires when the month's invoice is issued.
 */
export const ADVANCE_RULES = ['CARRY_FORWARD', 'MONTHLY'] as const;
export type AdvanceRule = (typeof ADVANCE_RULES)[number];

/** What CoCally charges this tenant, in rupees (before GST). Set on the Platform screen. */
export interface TenantBilling {
  tiers: BillingTier[];
  /** ₹ advance the tenant pays at the start of each month. */
  monthlyAdvanceInr: number;
  advanceRule: AdvanceRule;
  gstPercent: number;
  /** Invoice "Bill to" block. */
  billTo?: { name?: string; address?: string; gstin?: string; email?: string };
}

export type TenantDocument = HydratedDocument<Tenant>;
export const TenantSchema = SchemaFactory.createForClass(Tenant);

/** End-client of the operator (e.g. a solar retailer) per PLAT-01. */
@Schema({ timestamps: true })
export class Client {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop({ type: Object, default: {} })
  branding: { logoUrl?: string };

  @Prop({ default: true })
  active: boolean;
}

export type ClientDocument = HydratedDocument<Client>;
export const ClientSchema = SchemaFactory.createForClass(Client);
ClientSchema.index({ tenantId: 1, name: 1 }, { unique: true });
