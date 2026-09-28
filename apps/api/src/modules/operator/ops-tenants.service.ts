import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Role } from '@cocally/shared';
import { Model, Types } from 'mongoose';
import { UserStateService } from '../../common/auth/user-state.service';
import { Call, CallDocument } from '../../schemas/call.schema';
import { Campaign, CampaignDocument } from '../../schemas/campaign.schema';
import { Client, ClientDocument, Tenant, TenantDocument, type TenantBilling, type TenantVoice } from '../../schemas/tenant.schema';
import { User, UserDocument } from '../../schemas/user.schema';
import { AuthService, normalizeLoginPhone } from '../auth/auth.service';
import { BillingService, currentPeriod, monthBounds, normaliseBilling } from '../platform/billing.service';
import { UsageService } from '../platform/usage.service';

export const TENANT_REGIONS = ['in', 'au'] as const;
/** Roles an operator may give a tenant user. API_CLIENT is machine access and set up separately. */
export const OPS_ASSIGNABLE_ROLES: Role[] = ['OWNER', 'ADMIN', 'SUPERVISOR', 'QA', 'AGENT'];

export interface CreateTenantInput {
  name: string;
  slug: string;
  region: (typeof TENANT_REGIONS)[number];
  clientName?: string;
  owner: { name: string; phone: string; email?: string };
  billing?: TenantBilling;
  voice?: TenantVoice;
  retentionDays?: number;
  dailyDialQuota?: number;
}

export interface TenantPatch {
  name?: string;
  active?: boolean;
  paused?: boolean;
  dailyDialQuota?: number;
  retentionDays?: number;
  voice?: TenantVoice | null;
  billing?: TenantBilling;
}

/**
 * Tenant lifecycle as CoCally runs it: create (with the first owner's invite),
 * profile and limits, suspend/deactivate, and the tenant's users. Operators
 * sit above every tenant role, so none of UsersService's owner-vs-admin guards
 * apply here — but every change is audited on both sides.
 */
@Injectable()
export class OpsTenantsService {
  constructor(
    @InjectModel(Tenant.name) private readonly tenantModel: Model<TenantDocument>,
    @InjectModel(Client.name) private readonly clientModel: Model<ClientDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Campaign.name) private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(Call.name) private readonly callModel: Model<CallDocument>,
    private readonly auth: AuthService,
    private readonly userState: UserStateService,
    private readonly billing: BillingService,
    private readonly usage: UsageService,
  ) {}

  private async load(id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Tenant not found');
    const t = await this.tenantModel.findById(id).exec();
    if (!t) throw new NotFoundException('Tenant not found');
    return t;
  }

  /** Every tenant with the figures an operator scans for: status, people, this month, money. */
  async list() {
    const tenants = await this.tenantModel.find().sort({ createdAt: 1 }).lean().exec();
    const { from, to } = monthBounds(currentPeriod());
    const [usage, users, lastCalls] = await Promise.all([
      this.usage.usage({ from, to }),
      this.userModel.aggregate<{ _id: Types.ObjectId; total: number; active: number }>([
        { $group: { _id: '$tenantId', total: { $sum: 1 }, active: { $sum: { $cond: ['$active', 1, 0] } } } },
      ]),
      this.callModel.aggregate<{ _id: Types.ObjectId; last: Date }>([{ $group: { _id: '$tenantId', last: { $max: '$startedAt' } } }]),
    ]);
    const userBy = new Map(users.map((u) => [u._id.toString(), u]));
    const lastBy = new Map(lastCalls.map((c) => [c._id.toString(), c.last]));
    return Promise.all(
      tenants.map(async (t) => {
        const id = t._id.toString();
        const u = usage.get(id);
        const summary = await this.billing.monthSummary(id, currentPeriod());
        return {
          id,
          name: t.name,
          slug: t.slug,
          region: t.region,
          active: t.active,
          paused: t.paused,
          createdAt: (t as unknown as { createdAt?: Date }).createdAt ?? null,
          users: userBy.get(id)?.active ?? 0,
          lastCallAt: lastBy.get(id) ?? null,
          monthDials: u?.dials ?? 0,
          monthAiMinutes: Math.round(((u?.aiSeconds ?? 0) / 60) * 100) / 100,
          monthBilledInr: summary.subtotalInr,
          creditBalanceInr: summary.creditBalanceInr,
          voice: t.voice ?? null,
          billingSet: Boolean(t.billing),
        };
      }),
    );
  }

  async detail(id: string) {
    const t = await this.load(id);
    const [users, campaigns, clients] = await Promise.all([
      this.userModel.countDocuments({ tenantId: t._id, active: true }).exec(),
      this.campaignModel.countDocuments({ tenantId: t._id }).exec(),
      this.clientModel.find({ tenantId: t._id }).select('name active').lean().exec(),
    ]);
    const obj = t.toObject() as Tenant & { _id: Types.ObjectId; createdAt?: Date };
    return {
      id: obj._id.toString(),
      name: obj.name,
      slug: obj.slug,
      region: obj.region,
      active: obj.active,
      paused: obj.paused,
      dailyDialQuota: obj.dailyDialQuota,
      retentionDays: obj.retentionDays,
      voice: obj.voice ?? null,
      billing: normaliseBilling(obj.billing),
      billingSet: Boolean(obj.billing),
      createdAt: obj.createdAt ?? null,
      users,
      campaigns,
      clients: clients.map((c) => ({ id: c._id.toString(), name: c.name, active: c.active })),
    };
  }

  /**
   * A new tenant, ready to use: the tenant, a first client (campaigns are filed
   * under one), and an OWNER with a one-time set-password link. The owner must
   * enrol an authenticator at first sign-in, as every owner does.
   */
  async create(input: CreateTenantInput) {
    const slug = input.slug.trim().toLowerCase();
    if (!/^[a-z0-9-]{3,40}$/.test(slug)) throw new BadRequestException('Short name must be 3–40 characters of a–z, 0–9 and -');
    if (await this.tenantModel.exists({ slug })) throw new ConflictException(`A tenant with short name "${slug}" already exists`);
    const phone = normalizeLoginPhone(input.owner.phone);
    if (!phone) throw new BadRequestException("Owner's phone number is not valid — use +91… or +61…");
    // Sign-in is by phone across all tenants, so a phone can only belong to one person.
    if (await this.userModel.exists({ phone })) throw new ConflictException('That phone number already has a CoCally login');
    const email = input.owner.email?.trim().toLowerCase() || undefined;

    const tenant = await this.tenantModel.create({
      name: input.name.trim(),
      slug,
      region: input.region,
      retentionDays: input.retentionDays ?? 365,
      dailyDialQuota: input.dailyDialQuota ?? 0,
      paused: false,
      active: true,
      ...(input.billing ? { billing: input.billing } : {}),
      ...(input.voice ? { voice: input.voice } : {}),
    });
    await this.clientModel.create({ tenantId: tenant._id, name: (input.clientName || input.name).trim(), branding: {}, active: true });
    const owner = await this.userModel.create({
      tenantId: tenant._id,
      phone,
      email,
      name: input.owner.name.trim(),
      roles: ['OWNER'],
      skills: [],
      languages: ['en'],
    });
    const invite = await this.auth.createInvite(tenant._id.toString(), owner._id.toString(), 'INVITE', { label: 'CoCally ops' });
    return {
      tenant: await this.detail(tenant._id.toString()),
      owner: { id: owner._id.toString(), name: owner.name, phone, email },
      invite,
    };
  }

  async update(id: string, patch: TenantPatch) {
    const before = await this.detail(id);
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ''> = {};
    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw new BadRequestException('Name cannot be blank');
      $set.name = patch.name.trim();
    }
    if (patch.active !== undefined) $set.active = patch.active;
    if (patch.paused !== undefined) $set.paused = patch.paused;
    if (patch.dailyDialQuota !== undefined) $set.dailyDialQuota = patch.dailyDialQuota;
    if (patch.retentionDays !== undefined) $set.retentionDays = patch.retentionDays;
    if (patch.voice === null) $unset.voice = '';
    else if (patch.voice) $set.voice = { provider: patch.voice.provider, voiceId: patch.voice.voiceId?.trim() || undefined };
    if (patch.billing) $set.billing = patch.billing;
    await this.tenantModel
      .updateOne(
        { _id: new Types.ObjectId(id) },
        { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) },
      )
      .exec();
    // Deactivating a tenant must end its sessions now, not at token expiry.
    if (patch.active !== undefined && patch.active !== before.active) await this.invalidateTenantSessions(id);
    return { before, after: await this.detail(id) };
  }

  private async invalidateTenantSessions(tenantId: string) {
    const ids = await this.userModel.find({ tenantId: new Types.ObjectId(tenantId) }).distinct('_id').exec();
    await this.userModel.updateMany({ tenantId: new Types.ObjectId(tenantId) }, { $inc: { tokenVersion: 1 } }).exec();
    ids.forEach((u) => this.userState.invalidate(u.toString()));
  }

  // ── Users ──────────────────────────────────────────────────────────────

  async users(tenantId: string) {
    await this.load(tenantId);
    const users = await this.userModel
      .find({ tenantId: new Types.ObjectId(tenantId) })
      .select('+passwordHash')
      .sort({ createdAt: 1 })
      .lean()
      .exec();
    return users.map((u) => ({
      id: u._id.toString(),
      name: u.name,
      phone: u.phone ?? null,
      email: u.email ?? null,
      roles: u.roles,
      active: u.active,
      totpEnabled: u.totpEnabled,
      passwordSet: Boolean(u.passwordHash),
      presence: u.presence,
      lastLoginAt: u.lastLoginAt ?? null,
    }));
  }

  async inviteUser(tenantId: string, input: { name: string; phone: string; email?: string; roles: Role[] }) {
    await this.load(tenantId);
    const phone = normalizeLoginPhone(input.phone);
    if (!phone) throw new BadRequestException('Phone number is not valid — use +91… or +61…');
    if (!input.roles.length || input.roles.some((r) => !OPS_ASSIGNABLE_ROLES.includes(r))) {
      throw new BadRequestException('Pick at least one of OWNER, ADMIN, SUPERVISOR, QA, AGENT');
    }
    if (await this.userModel.exists({ phone })) throw new ConflictException('That phone number already has a CoCally login');
    const email = input.email?.trim().toLowerCase() || undefined;
    const user = await this.userModel.create({
      tenantId: new Types.ObjectId(tenantId),
      phone,
      email,
      name: input.name.trim(),
      roles: input.roles,
      skills: [],
      languages: ['en'],
    });
    const invite = await this.auth.createInvite(tenantId, user._id.toString(), 'INVITE', { label: 'CoCally ops' });
    return { user: { id: user._id.toString(), name: user.name, phone, email, roles: user.roles }, invite };
  }

  private async tenantUser(tenantId: string, userId: string) {
    if (!Types.ObjectId.isValid(userId)) throw new NotFoundException('User not found');
    const user = await this.userModel
      .findOne({ _id: new Types.ObjectId(userId), tenantId: new Types.ObjectId(tenantId) })
      .select('+passwordHash')
      .exec();
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /** Invite link if they never set a password, reset link if they did. */
  async reissueLink(tenantId: string, userId: string) {
    const user = await this.tenantUser(tenantId, userId);
    const purpose = user.passwordHash ? 'RESET' : 'INVITE';
    const invite = await this.auth.createInvite(tenantId, userId, purpose, { label: 'CoCally ops' });
    return { purpose, invite };
  }

  async reset2fa(tenantId: string, userId: string) {
    await this.tenantUser(tenantId, userId);
    await this.userModel
      .updateOne({ _id: new Types.ObjectId(userId) }, { $set: { totpEnabled: false }, $unset: { totpSecret: 1 }, $inc: { tokenVersion: 1 } })
      .exec();
    this.userState.invalidate(userId);
    return { ok: true };
  }

  async setUserActive(tenantId: string, userId: string, active: boolean) {
    const user = await this.tenantUser(tenantId, userId);
    if (!active && user.roles.includes('OWNER')) {
      const others = await this.userModel
        .countDocuments({ tenantId: user.tenantId, _id: { $ne: user._id }, roles: 'OWNER', active: true })
        .exec();
      if (others === 0) throw new BadRequestException('This is the tenant’s last active owner — add another owner first');
    }
    await this.userModel.updateOne({ _id: user._id }, { $set: { active }, $inc: { tokenVersion: 1 } }).exec();
    this.userState.invalidate(userId);
    return { ok: true };
  }

  async setUserRoles(tenantId: string, userId: string, roles: Role[]) {
    const user = await this.tenantUser(tenantId, userId);
    if (!roles.length || roles.some((r) => !OPS_ASSIGNABLE_ROLES.includes(r))) {
      throw new BadRequestException('Pick at least one of OWNER, ADMIN, SUPERVISOR, QA, AGENT');
    }
    if (user.roles.includes('OWNER') && !roles.includes('OWNER')) {
      const others = await this.userModel
        .countDocuments({ tenantId: user.tenantId, _id: { $ne: user._id }, roles: 'OWNER', active: true })
        .exec();
      if (others === 0) throw new BadRequestException('This is the tenant’s last owner — add another owner first');
    }
    const before = user.roles;
    await this.userModel.updateOne({ _id: user._id }, { $set: { roles }, $inc: { tokenVersion: 1 } }).exec();
    this.userState.invalidate(userId);
    return { before, after: roles };
  }

  // ── Campaigns (read-only) ──────────────────────────────────────────────

  async campaigns(tenantId: string) {
    await this.load(tenantId);
    const { from, to } = monthBounds(currentPeriod());
    const [campaigns, usage] = await Promise.all([
      this.campaignModel
        .find({ tenantId: new Types.ObjectId(tenantId) })
        .select('name status countryPackCode createdAt dailyDialBudget voicemailPolicy transferThreshold')
        .sort({ createdAt: -1 })
        .lean()
        .exec(),
      this.usage.usage({ from, to, tenantId, groupBy: 'campaignId' }),
    ]);
    return campaigns.map((c) => {
      const u = usage.get(c._id.toString());
      return {
        id: c._id.toString(),
        name: c.name,
        status: c.status,
        country: c.countryPackCode,
        dailyDialBudget: (c as unknown as { dailyDialBudget?: number }).dailyDialBudget ?? null,
        voicemailPolicy: (c as unknown as { voicemailPolicy?: string }).voicemailPolicy ?? null,
        monthDials: u?.dials ?? 0,
        monthAnswered: u?.answered ?? 0,
        monthTransfers: u?.transfers ?? 0,
        monthAiMinutes: Math.round(((u?.aiSeconds ?? 0) / 60) * 100) / 100,
      };
    });
  }
}
