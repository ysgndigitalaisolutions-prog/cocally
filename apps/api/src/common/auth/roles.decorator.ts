import { SetMetadata } from '@nestjs/common';
import type { Role } from '@cocally/shared';

export const ROLES_KEY = 'roles';
/** Least-privilege RBAC per ADM-01: handlers declare the roles allowed. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
