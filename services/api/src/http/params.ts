import type { Request } from 'express';
import { apiError, fieldIssue } from './errors.js';

/** Express 5 的路径参数类型是 string | string[]，这里收敛成单个字符串。 */
export function pathParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw apiError('BAD_REQUEST', `path parameter ${name} is missing`);
  }
  return value;
}

/**
 * uuid 形态的主键。
 *
 * 这些路径参数最终进入 uuid 列或 uuid[] 强制转换，非法格式如果在边界被放过，
 * 会退化成数据库层的 22P02 错误（500），把内部错误面暴露给调用方。
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuidPathParam(req: Request, name: string): string {
  const value = pathParam(req, name);
  if (!UUID_PATTERN.test(value)) {
    throw apiError('BAD_REQUEST', `path parameter ${name} must be a uuid`, [
      fieldIssue(name, 'must be a uuid'),
    ]);
  }
  return value;
}
