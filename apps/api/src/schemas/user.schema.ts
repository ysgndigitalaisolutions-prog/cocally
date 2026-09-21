import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { PAUSE_CODES, PRESENCE_STATES, ROLES, type PauseCode, type PresenceState, type Role } from '@cocally/shared';
import { HydratedDocument, Types } from 'mongoose';

@Schema({ timestamps: true })
export class User {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  /**
   * Login identifier: the user's mobile in E.164 (e.g. +61412000104). Required
   * for every account created through the invite flow; legacy/seeded accounts
   * may carry only an email.
   */
  @Prop({ trim: true })
  phone?: string;

  /** Contact address, also accepted as a login identifier for legacy accounts. */
  @Prop({ lowercase: true, trim: true })
  email?: string;

  @Prop({ required: true })
  name: string;

  /**
   * argon2 hash. Absent until the user accepts their invite and sets a
   * password, during which time login is refused.
   */
  @Prop({ select: false })
  passwordHash?: string;

  @Prop()
  passwordSetAt?: Date;

  /**
   * Bumped on password change, invite acceptance and deactivation. Every JWT
   * carries the version it was minted with; a mismatch rejects the token, so
   * "sign out everywhere" and "deactivate now" take effect immediately instead
   * of at JWT expiry.
   */
  @Prop({ default: 0 })
  tokenVersion: number;

  @Prop()
  lastLoginAt?: Date;

  @Prop()
  lastLoginIp?: string;

  @Prop({ type: [String], enum: ROLES, required: true })
  roles: Role[];

  /** TOTP 2FA per WS-01 / NFR security. */
  @Prop({ select: false })
  totpSecret?: string;

  @Prop({ default: false })
  totpEnabled: boolean;

  /** Agent skills for transfer eligibility per XFER-01: campaign ids + language tags. */
  @Prop({ type: [String], default: [] })
  skills: string[];

  @Prop({ type: [String], default: ['en'] })
  languages: string[];

  @Prop({ type: String, enum: PRESENCE_STATES, default: 'OFFLINE' })
  presence: PresenceState;

  /** Set when presence last became AVAILABLE — drives longest-idle routing. */
  @Prop()
  availableSince?: Date;

  /**
   * Last client heartbeat. A staffed presence with no recent heartbeat means
   * the agent closed the tab or lost the network, so the presence sweep signs
   * them out — otherwise a ghost agent keeps attracting dials and transfers.
   */
  @Prop()
  lastSeenAt?: Date;

  /** Cumulative talk-time today (seconds) — drives least-talk-time routing. */
  @Prop({ default: 0 })
  talkTimeTodaySeconds: number;

  /**
   * Reason attached to the current BREAK presence.
   *
   * A single undifferentiated BREAK state makes adherence reporting
   * impossible — a supervisor cannot separate a paid coaching session from
   * an unpaid lunch, and payroll has no source record. Set whenever presence
   * becomes BREAK; cleared on every other transition.
   */
  @Prop({ type: String, enum: PAUSE_CODES })
  pauseCode?: PauseCode;

  @Prop()
  pausedSince?: Date;

  /** Shift clock-on. Null when the agent is off the clock. */
  @Prop()
  clockedInAt?: Date;

  /** Optional IP allowlist for admin access per ADM-01. */
  @Prop({ type: [String], default: [] })
  adminIpAllowlist: string[];

  @Prop({ default: true })
  active: boolean;
}

export type UserDocument = HydratedDocument<User>;
export const UserSchema = SchemaFactory.createForClass(User);
UserSchema.index(
  { tenantId: 1, email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } }, name: 'tenant_email_unique' },
);
UserSchema.index(
  { tenantId: 1, phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: 'string' } }, name: 'tenant_phone_unique' },
);
UserSchema.index({ tenantId: 1, presence: 1 });
