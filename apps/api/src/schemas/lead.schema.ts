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

  /**
   * Secondary numbers (work/home/partner). Dialed only after the primary
   * exhausts; each is E.164-normalised at import like `phone`.
   */
  @Prop({ type: [String], default: [] })
  altPhones: string[];

  @Prop()
  email?: string;

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

  /** Provenance: where this lead came from (list vendor, web form, UTM…). */
  @Prop()
  source?: string;

  /** Free-form segmentation labels, settable in bulk from the leads screen. */
  @Prop({ type: [String], default: [] })
  tags: string[];

  /**
   * Lead OWNERSHIP — the agent this lead belongs to in a human-dialer floor.
   *
   * This is deliberately distinct from `manualClaimedBy` (a transient, one-call
   * lock) and `preferredAgentId` (callback stickiness). Ownership is what makes
   * a 15-seat floor work: each agent's worklist is partitioned by `ownerId`, so
   * two agents never see — and never race for — the same record.
   *
   * Unowned (null) leads form the shared pool the assignment engine draws from.
   */
  @Prop({ type: Types.ObjectId, ref: 'User', index: true })
  ownerId?: Types.ObjectId;

  @Prop()
  assignedAt?: Date;

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

  /**
   * Set when a human agent claims this lead for MANUAL dialing. While set, the
   * automatic dialer skips the lead entirely — the human owns it, so the AI
   * "will not dial to them" (the guarantee against manual/auto double-dialing).
   * Cleared on disposition or explicit release.
   */
  @Prop({ type: Types.ObjectId, ref: 'User' })
  manualClaimedBy?: Types.ObjectId;

  @Prop()
  manualClaimedAt?: Date;

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

/** Keep the newest N timeline entries on the doc; older history lives in LeadNote/calls. */
export const TIMELINE_CAP = 300;

/**
 * The embedded timeline is append-only at every call site, so a heavily
 * redialled lead would grow without bound and eventually approach the 16 MB
 * BSON ceiling — while inflating every read of a hot document. Cap centrally
 * rather than at the ~10 push sites.
 */
LeadSchema.pre('save', function capTimeline(next) {
  const doc = this as unknown as LeadDocument;
  if (Array.isArray(doc.timeline) && doc.timeline.length > TIMELINE_CAP) {
    doc.timeline = doc.timeline.slice(-TIMELINE_CAP);
  }
  next();
});

// Dedup on import and cross-list per LEAD-02.
LeadSchema.index({ tenantId: 1, campaignId: 1, phone: 1 });
LeadSchema.index({ tenantId: 1, phone: 1 });
// Dialer scan: dialable leads by campaign. `manualClaimedBy` is in the dialer's
// filter, so include it to keep the scan covered at 100k+ leads.
LeadSchema.index({ campaignId: 1, state_: 1, nextAttemptAt: 1, manualClaimedBy: 1 });
// Per-agent manual worklist: partitioned by owner, ordered by score.
LeadSchema.index({ tenantId: 1, ownerId: 1, state_: 1, score: -1 });
// Unowned pool the assignment engine draws from.
LeadSchema.index({ tenantId: 1, campaignId: 1, ownerId: 1, state_: 1 });
// Frequency-cap lookup (suppression) — was an unindexed hot-path query.
LeadSchema.index({ tenantId: 1, phone: 1, lastContactedAt: -1 });
// Leads screen default sort, and callback due-sweeps.
LeadSchema.index({ tenantId: 1, campaignId: 1, updatedAt: -1 });
// Free-text search over name/phone/email from the leads screen.
LeadSchema.index({ tenantId: 1, tags: 1 });

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

/**
 * Free-text notes against a lead, independent of any call.
 *
 * Its own collection rather than an embedded array: notes are unbounded over a
 * lead's life, are read on their own (the lead detail drawer), and must survive
 * the timeline cap. Append-only by convention — edits rewrite `text` and stamp
 * `editedAt` so the trail stays auditable.
 */
@Schema({ timestamps: true })
export class LeadNote {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Lead', required: true, index: true })
  leadId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  authorId: Types.ObjectId;

  @Prop({ required: true })
  authorLabel: string;

  @Prop({ required: true })
  text: string;

  /** Set when a note is pinned to the top of the lead drawer. */
  @Prop({ default: false })
  pinned: boolean;

  @Prop()
  editedAt?: Date;
}

export type LeadNoteDocument = HydratedDocument<LeadNote>;
export const LeadNoteSchema = SchemaFactory.createForClass(LeadNote);
LeadNoteSchema.index({ tenantId: 1, leadId: 1, createdAt: -1 });
