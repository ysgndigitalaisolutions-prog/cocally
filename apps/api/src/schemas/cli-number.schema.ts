import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/** CLI (caller ID) numbers with health tracking per TEL-07. */
@Schema({ timestamps: true })
export class CliNumber {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  /** E.164. */
  @Prop({ required: true })
  number: string;

  /** Geo region the number belongs to (e.g. "VIC" for 03), for geo-matching. */
  @Prop()
  geoRegion?: string;

  @Prop({ required: true })
  countryPackCode: string;

  @Prop({ type: String, enum: ['ACTIVE', 'RESTING', 'QUARANTINED'], default: 'ACTIVE' })
  status: 'ACTIVE' | 'RESTING' | 'QUARANTINED';

  /** Rolling answer-rate health; automatic rest on spam-flag suspicion. */
  @Prop({ default: 0 })
  dialsToday: number;

  @Prop({ default: 0 })
  answersToday: number;

  @Prop({ default: 1 })
  answerRate7d: number;

  @Prop()
  restingUntil?: Date;

  /** STIR/SHAKEN attestation level where required. */
  @Prop()
  attestation?: string;
}

export type CliNumberDocument = HydratedDocument<CliNumber>;
export const CliNumberSchema = SchemaFactory.createForClass(CliNumber);
CliNumberSchema.index({ tenantId: 1, number: 1 }, { unique: true });
