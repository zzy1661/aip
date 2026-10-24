import { apiError, ApiError } from './errors.js';

/**
 * PostgreSQL 错误的平台化映射。
 *
 * 边界校验负责拦住绝大多数非法入参，但强制转换与锁等待仍可能穿透到数据库层。
 * 这两类错误必须落成明确的 4xx / 503，不能混成 500：
 * - 22P02：标识符格式非法，等价于调用方给了非法入参；
 * - 57014 / 55P03：语句超时与锁等待超时，是可重试的瞬时不可用。
 *
 * AIP01 是本仓自定义的 SQLSTATE：已批准的审核结论不可改判。
 * 数据库层的终态触发器是应用层之外的兜底，它抛出的错误必须落成
 * 同一个稳定错误码，而不是混成 500。
 */
export function toDatabaseApiError(error: unknown): ApiError | null {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== 'string') return null;
  switch (code) {
    case '22P02':
      return apiError('BAD_REQUEST', 'request contains a malformed identifier', [
        { field_path: 'path', reason: 'identifier is not a valid uuid' },
      ]);
    case '57014':
    case '55P03':
      return apiError('DB_UNAVAILABLE', 'the platform database is temporarily unavailable', [
        { field_path: 'database', reason: 'the request could not acquire the needed resources' },
      ]);
    case 'AIP01':
      return apiError('REVIEW_ALREADY_APPROVED', 'an approved knowledge version cannot be judged as rejected', [
        {
          field_path: 'decision',
          reason: 'the review verdict of an approved version is final; approved cannot be changed to rejected',
        },
      ]);
    default:
      return null;
  }
}
