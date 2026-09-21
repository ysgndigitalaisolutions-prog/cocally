import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@cocally/shared';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ROLES_KEY } from './roles.decorator';
import type { AuthenticatedRequest } from './jwt-auth.guard';

/**
 * RBAC per ADM-01 — **default deny**.
 *
 * This guard used to `return true` when a handler carried no `@Roles`
 * decorator, which made "forgot to annotate" indistinguishable from
 * "deliberately open to everyone". That failure is silent and only ever fails
 * open: a route added without a decorator is reachable by every authenticated
 * user in the tenant, including AGENT and API_CLIENT.
 *
 * The rule is now explicit: to be reachable a handler must either declare
 * `@Roles(...)` or be marked `@Public()`. Anything else is a 403 whose log line
 * names the offending handler, so the mistake surfaces the first time the
 * route is called rather than in an audit six months later.
 *
 * Two behaviours are preserved verbatim:
 *  - OWNER implicitly has every permission per §2, including on undecorated
 *    handlers, so this rollout cannot lock the tenant owner out.
 *  - `@Public()` routes bypass roles entirely. Those routes carry their own
 *    guard instead (e.g. `ServiceTokenGuard` on the engine API, which the
 *    LiveKit worker calls with a shared bearer rather than a user JWT).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Only HTTP handlers are subject to default-deny.
    //
    // As a global APP_GUARD this also runs for WebSocket `@SubscribeMessage`
    // handlers, which have no `@Roles` decorator and no `request.user` —
    // RealtimeGateway verifies the JWT once in `handleConnection` and holds
    // the identity per socket. Applying default-deny there would kill every
    // client→server socket message (presence.set and friends) as a side effect
    // of a change that is about REST authorisation.
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!user) return false;
    // OWNER implicitly has every permission per §2.
    if (user.roles.includes('OWNER')) return true;

    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      // Logged as well as thrown: a bare 403 on the client is ambiguous, but
      // this line names the handler, making the missing decorator a one-line fix.
      this.logger.error(
        `Default-deny: ${context.getClass().name}.${context.getHandler().name} declares neither @Roles() nor @Public()`,
      );
      throw new ForbiddenException('This endpoint declares no role policy and is therefore denied');
    }

    const allowed = required.some((role) => user.roles.includes(role));
    if (!allowed) {
      throw new ForbiddenException(`Requires one of roles: ${required.join(', ')}`);
    }
    return true;
  }
}
