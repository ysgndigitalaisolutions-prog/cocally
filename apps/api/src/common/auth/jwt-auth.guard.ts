import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Role } from '@cocally/shared';
import type { Request } from 'express';
import { UserStateService } from './user-state.service';
import { IS_PUBLIC_KEY, SKIP_2FA_KEY } from './public.decorator';

export interface AuthenticatedUser {
  userId: string;
  tenantId: string;
  email: string;
  roles: Role[];
  totpEnabled: boolean;
}

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}

export interface JwtPayload {
  sub: string;
  tenantId: string;
  email: string;
  roles: Role[];
  /** tokenVersion at mint time; see User.tokenVersion. */
  tv: number;
  /** Set on support sessions opened from the ops console: the operator's email. */
  sup?: string;
}

/** Roles that must have TOTP enrolled before they can use anything but the enrolment routes. */
export const TWO_FACTOR_REQUIRED_ROLES: Role[] = ['OWNER', 'ADMIN', 'SUPERVISOR', 'QA'];

/**
 * Verifies the bearer JWT, then checks the user's live state so that
 * deactivation, password changes and "sign out everywhere" take effect at once
 * rather than at token expiry. The lookup goes through UserStateService, which
 * caches briefly and is invalidated by every write that changes access.
 *
 * Also enforces TOTP enrolment for privileged roles: a user in
 * TWO_FACTOR_REQUIRED_ROLES without TOTP is refused everywhere except routes
 * marked @AllowWithout2fa(), with a stable error code the web app redirects on.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
    private readonly userState: UserStateService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(header.slice(7));
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const state = await this.userState.load(payload.sub);
    if (!state || !state.active) throw new UnauthorizedException('Account is disabled');
    if ((payload.tv ?? 0) !== state.tokenVersion) throw new UnauthorizedException('Session has been signed out');
    // The support identity has no login of its own; only an ops-minted token opens it.
    if (state.support !== Boolean(payload.sup)) throw new UnauthorizedException('Invalid session');

    request.user = {
      userId: payload.sub,
      tenantId: payload.tenantId,
      email: state.email ?? state.phone ?? payload.email,
      roles: state.roles,
      totpEnabled: state.totpEnabled,
    };

    // A support session's two-factor check was the operator's own, at the ops console.
    const needs2fa = !payload.sup && state.roles.some((r) => TWO_FACTOR_REQUIRED_ROLES.includes(r)) && !state.totpEnabled;
    if (needs2fa) {
      const skip = this.reflector.getAllAndOverride<boolean>(SKIP_2FA_KEY, [context.getHandler(), context.getClass()]);
      if (!skip) {
        throw new ForbiddenException({
          statusCode: 403,
          code: 'TWO_FACTOR_REQUIRED',
          message: 'Two-factor authentication must be set up before continuing',
        });
      }
    }
    return true;
  }

}
