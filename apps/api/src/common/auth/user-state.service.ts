import { Global, Injectable, Module } from '@nestjs/common';
import { InjectModel, MongooseModule } from '@nestjs/mongoose';
import type { Role } from '@cocally/shared';
import { Model, Types } from 'mongoose';
import { Tenant, TenantDocument, TenantSchema } from '../../schemas/tenant.schema';
import { User, UserDocument, UserSchema } from '../../schemas/user.schema';

export interface UserState {
  active: boolean;
  tokenVersion: number;
  totpEnabled: boolean;
  roles: Role[];
  email?: string;
  phone?: string;
}

/**
 * Live per-user state consulted on every authenticated request (active flag,
 * token version, TOTP enrolment, roles). Cached briefly so the check stays off
 * the hot path; any write that changes one of these fields calls
 * `invalidate()` so the next request sees it at once.
 */
@Injectable()
export class UserStateService {
  private static readonly TTL_MS = 10_000;
  private readonly cache = new Map<string, UserState & { at: number }>();

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Tenant.name) private readonly tenantModel: Model<TenantDocument>,
  ) {}

  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  async load(userId: string): Promise<UserState | null> {
    const cached = this.cache.get(userId);
    if (cached && Date.now() - cached.at < UserStateService.TTL_MS) return cached;
    if (!Types.ObjectId.isValid(userId)) return null;
    const user = await this.userModel
      .findById(new Types.ObjectId(userId))
      .select('active tokenVersion totpEnabled roles email phone tenantId')
      .lean()
      .exec();
    if (!user) return null;
    // A tenant CoCally has deactivated locks out every one of its users.
    const tenant = await this.tenantModel.findById(user.tenantId).select('active').lean().exec();
    const state = {
      active: user.active && tenant?.active !== false,
      tokenVersion: user.tokenVersion ?? 0,
      totpEnabled: user.totpEnabled,
      roles: user.roles,
      email: user.email,
      phone: user.phone,
      at: Date.now(),
    };
    this.cache.set(userId, state);
    return state;
  }
}

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Tenant.name, schema: TenantSchema },
    ]),
  ],
  providers: [UserStateService],
  exports: [UserStateService],
})
export class UserStateModule {}
