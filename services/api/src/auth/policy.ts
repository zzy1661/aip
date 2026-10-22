import type { Permission } from '@aip/contracts';
import type { Principal } from './principal.js';
import { apiError } from '../http/errors.js';

export function hasPermission(principal: Principal, permission: Permission): boolean {
  return principal.permissions.includes(permission);
}

export function hasAllPermissions(
  principal: Principal,
  permissions: readonly Permission[],
): boolean {
  return permissions.every((permission) => hasPermission(principal, permission));
}

export function requirePermission(
  principal: Principal,
  permission: Permission,
): void {
  if (!hasPermission(principal, permission)) {
    throw apiError('FORBIDDEN', `missing permission: ${permission}`);
  }
}
