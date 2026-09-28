import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * A CoCally staff account for the ops console. Deliberately NOT a User: it
 * belongs to no tenant, cannot be seen or changed by any tenant admin, and its
 * tokens are signed with a different key, so a tenant session can never reach
 * ops routes and an ops session can never act as a tenant user.
 */
@Schema({ timestamps: true })
export class Operator {
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop({ required: true })
  name: string;

  @Prop({ select: false })
  passwordHash?: string;

  @Prop({ select: false })
  totpSecret?: string;

  /** Always required before any ops route works; enrolment happens at first sign-in. */
  @Prop({ default: false })
  totpEnabled: boolean;

  @Prop({ default: true })
  active: boolean;

  /** Bumped to sign out every session (password change, deactivation, 2FA reset). */
  @Prop({ default: 0 })
  tokenVersion: number;

  /** One-time set-password link (sha256 of the raw token), for invites and resets. */
  @Prop({ select: false })
  inviteTokenHash?: string;

  @Prop()
  inviteExpiresAt?: Date;

  @Prop()
  lastLoginAt?: Date;

  @Prop()
  lastLoginIp?: string;
}

export type OperatorDocument = HydratedDocument<Operator>;
export const OperatorSchema = SchemaFactory.createForClass(Operator);

/**
 * Everything an operator does, across tenants, in one place. Tenant-affecting
 * actions are ALSO written to that tenant's own audit log, so the tenant can
 * see what CoCally changed on their account.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class OpsAuditLog {
  @Prop({ required: true })
  operatorId: string;

  @Prop({ required: true })
  operatorEmail: string;

  @Prop({ required: true, index: true })
  action: string;

  @Prop({ index: true })
  tenantId?: string;

  @Prop()
  entityType?: string;

  @Prop()
  entityId?: string;

  @Prop({ type: Object })
  before?: Record<string, unknown>;

  @Prop({ type: Object })
  after?: Record<string, unknown>;

  @Prop()
  ip?: string;
}

export type OpsAuditLogDocument = HydratedDocument<OpsAuditLog>;
export const OpsAuditLogSchema = SchemaFactory.createForClass(OpsAuditLog);
OpsAuditLogSchema.index({ createdAt: -1 });
