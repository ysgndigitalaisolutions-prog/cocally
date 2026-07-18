import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * Suppression stack per LEAD-05, evaluated at dial time in order:
 * 1. country DNC register wash, 2. tenant opt-out list, 3. cross-campaign
 * frequency caps, 4. per-client suppression.
 */
@Schema({ timestamps: true })
export class SuppressionEntry {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  /** Absent = tenant-wide opt-out; present = per-client suppression. */
  @Prop({ type: Types.ObjectId, ref: 'Client', index: true })
  clientId?: Types.ObjectId;

  /** E.164. */
  @Prop({ required: true })
  phone: string;

  @Prop({ type: String, enum: ['OPT_OUT', 'CLIENT_SUPPRESSION', 'MANUAL'], required: true })
  kind: 'OPT_OUT' | 'CLIENT_SUPPRESSION' | 'MANUAL';

  /** e.g. "customer said do-not-call mid-call", call id, importer. */
  @Prop({ required: true })
  source: string;

  /** Optional expiry; opt-outs are permanent (no expiry). */
  @Prop()
  expiresAt?: Date;
}

export type SuppressionEntryDocument = HydratedDocument<SuppressionEntry>;
export const SuppressionEntrySchema = SchemaFactory.createForClass(SuppressionEntry);
SuppressionEntrySchema.index({ tenantId: 1, phone: 1, kind: 1 });

/** DNC registry wash results per pack (AU: ACMA, 30-day expiry). */
@Schema({ timestamps: true })
export class DncWashRecord {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ required: true })
  countryPackCode: string;

  @Prop({ required: true })
  phone: string;

  @Prop({ required: true })
  listed: boolean;

  @Prop({ required: true })
  washedAt: Date;

  @Prop({ required: true })
  expiresAt: Date;
}

export type DncWashRecordDocument = HydratedDocument<DncWashRecord>;
export const DncWashRecordSchema = SchemaFactory.createForClass(DncWashRecord);
DncWashRecordSchema.index({ tenantId: 1, phone: 1, countryPackCode: 1 }, { unique: true });
