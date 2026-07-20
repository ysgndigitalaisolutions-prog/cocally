import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { PRESENCE_STATES, ROLES, type PresenceState, type Role } from '@cocally/shared';
import { HydratedDocument, Types } from 'mongoose';

@Schema({ timestamps: true })
export class User {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ required: true, lowercase: true, trim: true })
  email: string;

  @Prop({ required: true })
  name: string;

  /** argon2 hash. */
  @Prop({ required: true, select: false })
  passwordHash: string;

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

  /** Optional IP allowlist for admin access per ADM-01. */
  @Prop({ type: [String], default: [] })
  adminIpAllowlist: string[];

  @Prop({ default: true })
  active: boolean;
}

export type UserDocument = HydratedDocument<User>;
export const UserSchema = SchemaFactory.createForClass(User);
UserSchema.index({ tenantId: 1, email: 1 }, { unique: true });
UserSchema.index({ tenantId: 1, presence: 1 });
