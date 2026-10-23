import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const TRACE_HEADER = 'x-trace-id';

/** 传播调用方提供的 trace id；缺省时生成，且不信任其内部结构。 */
export function traceMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(TRACE_HEADER);
  const traceId =
    incoming && /^[\w.-]{1,128}$/.test(incoming) ? incoming : randomUUID();
  req.traceId = traceId;
  res.setHeader(TRACE_HEADER, traceId);
  next();
}
