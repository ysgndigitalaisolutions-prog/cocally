import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * Immutable audit log per ADM-02: every configuration change written with
 * actor, before/after, timestamp. Documents are never updated or deleted;
 * the service layer only inserts.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class AuditLog {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  actorId?: Types.ObjectId;

  @Prop({ required: true })
  actorLabel: string;

  /** e.g. "flow.publish", "provider.swap", "suppression.add", "retry.update". */
  @Prop({ required: true, index: true })
  action: string;

  /** Entity collection + id the change applies to. */
  @Prop({ required: true })
  entityType: string;

  @Prop()
  entityId?: string;

  @Prop({ type: Object })
  before?: Record<string, unknown>;

  @Prop({ type: Object })
  after?: Record<string, unknown>;

  @Prop()
  ip?: string;
}

export type AuditLogDocument = HydratedDocument<AuditLog>;
export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
AuditLogSchema.index({ tenantId: 1, createdAt: -1 });
