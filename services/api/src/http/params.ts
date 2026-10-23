import type { Request } from 'express';
import { apiError } from './errors.js';

/** Express 5 的路径参数类型是 string | string[]，这里收敛成单个字符串。 */
export function pathParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw apiError('BAD_REQUEST', `path parameter ${name} is missing`);
  }
  return value;
}
