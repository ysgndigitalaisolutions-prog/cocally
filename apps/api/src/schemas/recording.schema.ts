import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { CALL_LEGS, type CallLeg } from '@cocally/shared';
import { HydratedDocument, Types } from 'mongoose';

/**
 * Dual-leg recording per REC-01: AI leg and human leg captured and stitched
 * into one continuous per-lead timeline with the whisper marked.
 */
@Schema({ timestamps: true })
export class Recording {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Call', required: true, index: true })
  callId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Lead', required: true, index: true })
  leadId: Types.ObjectId;

  @Prop({ type: String, enum: CALL_LEGS, required: true })
  leg: CallLeg;

  /** Storage path within the tenant's region-pinned bucket per REC-02. */
  @Prop({ required: true })
  storagePath: string;

  /** Region the object lives in; must equal tenant region per REC-02. */
  @Prop({ required: true })
  region: string;

  @Prop({ required: true })
  startedAt: Date;

  @Prop()
  endedAt?: Date;

  @Prop({ default: 0 })
  durationMs: number;

  /** Offset of this leg within the stitched per-lead timeline. */
  @Prop({ default: 0 })
  timelineOffsetMs: number;

  /** Legal hold overrides retention purge per REC-03. */
  @Prop({ default: false })
  legalHold: boolean;

  /** When the retention job may purge this object. */
  @Prop()
  purgeAfter?: Date;
}

export type RecordingDocument = HydratedDocument<Recording>;
export const RecordingSchema = SchemaFactory.createForClass(Recording);
