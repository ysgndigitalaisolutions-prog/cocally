import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { LEAD_STATES, type LeadState } from '@cocally/shared';
import { HydratedDocument, Types } from 'mongoose';

@Schema({ timestamps: true })
export class LeadList {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Client', required: true })
  clientId: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  /** Lists attach to campaigns with priority per LEAD-03. */
  @Prop({ type: Types.ObjectId, ref: 'Campaign', index: true })
  campaignId?: Types.ObjectId;

  @Prop({ default: 0 })
  priority: number;

  @Prop({ type: String, enum: ['ACTIVE', 'PAUSED', 'RECYCLED'], default: 'ACTIVE' })
  status: 'ACTIVE' | 'PAUSED' | 'RECYCLED';
}

export type LeadListDocument = HydratedDocument<LeadList>;
export const LeadListSchema = SchemaFactory.createForClass(LeadList);

export interface TimelineEntry {
  at: Date;
  kind: string;
  detail: string;
  state?: LeadState;
  callId?: string;
}

@Schema({ timestamps: true })
export class Lead {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Client', required: true, index: true })
  clientId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'LeadList', required: true, index: true })
  listId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Campaign', index: true })
  campaignId?: Types.ObjectId;

  /** E.164 per LEAD-01, e.g. +61412345678. */
  @Prop({ required: true, index: true })
  phone: string;

  @Prop({ type: String, enum: ['MOBILE', 'LANDLINE', 'UNKNOWN'], default: 'UNKNOWN' })
  lineType: 'MOBILE' | 'LANDLINE' | 'UNKNOWN';

  @Prop()
  firstName?: string;

  @Prop()
  lastName?: string;

  @Prop()
  suburb?: string;

  @Prop()
  state?: string;

  @Prop()
  postcode?: string;

  /** IANA timezone inferred per LEAD-06. */
  @Prop({ required: true })
  timezone: string;

  /** Arbitrary custom columns from import. */
  @Prop({ type: Object, default: {} })
  custom: Record<string, string>;

  @Prop({ type: String, enum: LEAD_STATES, default: 'FRESH', index: true })
  state_: LeadState;

  @Prop({ default: 0 })
  attempts: number;

  /** When the lead becomes dialable again (retry matrix / calling windows). */
  @Prop({ index: true })
  nextAttemptAt?: Date;

  /** Set while the dialer owns this lead, to prevent double-dialling. */
  @Prop()
  lockedAt?: Date;

  /** Structured qualification facts per AI-06. */
  @Prop({ type: Object, default: {} })
  facts: Record<string, unknown>;

  @Prop({ default: 0 })
  score: number;

  /** Last DNC wash per LEAD-05. */
  @Prop()
  dncWashedAt?: Date;

  @Prop({ default: false })
  dncListed: boolean;

  /** Last time this phone was contacted on ANY campaign (frequency cap). */
  @Prop()
  lastContactedAt?: Date;

  /** Sticky agent for callbacks per XFER-01/LEAD-08. */
  @Prop({ type: Types.ObjectId, ref: 'User' })
  preferredAgentId?: Types.ObjectId;

  @Prop({ type: [Object], default: [] })
  timeline: TimelineEntry[];
}

export type LeadDocument = HydratedDocument<Lead>;
export const LeadSchema = SchemaFactory.createForClass(Lead);
// Dedup on import and cross-list per LEAD-02.
LeadSchema.index({ tenantId: 1, campaignId: 1, phone: 1 });
LeadSchema.index({ tenantId: 1, phone: 1 });
// Dialer scan: dialable leads by campaign.
LeadSchema.index({ campaignId: 1, state_: 1, nextAttemptAt: 1 });

@Schema({ timestamps: true })
export class LeadImport {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'LeadList', required: true })
  listId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  uploadedBy?: Types.ObjectId;

  @Prop({ required: true })
  filename: string;

  @Prop({ default: 0 })
  total: number;

  @Prop({ default: 0 })
  accepted: number;

  @Prop({ default: 0 })
  duplicates: number;

  @Prop({ default: 0 })
  rejected: number;

  /** Rejects report per LEAD-01. */
  @Prop({ type: [Object], default: [] })
  rejects: Array<{ row: number; reason: string; raw: Record<string, string> }>;
}

export type LeadImportDocument = HydratedDocument<LeadImport>;
export const LeadImportSchema = SchemaFactory.createForClass(LeadImport);
