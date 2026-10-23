import type { ErrorCode, ErrorBody, FieldIssue } from '@aip/contracts';
import { ERROR_STATUS } from '@aip/contracts';

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: FieldIssue[];

  constructor(code: ErrorCode, message: string, details: FieldIssue[] = []) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }
}

export function apiError(
  code: ErrorCode,
  message: string,
  details: FieldIssue[] = [],
): ApiError {
  return new ApiError(code, message, details);
}

export function fieldIssue(fieldPath: string, reason: string): FieldIssue {
  return { field_path: fieldPath, reason };
}

export function toErrorBody(error: ApiError, traceId: string): ErrorBody {
  return {
    code: error.code,
    message: error.message,
    trace_id: traceId,
    details: error.details,
  };
}
