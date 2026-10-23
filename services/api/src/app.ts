import express, {
  type NextFunction,
  type Request,
  type Response,
  type Express,
} from 'express';
import multer from 'multer';
import { PAYLOAD_MAX_BYTES } from '@aip/contracts';
import { ApiError, apiError, toErrorBody } from './http/errors.js';
import { toApiError } from './ragflow/errors.js';
import { traceMiddleware } from './http/trace.js';
import { createAuthMiddleware } from './auth/middleware.js';
import type { TokenVerifier } from './auth/verify.js';
import { createRegistryRouter } from './registry/routes.js';
import { createKnowledgeRouter } from './knowledge/routes.js';
import type { RegistryService } from './registry/service.js';
import type { KnowledgeService } from './knowledge/service.js';

export interface AppDeps {
  projectId: string;
  verifier: TokenVerifier;
  isDenied: (scope: string, subject: string) => Promise<boolean>;
  registry: RegistryService;
  knowledge: KnowledgeService;
  /** 未预期异常必须留痕，否则 500 无法定位。 */
  logger?: { error(payload: Record<string, unknown>, message: string): void };
}

export function createApp(deps: AppDeps): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(traceMiddleware);
  app.use(express.json({ limit: PAYLOAD_MAX_BYTES }));
  app.use(express.urlencoded({ extended: false, limit: PAYLOAD_MAX_BYTES }));

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ data: { status: 'ok' } });
  });

  const authenticate = createAuthMiddleware({
    verifier: deps.verifier,
    isDenied: deps.isDenied,
    expectedScope: deps.projectId,
  });

  const projectRouter = express.Router();
  projectRouter.use(authenticate);
  projectRouter.use(createRegistryRouter(deps.registry));
  projectRouter.use(createKnowledgeRouter(deps.knowledge));

  app.use('/api/v1/projects/:projectId', projectRouter);

  app.use(notFoundHandler);
  app.use((error: unknown, req: Request, res: Response, next: NextFunction) =>
    errorHandler(deps, error, req, res, next),
  );

  return app;
}

function notFoundHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(apiError('NOT_FOUND', 'route not found'));
}

function errorHandler(
  deps: AppDeps,
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const traceId = req.traceId ?? 'unknown';

  if (error instanceof ApiError) {
    res.status(error.status).json(toErrorBody(error, traceId));
    return;
  }

  if (error instanceof multer.MulterError) {
    const apiErr =
      error.code === 'LIMIT_FILE_SIZE'
        ? apiError('UPLOAD_TOO_LARGE', 'uploaded file exceeds the size limit')
        : apiError('BAD_REQUEST', `invalid upload: ${error.code}`);
    res.status(apiErr.status).json(toErrorBody(apiErr, traceId));
    return;
  }

  if (
    error instanceof SyntaxError &&
    'body' in error &&
    typeof (error as { status?: unknown }).status === 'number'
  ) {
    const apiErr = apiError('BAD_REQUEST', 'request body is not valid JSON');
    res.status(apiErr.status).json(toErrorBody(apiErr, traceId));
    return;
  }

  // 解析器在请求体超过上限时直接抛 413，必须映射成平台错误码而不是 500。
  if ((error as { type?: unknown }).type === 'entity.too.large') {
    const apiErr = apiError('UPLOAD_TOO_LARGE', 'request body exceeds the platform size limit');
    res.status(apiErr.status).json(toErrorBody(apiErr, traceId));
    return;
  }

  // 上游故障要落成明确的上游错误码，不能混成 500，否则无法区分平台缺陷与上游不可用。
  const upstreamError = toApiError(error);
  if (upstreamError instanceof ApiError) {
    res.status(upstreamError.status).json(toErrorBody(upstreamError, traceId));
    return;
  }

  // 未预期异常不回显原始信息，避免泄露上游报文或内部路径；但必须留痕。
  deps.logger?.error(
    { err: error instanceof Error ? error.message : String(error), trace_id: traceId },
    'unhandled request error',
  );
  const apiErr = apiError('INTERNAL_ERROR', 'internal server error');
  res.status(apiErr.status).json(toErrorBody(apiErr, traceId));
}
