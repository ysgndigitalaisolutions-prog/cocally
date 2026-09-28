import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { config } from '../../common/config';
import type { AuthenticatedRequest, AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

/** True for CoCally's own operators (`PLATFORM_ADMIN_EMAILS`). */
export function isPlatformAdmin(user: Pick<AuthenticatedUser, 'email'> | undefined): boolean {
  return Boolean(user?.email && config.platformAdminEmails.includes(user.email.toLowerCase()));
}

/**
 * Cross-tenant routes. A tenant role — even OWNER — is not enough: these read
 * and change every tenant, so only the emails in `PLATFORM_ADMIN_EMAILS` pass.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!isPlatformAdmin(user)) throw new ForbiddenException('Platform administrators only');
    return true;
  }
}
