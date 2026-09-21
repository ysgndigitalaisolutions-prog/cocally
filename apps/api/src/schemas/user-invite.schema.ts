import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export const INVITE_PURPOSES = ['INVITE', 'RESET'] as const;
export type InvitePurpose = (typeof INVITE_PURPOSES)[number];

/**
 * Single-use, time-limited link that lets a user set their own password.
 * Only the SHA-256 of the token is stored; the raw token is returned once to
 * the admin who created it and never persisted. INVITE is first-time
 * onboarding, RESET is an admin-issued password reset. Both are consumed by
 * the same public endpoint.
 */
@Schema({ timestamps: true })
export class UserInvite {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ required: true, unique: true })
  tokenHash: string;

  @Prop({ type: String, enum: INVITE_PURPOSES, required: true })
  purpose: InvitePurpose;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop()
  usedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdBy?: Types.ObjectId;
}

export type UserInviteDocument = HydratedDocument<UserInvite>;
export const UserInviteSchema = SchemaFactory.createForClass(UserInvite);
