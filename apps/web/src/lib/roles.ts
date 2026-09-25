import type { Role } from '@cocally/shared';

/** The subset of a session user the role helpers need. */
export interface RoleBearer {
  roles: string[];
  twoFactorSetupRequired?: boolean;
}

/**
 * Who can work the agent desk (clock in, go Available, manual dial). Mirrors
 * the `@Roles` lists on `POST /workspace/presence`, `/clock-in` and the
 * manual-dial routes. OWNER is deliberately absent: the roles guard lets an
 * owner through, but `availableAgentCount` only counts users holding AGENT,
 * so an owner going Available would never receive a transfer. The "Takes
 * calls" toggle on Users & access adds AGENT for owners who fill a chair.
 */
export const DESK_ROLES: Role[] = ['AGENT', 'SUPERVISOR', 'ADMIN'];

/** Roles that can read tenant-wide analytics (`/analytics/*`). */
export const MANAGEMENT_ROLES: Role[] = ['OWNER', 'ADMIN', 'SUPERVISOR', 'QA'];

/** Roles that see the floor: team roster, live AI calls, supervisor desk. */
export const SUPERVISOR_ROLES: Role[] = ['SUPERVISOR', 'ADMIN', 'OWNER'];

export function hasRole(user: RoleBearer | null | undefined, ...roles: Role[]): boolean {
  if (!user) return false;
  return roles.some((r) => user.roles.includes(r));
}

export function isManager(user: RoleBearer | null | undefined): boolean {
  return hasRole(user, ...MANAGEMENT_ROLES);
}

/**
 * Where a user lands after sign-in, and where they bounce to when they open
 * a page their roles cannot see.
 *
 * Anyone holding AGENT lands on the workspace: they must clock in before
 * anything else can happen, and an owner who turned "Takes calls" on has said
 * they are filling a chair. Everyone else with a management role lands on the
 * dashboard. `/security` is the fallback because it is open to every role, so
 * this can never redirect somewhere `canVisit` rejects.
 */
export function homeFor(user: RoleBearer | null | undefined): string {
  if (!user) return '/login';
  if (user.twoFactorSetupRequired) return '/security';
  if (hasRole(user, 'AGENT')) return '/workspace';
  if (isManager(user)) return '/dashboard';
  return '/security';
}

const ROLE_TITLES: Array<[Role, string]> = [
  ['OWNER', 'Owner'],
  ['ADMIN', 'Admin'],
  ['SUPERVISOR', 'Supervisor'],
  ['QA', 'QA'],
  ['AGENT', 'Agent'],
];

/**
 * One friendly label instead of "OWNER, ADMIN, AGENT". The most senior role
 * names the person; " · takes calls" is appended when a non-agent also holds
 * AGENT, because that is the one combination the floor cares about.
 */
export function roleLabel(user: RoleBearer | null | undefined): string {
  if (!user) return '';
  const primary = ROLE_TITLES.find(([role]) => user.roles.includes(role));
  if (!primary) return user.roles.join(', ').toLowerCase();
  const [role, title] = primary;
  if (role !== 'AGENT' && user.roles.includes('AGENT')) return `${title} · takes calls`;
  return title;
}
