/**
 * 统一错误响应体。调用方只看到稳定错误码与字段级原因，不暴露上游原文或堆栈。
 */

export const ERROR_CODES = [
  'BAD_REQUEST',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_CONFLICT',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VERSION_EXISTS',
  'STATE_CONFLICT',
  'CONTRACT_INVALID',
  'INVALID_VERSION',
  'REF_NOT_AVAILABLE',
  'PERMISSION_ESCALATION',
  'UPLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'INDEX_NOT_READY',
  'AUTHORIZED_SCOPE_TOO_LARGE',
  'RAGFLOW_PROTOCOL_ERROR',
  'RAGFLOW_UNAVAILABLE',
  'RAGFLOW_TIMEOUT',
  'ONTO_UNAVAILABLE',
  'DB_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  IDEMPOTENCY_CONFLICT: 409,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VERSION_EXISTS: 409,
  STATE_CONFLICT: 409,
  CONTRACT_INVALID: 422,
  INVALID_VERSION: 422,
  REF_NOT_AVAILABLE: 422,
  PERMISSION_ESCALATION: 422,
  UPLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  INDEX_NOT_READY: 409,
  AUTHORIZED_SCOPE_TOO_LARGE: 422,
  RAGFLOW_PROTOCOL_ERROR: 502,
  RAGFLOW_UNAVAILABLE: 503,
  RAGFLOW_TIMEOUT: 504,
  ONTO_UNAVAILABLE: 503,
  // 数据库层面的瞬时不可用（锁等待超时、语句超时）：可重试，不得落成 500。
  DB_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export interface FieldIssue {
  field_path: string;
  reason: string;
}

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  trace_id: string;
  details: FieldIssue[];
}

export interface SuccessEnvelope<T> {
  data: T;
  trace_id: string;
}

export interface ListEnvelope<T> {
  data: T[];
  next_cursor: string | null;
  trace_id: string;
}
