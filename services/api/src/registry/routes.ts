import { Router } from 'express';
import { requirePermissionMiddleware } from '../auth/middleware.js';
import { requireIdempotencyKey } from '../idempotency/service.js';
import { pathParam } from '../http/params.js';
import type { RegistryService } from './service.js';

export function createRegistryRouter(service: RegistryService): Router {
  const router = Router();

  router.post(
    '/assets',
    requirePermissionMiddleware('asset:write'),
    async (req, res) => {
      const key = requireIdempotencyKey(req.header('idempotency-key'));
      const result = await service.register(req.principal, req.body, key);
      res.status(result.statusCode).json({
        ...(result.body as { data: unknown }),
        trace_id: req.traceId,
      });
    },
  );

  router.post(
    '/assets/validate',
    requirePermissionMiddleware('asset:write'),
    async (req, res) => {
      const result = await service.validateOnly(req.principal, req.body);
      res.status(200).json({ ...(result as { data: unknown }), trace_id: req.traceId });
    },
  );

  router.get('/assets', requirePermissionMiddleware('asset:read'), async (req, res) => {
    const result = await service.list(req.principal, {
      type: typeof req.query.type === 'string' ? req.query.type : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      limit: typeof req.query.limit === 'string' ? req.query.limit : undefined,
    });
    res.status(200).json({ ...result, trace_id: req.traceId });
  });

  router.get(
    '/assets/:assetId/versions/:version',
    requirePermissionMiddleware('asset:read'),
    async (req, res) => {
      const detail = await service.detail(
        req.principal,
        pathParam(req, 'assetId'),
        pathParam(req, 'version'),
      );
      res.status(200).json({ data: detail, trace_id: req.traceId });
    },
  );

  router.post(
    '/assets/:assetId/versions',
    requirePermissionMiddleware('asset:write'),
    async (req, res) => {
      const key = requireIdempotencyKey(req.header('idempotency-key'));
      const result = await service.createVersion(
        req.principal,
        pathParam(req, 'assetId'),
        req.body,
        key,
      );
      res.status(result.statusCode).json({
        ...(result.body as { data: unknown }),
        trace_id: req.traceId,
      });
    },
  );

  router.post(
    '/assets/:assetId/versions/:version/status',
    requirePermissionMiddleware('asset:manage'),
    async (req, res) => {
      const result = await service.changeStatus(
        req.principal,
        pathParam(req, 'assetId'),
        pathParam(req, 'version'),
        req.body,
      );
      res.status(200).json({ ...(result as { data: unknown }), trace_id: req.traceId });
    },
  );

  return router;
}
