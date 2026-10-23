import type { NextFunction, Request, Response } from 'express';
import type { Permission } from '@aip/contracts';
import type { Principal } from './principal.js';
import {
  isMultiScope,
  parseAuthzRevision,
  parsePermissions,
  parseScope,
} from './principal.js';
import { apiError } from '../http/errors.js';
import { hasPermission } from './policy.js';
import type { TokenVerifier } from './verify.js';

export interface AuthDeps {
  verifier: TokenVerifier;
  /** 返回 true 表示主体已被本地拒绝（禁用/撤销）。 */
  isDenied: (scope: string, subject: string) => Promise<boolean>;
  expectedScope: string;
}

export function createAuthMiddleware(deps: AuthDeps) {
  return async function authenticate(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const header = req.header('authorization');
      if (!header || !/^Bearer\s+\S+$/i.test(header)) {
        throw apiError('UNAUTHENTICATED', 'missing bearer token');
      }
      const token = header.replace(/^Bearer\s+/i, '');

      let claims;
      try {
        claims = (await deps.verifier.verify(token)).claims;
      } catch {
        throw apiError('UNAUTHENTICATED', 'invalid token');
      }

      const subject = typeof claims.sub === 'string' ? claims.sub : null;
      if (!subject) {
        throw apiError('UNAUTHENTICATED', 'token subject missing');
      }

      const rawScope = claims.scope ?? claims.scp;
      if (isMultiScope(rawScope)) {
        throw apiError('FORBIDDEN', 'multi-scope tokens are not supported by this deployment');
      }
      const scope = parseScope(rawScope);
      if (!scope) {
        throw apiError('UNAUTHENTICATED', 'token scope missing');
      }
      if (scope !== deps.expectedScope) {
        throw apiError('FORBIDDEN', 'token scope does not match deployment scope');
      }

      const pathScope = req.params.projectId;
      if (typeof pathScope === 'string' && pathScope !== scope) {
        throw apiError('FORBIDDEN', 'path project does not match token scope');
      }

      if (await deps.isDenied(scope, subject)) {
        throw apiError('FORBIDDEN', 'subject is denied');
      }

      req.principal = {
        subject,
        scope,
        permissions: parsePermissions(claims.permissions),
        authzRevision: parseAuthzRevision(claims.authz_revision),
        traceId: req.traceId,
        tokenId: typeof claims.jti === 'string' ? claims.jti : null,
      };
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requirePermissionMiddleware(permission: Permission) {
  return function authorize(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): void {
    try {
      if (!hasPermission(req.principal, permission)) {
        throw apiError('FORBIDDEN', `missing permission: ${permission}`);
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
