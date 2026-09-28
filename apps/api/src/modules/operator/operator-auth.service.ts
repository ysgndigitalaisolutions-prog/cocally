import { BadRequestException, ConflictException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { authenticator } from 'otplib';
import { config } from '../../common/config';
import { Operator, OperatorDocument } from '../../schemas/operator.schema';
import { OPS_JWT_SECRET, OPS_TOKEN_TTL, type AuthenticatedOperator, type OpsJwtPayload } from './operator-auth.guard';
import { OpsAuditService } from './ops-audit.service';

const INVITE_TTL_HOURS = 48;
const PASSWORD_MIN_LENGTH = 12;

export interface OperatorProfile {
  id: string;
  email: string;
  name: string;
  totpEnabled: boolean;
}

export type OpsLoginResult =
  | { token: string; operator: OperatorProfile }
  | { requires2fa: true }
  | { enrolmentRequired: true; enrolToken: string; otpauthUrl: string; secret: string };

const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');

@Injectable()
export class OperatorAuthService {
  constructor(
    @InjectModel(Operator.name) private readonly model: Model<OperatorDocument>,
    private readonly jwt: JwtService,
    private readonly audit: OpsAuditService,
  ) {}

  private profile(op: { _id: Types.ObjectId; email: string; name: string; totpEnabled: boolean }): OperatorProfile {
    return { id: op._id.toString(), email: op.email, name: op.name, totpEnabled: op.totpEnabled };
  }

  private async sign(op: { _id: Types.ObjectId; tokenVersion?: number }, typ: OpsJwtPayload['typ']): Promise<string> {
    const payload: OpsJwtPayload = { sub: op._id.toString(), typ, tv: op.tokenVersion ?? 0 };
    return this.jwt.signAsync(payload, { secret: OPS_JWT_SECRET, expiresIn: typ === 'ops' ? OPS_TOKEN_TTL : '10m' });
  }

  private assertPassword(password: string): void {
    if (password.length < PASSWORD_MIN_LENGTH) throw new BadRequestException(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      throw new BadRequestException('Password must contain both letters and numbers');
    }
  }

  /**
   * Password, then TOTP. An operator without TOTP gets an enrolment token and
   * a fresh secret instead of a session — there is no way into the console
   * without an authenticator.
   */
  async login(email: string, password: string, code: string | undefined, ip?: string): Promise<OpsLoginResult> {
    const op = await this.model.findOne({ email: email.trim().toLowerCase() }).select('+passwordHash +totpSecret').exec();
    const fail = async (reason: string): Promise<never> => {
      await this.audit.record(
        { operatorId: op?._id.toString() ?? 'unknown', email: email.trim().toLowerCase() },
        { action: 'auth.login_failed', after: { reason }, ip },
      );
      throw new UnauthorizedException('Invalid credentials');
    };
    if (!op || !op.active || !op.passwordHash) return fail('unknown_inactive_or_no_password');
    if (!(await argon2.verify(op.passwordHash, password).catch(() => false))) return fail('bad_password');

    if (!op.totpEnabled) {
      const secret = authenticator.generateSecret();
      op.totpSecret = secret;
      await op.save();
      return {
        enrolmentRequired: true,
        enrolToken: await this.sign(op, 'ops-enrol'),
        otpauthUrl: authenticator.keyuri(op.email, 'CoCally Ops', secret),
        secret,
      };
    }
    if (!code) return { requires2fa: true };
    if (!op.totpSecret || !authenticator.check(code, op.totpSecret)) return fail('bad_totp');

    await this.model.updateOne({ _id: op._id }, { $set: { lastLoginAt: new Date(), lastLoginIp: ip } }).exec();
    await this.audit.record({ operatorId: op._id.toString(), email: op.email }, { action: 'auth.login', ip });
    return { token: await this.sign(op, 'ops'), operator: this.profile(op) };
  }

  async confirmEnrolment(enrolToken: string, code: string, ip?: string) {
    let payload: OpsJwtPayload;
    try {
      payload = await this.jwt.verifyAsync<OpsJwtPayload>(enrolToken, { secret: OPS_JWT_SECRET });
    } catch {
      throw new UnauthorizedException('Enrolment expired — sign in again');
    }
    if (payload.typ !== 'ops-enrol') throw new UnauthorizedException('Invalid enrolment');
    const op = await this.model.findById(payload.sub).select('+totpSecret').exec();
    if (!op || !op.active || (op.tokenVersion ?? 0) !== payload.tv) throw new UnauthorizedException('Enrolment expired — sign in again');
    if (!op.totpSecret || !authenticator.check(code, op.totpSecret)) throw new UnauthorizedException('That code is not right — try the next one');
    op.totpEnabled = true;
    op.lastLoginAt = new Date();
    op.lastLoginIp = ip;
    await op.save();
    await this.audit.record({ operatorId: op._id.toString(), email: op.email }, { action: 'auth.2fa_enrolled', ip });
    return { token: await this.sign(op, 'ops'), operator: this.profile(op) };
  }

  async me(operatorId: string): Promise<OperatorProfile> {
    const op = await this.model.findById(operatorId).lean().exec();
    if (!op) throw new UnauthorizedException();
    return this.profile(op);
  }

  async changePassword(me: AuthenticatedOperator, current: string, next: string, ip?: string) {
    this.assertPassword(next);
    const op = await this.model.findById(me.operatorId).select('+passwordHash').exec();
    if (!op?.passwordHash || !(await argon2.verify(op.passwordHash, current).catch(() => false))) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    if (current === next) throw new BadRequestException('New password must differ from the current one');
    op.passwordHash = await argon2.hash(next);
    op.tokenVersion = (op.tokenVersion ?? 0) + 1;
    await op.save();
    await this.audit.record(me, { action: 'auth.password_changed', ip });
    return { token: await this.sign(op, 'ops'), operator: this.profile(op) };
  }

  async signOutEverywhere(me: AuthenticatedOperator) {
    await this.model.updateOne({ _id: me.operatorId }, { $inc: { tokenVersion: 1 } }).exec();
    await this.audit.record(me, { action: 'auth.signed_out_everywhere' });
    return { ok: true };
  }

  // ── Invites (new operators and password resets) ─────────────────────────

  private webBase(): string {
    return (config.corsOrigins[0] ?? 'http://localhost:3000').replace(/\/$/, '');
  }

  async issueLink(operatorId: string, baseUrl?: string): Promise<{ url: string; expiresAt: Date }> {
    const raw = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3600_000);
    const res = await this.model.updateOne({ _id: operatorId }, { $set: { inviteTokenHash: hash(raw), inviteExpiresAt: expiresAt } }).exec();
    if (res.matchedCount === 0) throw new NotFoundException('Operator not found');
    return { url: `${(baseUrl ?? this.webBase()).replace(/\/$/, '')}/ops/invite/${raw}`, expiresAt };
  }

  async inspectInvite(raw: string) {
    const op = await this.model.findOne({ inviteTokenHash: hash(raw), inviteExpiresAt: { $gt: new Date() }, active: true }).lean().exec();
    if (!op) throw new NotFoundException('This link is invalid or has expired');
    return { email: op.email, name: op.name };
  }

  async acceptInvite(raw: string, password: string, ip?: string) {
    this.assertPassword(password);
    const op = await this.model.findOne({ inviteTokenHash: hash(raw), inviteExpiresAt: { $gt: new Date() }, active: true }).exec();
    if (!op) throw new BadRequestException('This link is invalid or has expired. Ask another operator for a new one.');
    op.passwordHash = await argon2.hash(password);
    op.inviteTokenHash = undefined;
    op.inviteExpiresAt = undefined;
    op.tokenVersion = (op.tokenVersion ?? 0) + 1;
    await op.save();
    await this.audit.record({ operatorId: op._id.toString(), email: op.email }, { action: 'auth.password_set', ip });
    return { ok: true, email: op.email };
  }

  // ── Operator management ────────────────────────────────────────────────

  async list() {
    const ops = await this.model.find().sort({ createdAt: 1 }).select('+passwordHash').lean().exec();
    return ops.map((o) => ({
      id: o._id.toString(),
      email: o.email,
      name: o.name,
      active: o.active,
      totpEnabled: o.totpEnabled,
      passwordSet: Boolean(o.passwordHash),
      lastLoginAt: o.lastLoginAt ?? null,
      lastLoginIp: o.lastLoginIp ?? null,
    }));
  }

  async create(me: AuthenticatedOperator, email: string, name: string) {
    const clean = email.trim().toLowerCase();
    if (await this.model.exists({ email: clean })) throw new ConflictException('An operator with this email already exists');
    const op = await this.model.create({ email: clean, name: name.trim() });
    const link = await this.issueLink(op._id.toString());
    await this.audit.record(me, { action: 'operator.create', entityType: 'Operator', entityId: op._id.toString(), after: { email: clean, name } });
    return { operator: { id: op._id.toString(), email: clean, name: op.name }, invite: link };
  }

  async reissueLink(me: AuthenticatedOperator, id: string) {
    const link = await this.issueLink(id);
    await this.audit.record(me, { action: 'operator.link_reissued', entityType: 'Operator', entityId: id });
    return link;
  }

  async reset2fa(me: AuthenticatedOperator, id: string) {
    const res = await this.model
      .updateOne({ _id: id }, { $set: { totpEnabled: false }, $unset: { totpSecret: 1 }, $inc: { tokenVersion: 1 } })
      .exec();
    if (res.matchedCount === 0) throw new NotFoundException('Operator not found');
    await this.audit.record(me, { action: 'operator.2fa_reset', entityType: 'Operator', entityId: id });
    return { ok: true };
  }

  async setActive(me: AuthenticatedOperator, id: string, active: boolean) {
    if (id === me.operatorId && !active) throw new BadRequestException('You cannot deactivate yourself');
    if (!active) {
      const others = await this.model.countDocuments({ _id: { $ne: id }, active: true, totpEnabled: true }).exec();
      if (others === 0) throw new BadRequestException('At least one other active, enrolled operator must remain');
    }
    const res = await this.model.updateOne({ _id: id }, { $set: { active }, $inc: { tokenVersion: 1 } }).exec();
    if (res.matchedCount === 0) throw new NotFoundException('Operator not found');
    await this.audit.record(me, { action: active ? 'operator.activate' : 'operator.deactivate', entityType: 'Operator', entityId: id });
    return { ok: true };
  }
}
