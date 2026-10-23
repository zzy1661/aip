import type { Permission } from '@aip/contracts';
import { PERMISSIONS } from '@aip/contracts';

/**
 * 可信主体。只能由服务端校验过的令牌构造，请求体中的 actor/subject 一律无效。
 */
export interface Principal {
  subject: string;
  scope: string;
  permissions: Permission[];
  authzRevision: number;
  traceId: string;
  tokenId: string | null;
}

export interface TokenClaims {
  sub?: unknown;
  scope?: unknown;
  scp?: unknown;
  permissions?: unknown;
  authz_revision?: unknown;
  jti?: unknown;
}

const KNOWN_PERMISSIONS = new Set<string>(PERMISSIONS);

export function parsePermissions(value: unknown): Permission[] {
  if (!Array.isArray(value)) return [];
  const result: Permission[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    if (!KNOWN_PERMISSIONS.has(entry)) continue;
    if (!result.includes(entry as Permission)) result.push(entry as Permission);
  }
  return result;
}

/**
 * 令牌声明了多个不同 scope 时返回 true。
 *
 * 本部署是单 scope 的：中间件会把令牌 scope 与部署 scope、路径上的 projectId
 * 三者严格相等地比对。多 scope 令牌既不能按首元素放行（那会把 scope 语义
 * 悄悄缩成「第一条」），也不能静默忽略其余 scope，只能显式拒绝。
 */
export function isMultiScope(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const scopes = new Set(
    value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0),
  );
  return scopes.size > 1;
}

export function parseScope(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

export function parseAuthzRevision(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  return 0;
}
