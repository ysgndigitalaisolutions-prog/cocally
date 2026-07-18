import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import * as argon2 from 'argon2';
import { Model } from 'mongoose';
import { authenticator } from 'otplib';
import { User, UserDocument } from '../../schemas/user.schema';
import { AuditService } from '../audit/audit.service';

export interface LoginResult {
  token?: string;
  requires2fa: boolean;
  user?: { id: string; name: string; email: string; roles: string[] };
}

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly jwtService: JwtService,
    private readonly audit: AuditService,
  ) {}

  private async issueToken(user: UserDocument): Promise<LoginResult> {
    const token = await this.jwtService.signAsync({
      sub: user._id.toString(),
      tenantId: user.tenantId.toString(),
      email: user.email,
      roles: user.roles,
    });
    return {
      token,
      requires2fa: false,
      user: { id: user._id.toString(), name: user.name, email: user.email, roles: user.roles },
    };
  }

  async login(email: string, password: string, totpCode?: string): Promise<LoginResult> {
    const user = await this.userModel
      .findOne({ email: email.toLowerCase(), active: true })
      .select('+passwordHash +totpSecret')
      .exec();
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const valid = await argon2.verify(user.passwordHash, password).catch(() => false);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    if (user.totpEnabled) {
      if (!totpCode) return { requires2fa: true };
      if (!user.totpSecret || !authenticator.check(totpCode, user.totpSecret)) {
        throw new UnauthorizedException('Invalid 2FA code');
      }
    }

    return this.issueToken(user);
  }

  /** Begin TOTP enrolment: returns the otpauth URL for an authenticator app. */
  async setup2fa(userId: string): Promise<{ otpauthUrl: string; secret: string }> {
    const user = await this.userModel.findById(userId).exec();
    if (!user) throw new UnauthorizedException();
    const secret = authenticator.generateSecret();
    await this.userModel.updateOne({ _id: userId }, { totpSecret: secret, totpEnabled: false }).exec();
    return { otpauthUrl: authenticator.keyuri(user.email, 'CoCally', secret), secret };
  }

  async confirm2fa(userId: string, code: string): Promise<{ enabled: boolean }> {
    const user = await this.userModel.findById(userId).select('+totpSecret').exec();
    if (!user?.totpSecret || !authenticator.check(code, user.totpSecret)) {
      throw new UnauthorizedException('Invalid 2FA code');
    }
    await this.userModel.updateOne({ _id: userId }, { totpEnabled: true }).exec();
    await this.audit.record({
      tenantId: user.tenantId.toString(),
      actorId: userId,
      actorLabel: user.email,
      action: 'auth.2fa_enabled',
      entityType: 'User',
      entityId: userId,
    });
    return { enabled: true };
  }

  async hashPassword(password: string): Promise<string> {
    return argon2.hash(password);
  }
}
