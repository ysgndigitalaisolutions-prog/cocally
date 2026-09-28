import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * What one unit of each provider costs CoCally, in US dollars. Singleton
 * (`key: 'default'`), edited on the Platform screen. Usage is measured from the
 * calls themselves; these rates turn it into money. They are estimates from
 * published price lists — check them against the real invoices monthly.
 */
export interface RateCard {
  /** LiveKit agent session, per minute the AI is in the call. */
  livekitAgentPerMin: number;
  /** LiveKit SIP participant, per minute the phone leg exists (ringing included). */
  livekitSipPerMin: number;
  /** LiveKit WebRTC participant, per minute a human agent is on the call. */
  livekitWebrtcPerMin: number;
  /** Speech-to-text, per AI minute. */
  sttPerMin: number;
  /** Language model, per AI minute. */
  llmPerMin: number;
  /** Text-to-speech, per 1,000 characters the AI speaks. */
  ttsPer1kChars: number;
  /** Recording egress, per recorded minute. */
  recordingPerMin: number;
  /** Carrier, per connected minute. 0 when the tenant pays its own carrier. */
  telcoPerMin: number;
  /** Fixed platform cost per month (server, database, LiveKit plan). */
  fixedMonthlyUsd: number;
  /** Rupees per US dollar, for showing cost next to what tenants are billed. */
  inrPerUsd: number;
}

export const DEFAULT_RATE_CARD: RateCard = {
  livekitAgentPerMin: 0.01,
  livekitSipPerMin: 0.004,
  livekitWebrtcPerMin: 0.0005,
  sttPerMin: 0.006,
  llmPerMin: 0.005,
  ttsPer1kChars: 0.05,
  recordingPerMin: 0.005,
  telcoPerMin: 0,
  fixedMonthlyUsd: 250,
  inrPerUsd: 98,
};

@Schema({ timestamps: true })
export class PlatformSettings {
  @Prop({ required: true, unique: true, default: 'default' })
  key: string;

  @Prop({ type: Object, default: () => ({ ...DEFAULT_RATE_CARD }) })
  rateCard: RateCard;

  /** "From" block printed on every invoice. */
  @Prop({ type: Object, default: {} })
  seller: SellerDetails;

  /** Last invoice number used, per year: { "2026": 3 }. */
  @Prop({ type: Object, default: {} })
  invoiceSeq: Record<string, number>;
}

export interface SellerDetails {
  name?: string;
  address?: string;
  gstin?: string;
  email?: string;
  phone?: string;
  /** Bank / UPI details printed under the total. */
  paymentDetails?: string;
}

export const DEFAULT_SELLER: SellerDetails = {
  name: 'YSGN Digital Innovative AI Solutions',
  email: 'nithinyakateela@gmail.com',
  phone: '+91 9902352425',
};

export type PlatformSettingsDocument = HydratedDocument<PlatformSettings>;
export const PlatformSettingsSchema = SchemaFactory.createForClass(PlatformSettings);
