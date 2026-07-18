import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { FLOW_VERSION_STATES, type FlowGraph, type FlowVersionState } from '@cocally/shared';
import { HydratedDocument, Types } from 'mongoose';

@Schema({ timestamps: true })
export class Flow {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop({ type: String, enum: ['OUTBOUND', 'INBOUND'], default: 'OUTBOUND' })
  direction: 'OUTBOUND' | 'INBOUND';

  /** Template library per FLOW-07. */
  @Prop({ default: false })
  isTemplate: boolean;

  @Prop()
  vertical?: string;

  @Prop()
  locale?: string;
}

export type FlowDocument = HydratedDocument<Flow>;
export const FlowSchema = SchemaFactory.createForClass(Flow);

/**
 * Immutable published versions per FLOW-04: draft → simulate → publish →
 * rollback. Published versions are never mutated; rollback re-activates a
 * prior version on the campaign.
 */
@Schema({ timestamps: true })
export class FlowVersion {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Flow', required: true, index: true })
  flowId: Types.ObjectId;

  @Prop({ required: true })
  version: number;

  @Prop({ type: String, enum: FLOW_VERSION_STATES, default: 'DRAFT' })
  state: FlowVersionState;

  @Prop({ type: Object, required: true })
  graph: FlowGraph;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  publishedBy?: Types.ObjectId;

  @Prop()
  publishedAt?: Date;

  @Prop()
  changeNote?: string;
}

export type FlowVersionDocument = HydratedDocument<FlowVersion>;
export const FlowVersionSchema = SchemaFactory.createForClass(FlowVersion);
FlowVersionSchema.index({ flowId: 1, version: 1 }, { unique: true });

/** Recorded prompt assets per FLOW-03, with per-locale variants. */
@Schema({ timestamps: true })
export class PromptAsset {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop({ type: String, enum: ['UPLOAD', 'BROWSER_RECORDING', 'TTS_FROZEN'], required: true })
  source: 'UPLOAD' | 'BROWSER_RECORDING' | 'TTS_FROZEN';

  /** locale → storage path/URL. */
  @Prop({ type: Object, default: {} })
  variants: Record<string, string>;

  /** For TTS_FROZEN: the text and voice used to synthesise. */
  @Prop({ type: Object })
  ttsSource?: { text: string; providerId: string; voiceId: string };
}

export type PromptAssetDocument = HydratedDocument<PromptAsset>;
export const PromptAssetSchema = SchemaFactory.createForClass(PromptAsset);
