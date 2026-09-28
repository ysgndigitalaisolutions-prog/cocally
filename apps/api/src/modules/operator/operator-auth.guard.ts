import { CanActivate, createParamDecorator, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { Model, Types } from 'mongoose';
import { config } from '../../common/config';
import { Operator, OperatorDocument } from '../../schemas/operator.schema';

/**
 * Ops tokens are signed with a key derived from JWT_SECRET but distinct from
 * it, so the tenant JwtAuthGuard can never verify one and this guard can never
 * verify a tenant token. Rotating JWT_SECRET rotates both.
 */
export const OPS_JWT_SECRET = createHash('sha256').update(`cocally-ops:${config.jwtSecret}`).digest('hex');
export const OPS_TOKEN_TTL = '8h';

export interface OpsJwtPayload {
  sub: string;
  typ: 'ops' | 'ops-enrol';
  tv: number;
}

export interface AuthenticatedOperator {
  operatorId: string;
  email: string;
  name: string;
}

export interface OperatorRequest extends Request {
  operator: AuthenticatedOperator;
}

export const CurrentOperator = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<OperatorRequest>().operator;
});

/**
 * Every ops route: a valid ops token (not an enrolment token), a live and
 * active operator, a matching token version and TOTP enrolled. Checked against
 * the database on every request — there are few operators and each request
 * matters, so no cache.
 */
@Injectable()
export class OperatorAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    @InjectModel(Operator.name) private readonly operatorModel: Model<OperatorDocument>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<OperatorRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');
    let payload: OpsJwtPayload;
    try {
      payload = await this.jwt.verifyAsync<OpsJwtPayload>(header.slice(7), { secret: OPS_JWT_SECRET });
    } catch {
      throw new UnauthorizedException('Invalid or expired session');
    }
    if (payload.typ !== 'ops' || !Types.ObjectId.isValid(payload.sub)) throw new UnauthorizedException('Invalid session');
    const op = await this.operatorModel.findById(payload.sub).select('email name active tokenVersion totpEnabled').lean().exec();
    if (!op || !op.active) throw new UnauthorizedException('Account is disabled');
    if ((op.tokenVersion ?? 0) !== payload.tv) throw new UnauthorizedException('Session has been signed out');
    if (!op.totpEnabled) throw new UnauthorizedException('Two-factor authentication is required');
    req.operator = { operatorId: op._id.toString(), email: op.email, name: op.name };
    return true;
  }
}
