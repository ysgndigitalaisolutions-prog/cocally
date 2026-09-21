import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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
  async reissueLink(tenantId: string, actor: { id: string; label: string }, userId: string) {
    const user = await this.userModel
      .findOne({ _id: new Types.ObjectId(userId), tenantId: new Types.ObjectId(tenantId) })
      .select('+passwordHash')
      .exec();
    if (!user) throw new NotFoundException('User not found');
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
