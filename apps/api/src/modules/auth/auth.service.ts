import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { authenticator } from 'otplib';
import { config } from '../../common/config';
import { TWO_FACTOR_REQUIRED_ROLES } from '../../common/auth/jwt-auth.guard';
import { User, UserDocument } from '../../schemas/user.schema';
import { UserInvite, UserInviteDocument, type InvitePurpose } from '../../schemas/user-invite.schema';
import { AuditService } from '../audit/audit.service';
import { UserStateService } from '../../common/auth/user-state.service';
import { normalizePhone } from '../leads/phone.util';

export interface LoginResult {
  token?: string;
  requires2fa: boolean;
  user?: SessionProfile;
}

export interface SessionProfile {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  roles: string[];
  totpEnabled: boolean;
  /** True when the role requires TOTP and it is not yet enrolled: the client must go to setup. */
  twoFactorSetupRequired: boolean;
}

export interface RequestContext {
  ip?: string;
  userAgent?: string;
}

export const PASSWORD_MIN_LENGTH = 12;
const INVITE_TTL_HOURS = 48;

/** Default region for bare national numbers ("0412 000 104"); E.164 input is region-independent. */
const PHONE_REGION = 'AU';

export function normalizeLoginPhone(raw: string): string | null {
  const r = normalizePhone(raw, PHONE_REGION);
  return r.ok ? r.value.e164 : null;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(UserInvite.name) private readonly inviteModel: Model<UserInviteDocument>,
    private readonly jwtService: JwtService,
    private readonly audit: AuditService,
    private readonly userState: UserStateService,
  ) {}

  // ---------------------------------------------------------------- login

  /**
   * Identifier is a phone number (any national or E.164 spelling) or, for
   * legacy and demo accounts, an email/username. Failures are audited with the
   * identifier and IP but never distinguish "no such user" from "wrong
   * password" to the caller.
   */
  async login(identifier: string, password: string, totpCode: string | undefined, ctx: RequestContext): Promise<LoginResult> {
    const user = await this.findByIdentifier(identifier);
    const fail = async (reason: string, tenantId?: string, userId?: string) => {
      if (tenantId) {
        await this.audit.record({
          tenantId,
          actorId: userId,
          actorLabel: identifier,
          action: 'auth.login_failed',
          entityType: 'User',
          entityId: userId,
          after: { reason, userAgent: ctx.userAgent },
          ip: ctx.ip,
        });
      }
      throw new UnauthorizedException('Invalid credentials');
    };

    if (!user || !user.active) return fail('unknown_or_inactive');
    if (!user.passwordHash) return fail('password_not_set', user.tenantId.toString(), user._id.toString());

    const valid = await argon2.verify(user.passwordHash, password).catch(() => false);
    if (!valid) return fail('bad_password', user.tenantId.toString(), user._id.toString());

    if (user.totpEnabled) {
      if (!totpCode) return { requires2fa: true };
      if (!user.totpSecret || !authenticator.check(totpCode, user.totpSecret)) {
        return fail('bad_totp', user.tenantId.toString(), user._id.toString());
      }
    }

    await this.userModel
      .updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date(), lastLoginIp: ctx.ip } })
      .exec();
    await this.audit.record({
      tenantId: user.tenantId.toString(),
      actorId: user._id.toString(),
      actorLabel: this.label(user),
      action: 'auth.login',
      entityType: 'User',
      entityId: user._id.toString(),
      after: { totp: user.totpEnabled, userAgent: ctx.userAgent },
      ip: ctx.ip,
    });
    return this.issueToken(user);
  }

  async profile(userId: string): Promise<SessionProfile> {
    const user = await this.userModel.findById(userId).lean().exec();
    if (!user) throw new UnauthorizedException();
    return this.toProfile(user);
  }

  // ------------------------------------------------------ invites / resets

  /**
   * Creates a single-use link for the user to set a password. Any earlier
   * unused link for the same user is voided. Returns the URL exactly once.
   */
  async createInvite(
    tenantId: string,
    userId: string,
    purpose: InvitePurpose,
    actor: { id?: string; label: string },
  ): Promise<{ url: string; expiresAt: Date }> {
    const user = await this.userModel.findOne({ _id: new Types.ObjectId(userId), tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!user) throw new NotFoundException('User not found');
    if (!user.active) throw new BadRequestException('User is deactivated');

    const raw = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3600_000);
    await this.inviteModel.updateMany({ userId: user._id, usedAt: { $exists: false } }, { $set: { usedAt: new Date() } }).exec();
    await this.inviteModel.create({
      tenantId: user.tenantId,
      userId: user._id,
      tokenHash: this.hashToken(raw),
      purpose,
      expiresAt,
      createdBy: actor.id ? new Types.ObjectId(actor.id) : undefined,
    });
    await this.audit.record({
      tenantId,
      actorId: actor.id,
      actorLabel: actor.label,
      action: purpose === 'INVITE' ? 'user.invite_created' : 'user.reset_link_created',
      entityType: 'User',
      entityId: userId,
      after: { expiresAt: expiresAt.toISOString() },
    });
    return { url: `${this.webBaseUrl()}/invite/${raw}`, expiresAt };
  }

  /** Public: exchanges an invite/reset token for a newly set password. */
  async acceptInvite(rawToken: string, password: string, ctx: RequestContext): Promise<{ ok: true; identifier: string }> {
    this.assertPasswordPolicy(password);
    const invite = await this.inviteModel.findOne({ tokenHash: this.hashToken(rawToken) }).exec();
    if (!invite || invite.usedAt || invite.expiresAt < new Date()) {
      throw new BadRequestException('This link is invalid or has expired. Ask your administrator for a new one.');
    }
    const user = await this.userModel.findById(invite.userId).exec();
    if (!user || !user.active) throw new BadRequestException('This account is not available.');

    invite.usedAt = new Date();
    await invite.save();
    await this.userModel
      .updateOne(
        { _id: user._id },
        { $set: { passwordHash: await this.hashPassword(password), passwordSetAt: new Date() }, $inc: { tokenVersion: 1 } },
      )
      .exec();
    this.userState.invalidate(user._id.toString());
    await this.audit.record({
      tenantId: user.tenantId.toString(),
      actorId: user._id.toString(),
      actorLabel: this.label(user),
      action: invite.purpose === 'INVITE' ? 'auth.invite_accepted' : 'auth.password_reset',
      entityType: 'User',
      entityId: user._id.toString(),
      ip: ctx.ip,
    });
    return { ok: true, identifier: user.phone ?? user.email ?? '' };
  }

  /** Describes an invite for the acceptance page without consuming it. */
  async inspectInvite(rawToken: string): Promise<{ name: string; identifier: string; purpose: InvitePurpose }> {
    const invite = await this.inviteModel.findOne({ tokenHash: this.hashToken(rawToken) }).lean().exec();
    if (!invite || invite.usedAt || invite.expiresAt < new Date()) throw new NotFoundException('Link is invalid or expired');
    const user = await this.userModel.findById(invite.userId).lean().exec();
    if (!user || !user.active) throw new NotFoundException('Link is invalid or expired');
    return { name: user.name, identifier: user.phone ?? user.email ?? '', purpose: invite.purpose };
  }

  // ---------------------------------------------------------- password

  /** Self-service change. Signs out every other session by bumping tokenVersion, then returns a fresh token. */
  async changePassword(userId: string, currentPassword: string, newPassword: string, ctx: RequestContext): Promise<LoginResult> {
    this.assertPasswordPolicy(newPassword);
    const user = await this.userModel.findById(userId).select('+passwordHash').exec();
    if (!user?.passwordHash) throw new UnauthorizedException();
    const valid = await argon2.verify(user.passwordHash, currentPassword).catch(() => false);
    if (!valid) throw new UnauthorizedException('Current password is incorrect');
    if (currentPassword === newPassword) throw new BadRequestException('New password must differ from the current one');

    const updated = await this.userModel
      .findOneAndUpdate(
        { _id: user._id },
        { $set: { passwordHash: await this.hashPassword(newPassword), passwordSetAt: new Date() }, $inc: { tokenVersion: 1 } },
        { new: true },
      )
      .exec();
    if (!updated) throw new UnauthorizedException();
    this.userState.invalidate(userId);
    await this.audit.record({
      tenantId: user.tenantId.toString(),
      actorId: userId,
      actorLabel: this.label(user),
      action: 'auth.password_changed',
      entityType: 'User',
      entityId: userId,
      ip: ctx.ip,
    });
    return this.issueToken(updated);
  }

  // --------------------------------------------------------------- TOTP

  /** Begin TOTP enrolment: returns the otpauth URL for an authenticator app. */
  async setup2fa(userId: string): Promise<{ otpauthUrl: string; secret: string }> {
    const user = await this.userModel.findById(userId).exec();
    if (!user) throw new UnauthorizedException();
    if (user.totpEnabled) throw new BadRequestException('Two-factor authentication is already enabled');
    const secret = authenticator.generateSecret();
    await this.userModel.updateOne({ _id: userId }, { totpSecret: secret, totpEnabled: false }).exec();
    return { otpauthUrl: authenticator.keyuri(this.label(user), 'CoCally', secret), secret };
  }

  async confirm2fa(userId: string, code: string, ctx: RequestContext): Promise<{ enabled: boolean }> {
    const user = await this.userModel.findById(userId).select('+totpSecret').exec();
    if (!user?.totpSecret || !authenticator.check(code, user.totpSecret)) {
      throw new UnauthorizedException('Invalid 2FA code');
    }
    await this.userModel.updateOne({ _id: userId }, { totpEnabled: true }).exec();
    this.userState.invalidate(userId);
    await this.audit.record({
      tenantId: user.tenantId.toString(),
      actorId: userId,
      actorLabel: this.label(user),
      action: 'auth.2fa_enabled',
      entityType: 'User',
      entityId: userId,
      ip: ctx.ip,
    });
    return { enabled: true };
  }

  /** Admin-side: clears a lost authenticator so the user can re-enrol on next login. */
  async reset2fa(tenantId: string, userId: string, actor: { id: string; label: string }): Promise<void> {
    const res = await this.userModel
      .updateOne(
        { _id: new Types.ObjectId(userId), tenantId: new Types.ObjectId(tenantId) },
        { $set: { totpEnabled: false }, $unset: { totpSecret: 1 }, $inc: { tokenVersion: 1 } },
      )
      .exec();
    if (res.matchedCount === 0) throw new NotFoundException('User not found');
    this.userState.invalidate(userId);
    await this.audit.record({
      tenantId,
      actorId: actor.id,
      actorLabel: actor.label,
      action: 'user.2fa_reset',
      entityType: 'User',
      entityId: userId,
    });
  }

  // ------------------------------------------------------------ helpers

  async hashPassword(password: string): Promise<string> {
    return argon2.hash(password);
  }

  assertPasswordPolicy(password: string): void {
    if (password.length < PASSWORD_MIN_LENGTH) {
      throw new BadRequestException(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
    }
    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      throw new BadRequestException('Password must contain both letters and numbers');
    }
  }

  private async findByIdentifier(identifier: string): Promise<UserDocument | null> {
    const trimmed = identifier.trim();
    const select = '+passwordHash +totpSecret';
    const phone = normalizeLoginPhone(trimmed);
    if (phone) {
      const byPhone = await this.userModel.findOne({ phone }).select(select).exec();
      if (byPhone) return byPhone;
    }
    return this.userModel.findOne({ email: trimmed.toLowerCase() }).select(select).exec();
  }

  private async issueToken(user: UserDocument): Promise<LoginResult> {
    const token = await this.jwtService.signAsync({
      sub: user._id.toString(),
      tenantId: user.tenantId.toString(),
      email: this.label(user),
      roles: user.roles,
      tv: user.tokenVersion ?? 0,
    });
    return { token, requires2fa: false, user: this.toProfile(user) };
  }

  private toProfile(user: Pick<User, 'name' | 'email' | 'phone' | 'roles' | 'totpEnabled'> & { _id: Types.ObjectId }): SessionProfile {
    const requires = user.roles.some((r) => TWO_FACTOR_REQUIRED_ROLES.includes(r));
    return {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      phone: user.phone,
      roles: user.roles,
      totpEnabled: user.totpEnabled,
      twoFactorSetupRequired: requires && !user.totpEnabled,
    };
  }

  private label(user: Pick<User, 'email' | 'phone'>): string {
    return user.phone ?? user.email ?? 'unknown';
  }

  private hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  private webBaseUrl(): string {
    return (config.corsOrigins[0] ?? 'http://localhost:3000').replace(/\/$/, '');
  }
}
