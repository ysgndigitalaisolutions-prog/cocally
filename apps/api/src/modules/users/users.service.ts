import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Role } from '@cocally/shared';
import { Model, Types } from 'mongoose';
import { User, UserDocument } from '../../schemas/user.schema';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';

export interface CreateUserInput {
  email: string;
  name: string;
  password: string;
  roles: Role[];
  skills?: string[];
  languages?: string[];
}

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly authService: AuthService,
    private readonly audit: AuditService,
  ) {}

  async create(tenantId: string, actor: { id: string; label: string }, input: CreateUserInput) {
    const existing = await this.userModel
      .findOne({ tenantId: new Types.ObjectId(tenantId), email: input.email.toLowerCase() })
      .exec();
    if (existing) throw new ConflictException('A user with this email already exists');

    const user = await this.userModel.create({
      tenantId: new Types.ObjectId(tenantId),
      email: input.email.toLowerCase(),
      name: input.name,
      passwordHash: await this.authService.hashPassword(input.password),
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
      after: { email: user.email, roles: user.roles },
    });

    return this.toSafe(user);
  }

  async list(tenantId: string) {
    const users = await this.userModel.find({ tenantId: new Types.ObjectId(tenantId) }).lean().exec();
    return users.map((u) => ({
      id: u._id.toString(),
      email: u.email,
      name: u.name,
      roles: u.roles,
      skills: u.skills,
      languages: u.languages,
      presence: u.presence,
      totpEnabled: u.totpEnabled,
      active: u.active,
    }));
  }

  async update(
    tenantId: string,
    actor: { id: string; label: string },
    userId: string,
    patch: Partial<Pick<CreateUserInput, 'name' | 'roles' | 'skills' | 'languages'>> & { active?: boolean },
  ) {
    const user = await this.userModel
      .findOne({ _id: new Types.ObjectId(userId), tenantId: new Types.ObjectId(tenantId) })
      .exec();
    if (!user) throw new NotFoundException('User not found');

    const before = { name: user.name, roles: user.roles, skills: user.skills, active: user.active };
    Object.assign(user, patch);
    await user.save();

    await this.audit.record({
      tenantId,
      actorId: actor.id,
      actorLabel: actor.label,
      action: 'user.update',
      entityType: 'User',
      entityId: userId,
      before,
      after: patch as Record<string, unknown>,
    });

    return this.toSafe(user);
  }

  private toSafe(user: UserDocument) {
    return {
      id: user._id.toString(),
      email: user.email,
      name: user.name,
      roles: user.roles,
      skills: user.skills,
      languages: user.languages,
      presence: user.presence,
      totpEnabled: user.totpEnabled,
      active: user.active,
    };
  }
}
