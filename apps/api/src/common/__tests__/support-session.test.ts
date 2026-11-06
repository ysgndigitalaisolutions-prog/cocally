import { describe, expect, it } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { UserState, UserStateService } from '../auth/user-state.service';

const jwt = new JwtService({ secret: 'test-secret' });
const reflector = { getAllAndOverride: () => false } as unknown as Reflector;

function guardWith(state: Partial<UserState>) {
  const full: UserState = { active: true, tokenVersion: 0, totpEnabled: false, roles: ['ADMIN'], support: false, ...state };
  return new JwtAuthGuard(jwt, reflector, { load: async () => full } as unknown as UserStateService);
}

function ctx(token: string) {
  const request = { headers: { authorization: `Bearer ${token}` } };
  return { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => null, getClass: () => null } as unknown as ExecutionContext;
}

const sign = (extra: Record<string, unknown> = {}) =>
  jwt.signAsync({ sub: '6aeaad968be0955f6eead40b', tenantId: '6aeaad968be0955f6eead40c', email: 'x', roles: ['ADMIN'], tv: 0, ...extra });

describe('support sessions', () => {
  it('lets an ops-minted token into the support identity without its own 2FA', async () => {
    await expect(guardWith({ support: true }).canActivate(ctx(await sign({ sup: 'ops@cocally.com' })))).resolves.toBe(true);
  });

  it('refuses the support identity on an ordinary token', async () => {
    await expect(guardWith({ support: true }).canActivate(ctx(await sign()))).rejects.toThrow('Invalid session');
  });

  it('refuses a support token for an ordinary user', async () => {
    await expect(guardWith({ support: false, totpEnabled: true }).canActivate(ctx(await sign({ sup: 'ops@cocally.com' })))).rejects.toThrow(
      'Invalid session',
    );
  });

  it('still asks an ordinary admin without 2FA to enrol', async () => {
    await expect(guardWith({ support: false }).canActivate(ctx(await sign()))).rejects.toThrow('Two-factor');
  });
});
