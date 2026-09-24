import { BadRequestException, ForbiddenException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Role } from '@cocally/shared';
import { Model, Types } from 'mongoose';
import { User, UserDocument } from '../../schemas/user.schema';
import { AuditService } from '../audit/audit.service';
import { AuthService, normalizeLoginPhone } from '../auth/auth.service';
import { UserStateService } from '../../common/auth/user-state.service';

export interface CreateUserInput {
  phone: string;
  email?: string;
  name: string;
  roles: Role[];
  skills?: string[];
  languages?: string[];
}

export interface SafeUser {
  id: string;
  phone?: string;
  email?: string;
  name: string;
  roles: Role[];
  skills: string[];
  languages: string[];
  presence: string;
  totpEnabled: boolean;
  active: boolean;
  passwordSet: boolean;
  lastLoginAt?: Date;
  lastLoginIp?: string;
  createdAt?: Date;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly authService: AuthService,
    private readonly audit: AuditService,
    private readonly userState: UserStateService,
  ) {}

  /**
   * Creates the account without a password and returns a one-time invite link.
   * The user sets their own password through the link; nobody ever sees or
   * transmits a password on their behalf.
   */
  async invite(tenantId: string, actor: { id: string; label: string }, input: CreateUserInput) {
    const phone = normalizeLoginPhone(input.phone);
    if (!phone) throw new BadRequestException('Phone number is not a valid mobile or landline number');
    const email = input.email?.trim().toLowerCase() || undefined;

    const tenant = new Types.ObjectId(tenantId);
    const clash = await this.userModel
      .findOne({ tenantId: tenant, $or: [{ phone }, ...(email ? [{ email }] : [])] })
      .lean()
      .exec();
    if (clash) throw new ConflictException('A user with this phone number or email already exists');

    const user = await this.userModel.create({
      tenantId: tenant,
      phone,
      email,
      name: input.name.trim(),
      roles: input.roles,
      skills: input.skills ?? [],
      languages: input.languages ?? ['en'],
    });
    await this.audit.record({
      tenantId,
      actorId: actor.id,
      actorLabel: actor.label,
      action: 'user.create',
      entityType: 'User',
      entityId: user._id.toString(),
      after: { phone, email, roles: user.roles },
    });
    const invite = await this.authService.createInvite(tenantId, user._id.toString(), 'INVITE', actor);
    return { user: this.toSafe(user), invite };
  }

  /** New invite for a user who has not set a password, or a reset link for one who has. */
  /**
   * An ADMIN must not be able to take over an OWNER account: reissuing the
   * owner's reset link or clearing their authenticator is exactly that. Only
   * an OWNER may act on an OWNER (other than themselves).
   */
  async assertMayManage(tenantId: string, actorId: string, target: { _id: Types.ObjectId; roles: string[] }): Promise<void> {
    if (!target.roles.includes('OWNER') || target._id.toString() === actorId) return;
    const actor = await this.userModel.findById(actorId).select('roles').lean().exec();
    if (!actor?.roles.includes('OWNER')) throw new ForbiddenException('Only an owner can manage an owner account');
  }

  async assertMayManageId(tenantId: string, actorId: string, userId: string): Promise<void> {
    if (!Types.ObjectId.isValid(userId)) throw new NotFoundException('User not found');
    const target = await this.userModel
      .findOne({ _id: new Types.ObjectId(userId), tenantId: new Types.ObjectId(tenantId) })
      .select('roles')
      .lean()
      .exec();
    if (!target) throw new NotFoundException('User not found');
    await this.assertMayManage(tenantId, actorId, target);
  }

  async reissueLink(tenantId: string, actor: { id: string; label: string }, userId: string) {
    const user = await this.userModel
      .findOne({ _id: new Types.ObjectId(userId), tenantId: new Types.ObjectId(tenantId) })
      .select('+passwordHash')
      .exec();
    if (!user) throw new NotFoundException('User not found');
    await this.assertMayManage(tenantId, actor.id, user);
    const purpose = user.passwordHash ? 'RESET' : 'INVITE';
    const invite = await this.authService.createInvite(tenantId, userId, purpose, actor);
    return { purpose, invite };
  }

  async list(tenantId: string): Promise<SafeUser[]> {
    const users = await this.userModel
      .find({ tenantId: new Types.ObjectId(tenantId) })
      .select('+passwordHash')
      .sort({ createdAt: 1 })
      .exec();
    return users.map((u) => this.toSafe(u));
  }

  async update(
    tenantId: string,
    actor: { id: string; label: string },
    userId: string,
    patch: Partial<Pick<CreateUserInput, 'name' | 'roles' | 'skills' | 'languages'>> & { active?: boolean },
  ): Promise<SafeUser> {
    const user = await this.userModel
      .findOne({ _id: new Types.ObjectId(userId), tenantId: new Types.ObjectId(tenantId) })
      .select('+passwordHash')
      .exec();
    if (!user) throw new NotFoundException('User not found');
    if (userId === actor.id && patch.active === false) throw new BadRequestException('You cannot deactivate your own account');
    if (userId === actor.id && patch.roles && !patch.roles.includes('OWNER') && user.roles.includes('OWNER')) {
      throw new BadRequestException('You cannot remove your own OWNER role');
    }
    await this.assertMayManage(tenantId, actor.id, user);
    // Never leave a tenant with nobody who can grant OWNER.
    const strippingOwner = user.roles.includes('OWNER') && ((patch.roles && !patch.roles.includes('OWNER')) || patch.active === false);
    if (strippingOwner) {
      const otherOwners = await this.userModel
        .countDocuments({ tenantId: new Types.ObjectId(tenantId), _id: { $ne: user._id }, roles: 'OWNER', active: true })
        .exec();
      if (otherOwners === 0) throw new BadRequestException('This is the last active owner of the account');
    }

    // class-transformer exposes every declared DTO field, so absent ones arrive
    // as `undefined`; assigning those would blank required fields.
    const changes = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as typeof patch;
    const before = { name: user.name, roles: user.roles, skills: user.skills, active: user.active };
    const deactivating = changes.active === false && user.active;
    const rolesChanged = changes.roles && JSON.stringify(changes.roles) !== JSON.stringify(user.roles);
    Object.assign(user, changes);
    // Sign the user out everywhere when access is reduced.
    if (deactivating || rolesChanged) user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    await user.save();
    this.userState.invalidate(userId);

    await this.audit.record({
      tenantId,
      actorId: actor.id,
      actorLabel: actor.label,
      action: deactivating ? 'user.deactivate' : 'user.update',
      entityType: 'User',
      entityId: userId,
      before,
      after: changes as Record<string, unknown>,
    });
    return this.toSafe(user);
  }

  private toSafe(user: UserDocument): SafeUser {
    const doc = user.toObject() as User & { _id: Types.ObjectId; passwordHash?: string; createdAt?: Date };
    return {
      id: doc._id.toString(),
      phone: doc.phone,
      email: doc.email,
      name: doc.name,
      roles: doc.roles,
      skills: doc.skills,
      languages: doc.languages,
      presence: doc.presence,
      totpEnabled: doc.totpEnabled,
      active: doc.active,
      passwordSet: Boolean(doc.passwordHash),
      lastLoginAt: doc.lastLoginAt,
      lastLoginIp: doc.lastLoginIp,
      createdAt: doc.createdAt,
    };
  }
}
