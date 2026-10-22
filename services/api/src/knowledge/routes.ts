import { Router } from 'express';
import multer from 'multer';
import { requirePermissionMiddleware } from '../auth/middleware.js';
import { requireIdempotencyKey } from '../idempotency/service.js';
import { pathParam } from '../http/params.js';
import { apiError, fieldIssue } from '../http/errors.js';
import type { KnowledgeService } from './service.js';

export function createKnowledgeRouter(service: KnowledgeService): Router {
  const router = Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: service.limits.uploadMaxBytes, files: 1 },
  });

  router.post(
    '/knowledge-bases',
    requirePermissionMiddleware('knowledge:write'),
    async (req, res) => {
      const key = requireIdempotencyKey(req.header('idempotency-key'));
      const result = await service.createKnowledgeBase(req.principal, req.body, key);
      res
        .status(result.statusCode)
        .json({ ...(result.body as { data: unknown }), trace_id: req.traceId });
    },
  );

  router.get(
    '/knowledge-bases',
    requirePermissionMiddleware('knowledge:read'),
    async (req, res) => {
      const items = await service.listKnowledgeBases(req.principal);
      res.status(200).json({ data: items, trace_id: req.traceId });
    },
  );

  router.get(
    '/knowledge-bases/:kbId',
    requirePermissionMiddleware('knowledge:read'),
    async (req, res) => {
      const detail = await service.getKnowledgeBase(req.principal, pathParam(req, 'kbId'));
      res.status(200).json({ data: detail, trace_id: req.traceId });
    },
  );

  router.post(
    '/knowledge-bases/:kbId/documents',
    requirePermissionMiddleware('knowledge:write'),
    upload.single('file'),
    async (req, res) => {
      const file = req.file;
      if (!file) {
        throw apiError('CONTRACT_INVALID', 'a single "file" part is required', [
          fieldIssue('file', 'missing'),
        ]);
      }
      const key = requireIdempotencyKey(req.header('idempotency-key'));
      const version = typeof req.body.version === 'string' ? req.body.version : '1.0.0';
      const appliesTo = parseAppliesTo(req.body.applies_to);
      const result = await service.uploadDocument(
        req.principal,
        pathParam(req, 'kbId'),
        {
          originalName: file.originalname,
          mimeType: file.mimetype,
          content: file.buffer,
          version,
          appliesTo,
        },
        key,
      );
      res
        .status(result.statusCode)
        .json({ ...(result.body as { data: unknown }), trace_id: req.traceId });
    },
  );

  router.get(
    '/knowledge-bases/:kbId/documents',
    requirePermissionMiddleware('knowledge:read'),
    async (req, res) => {
      const items = await service.listDocuments(req.principal, pathParam(req, 'kbId'));
      res.status(200).json({ data: items, trace_id: req.traceId });
    },
  );

  router.get(
    '/knowledge/:knowledgeId/versions/:version',
    requirePermissionMiddleware('knowledge:read'),
    async (req, res) => {
      const detail = await service.getDocument(
        req.principal,
        pathParam(req, 'knowledgeId'),
        pathParam(req, 'version'),
      );
      res.status(200).json({ data: detail, trace_id: req.traceId });
    },
  );

  router.post(
    '/knowledge/:knowledgeId/versions/:version/review',
    requirePermissionMiddleware('knowledge:review'),
    async (req, res) => {
      const result = await service.review(
        req.principal,
        pathParam(req, 'knowledgeId'),
        pathParam(req, 'version'),
        req.body,
      );
      res.status(200).json({ ...result, trace_id: req.traceId });
    },
  );

  router.post(
    '/knowledge/:knowledgeId/versions/:version/withdraw',
    requirePermissionMiddleware('knowledge:manage'),
    async (req, res) => {
      const result = await service.withdraw(
        req.principal,
        pathParam(req, 'knowledgeId'),
        pathParam(req, 'version'),
        req.body,
      );
      res.status(200).json({ ...result, trace_id: req.traceId });
    },
  );

  router.post(
    '/retrieval',
    requirePermissionMiddleware('knowledge:read'),
    async (req, res) => {
      const result = await service.retrieval(req.principal, req.body);
      res.status(200).json({ data: result, trace_id: req.traceId });
    },
  );

  router.get(
    '/evidence/:evidenceId',
    requirePermissionMiddleware('source:read'),
    async (req, res) => {
      const evidence = await service.getEvidence(req.principal, pathParam(req, 'evidenceId'));
      res.status(200).json({ data: evidence, trace_id: req.traceId });
    },
  );

  router.get(
    '/sources/:fileId/versions/:version/download',
    requirePermissionMiddleware('source:read'),
    async (req, res) => {
      const file = await service.downloadSource(
        req.principal,
        pathParam(req, 'fileId'),
        pathParam(req, 'version'),
      );
      res.setHeader('content-type', file.mime);
      res.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
      res.setHeader('x-content-sha256', file.sha256);
      res.status(200).send(file.content);
    },
  );

  router.get(
    '/operations/:operationId',
    requirePermissionMiddleware('operations:read'),
    async (req, res) => {
      const operation = await service.getOperation(req.principal, pathParam(req, 'operationId'));
      res.status(200).json({ data: operation, trace_id: req.traceId });
    },
  );

  return router;
}

function parseAppliesTo(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw apiError('CONTRACT_INVALID', 'applies_to must be a JSON object', [
      fieldIssue('applies_to', 'invalid JSON'),
    ]);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw apiError('CONTRACT_INVALID', 'applies_to must be a JSON object', [
      fieldIssue('applies_to', 'must be an object'),
    ]);
  }
  return parsed as Record<string, unknown>;
}
