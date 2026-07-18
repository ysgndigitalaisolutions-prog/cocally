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
