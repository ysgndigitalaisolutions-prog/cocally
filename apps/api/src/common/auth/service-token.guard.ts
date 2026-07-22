import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { config } from '../config';

/**
 * Guards internal service-to-service endpoints (the LiveKit Agents worker
 * calling the engine) with a shared bearer token — NOT a user JWT. Routes
 * using this are also marked @Public so the global JWT guard steps aside.
 *
 * Fails closed: if ENGINE_SERVICE_TOKEN is unset, every call is rejected, so a
 * misconfigured deploy can never expose these endpoints unauthenticated.
 */
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const expected = config.engineServiceToken;
    if (!expected) throw new UnauthorizedException('Engine service token not configured');
    const header = ctx.switchToHttp().getRequest<Request>().headers['authorization'];
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token !== expected) throw new UnauthorizedException('Invalid engine service token');
    return true;
  }
}
