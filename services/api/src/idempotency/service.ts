import type { PoolClient } from 'pg';
import { apiError } from '../http/errors.js';

export interface IdempotencyScope {
  scopeId: string;
  subject: string;
  operation: string;
  key: string;
  requestHash: string;
}

export interface StoredResponse {
  statusCode: number;
  body: unknown;
}

export interface IdempotencyOutcome {
  replayed: boolean;
  response: StoredResponse;
}

/**
 * 幂等键在同一个事务内先占位再执行业务：
 * 并发同键请求会在唯一索引上等待，先提交者写入响应，后到者回放同一份结果。
 */
export async function runIdempotent(
  client: PoolClient,
  scope: IdempotencyScope,
  work: () => Promise<StoredResponse>,
): Promise<IdempotencyOutcome> {
  const inserted = await client.query<{ inserted: number }>(
    `INSERT INTO idempotency_record
       (scope_id, subject, operation, idempotency_key, request_hash, status_code, response_body)
     VALUES ($1, $2, $3, $4, $5, 0, '{}'::jsonb)
     ON CONFLICT (scope_id, subject, operation, idempotency_key) DO NOTHING
     RETURNING 1 AS inserted`,
    [scope.scopeId, scope.subject, scope.operation, scope.key, scope.requestHash],
  );

  if ((inserted.rowCount ?? 0) > 0) {
    const response = await work();
    await client.query(
      `UPDATE idempotency_record
          SET status_code = $5, response_body = $6::jsonb
        WHERE scope_id = $1 AND subject = $2 AND operation = $3 AND idempotency_key = $4`,
      [
        scope.scopeId,
        scope.subject,
        scope.operation,
        scope.key,
        response.statusCode,
        JSON.stringify(response.body),
      ],
    );
    return { replayed: false, response };
  }

  const existing = await client.query<{
    request_hash: string;
    status_code: number;
    response_body: unknown;
  }>(
    `SELECT request_hash, status_code, response_body
       FROM idempotency_record
      WHERE scope_id = $1 AND subject = $2 AND operation = $3 AND idempotency_key = $4`,
    [scope.scopeId, scope.subject, scope.operation, scope.key],
  );
  const row = existing.rows[0];
  if (!row) {
    throw apiError('IDEMPOTENCY_CONFLICT', 'idempotency key could not be resolved');
  }
  if (row.request_hash !== scope.requestHash) {
    throw apiError(
      'IDEMPOTENCY_CONFLICT',
      'idempotency key was already used with a different request payload',
    );
  }
  return {
    replayed: true,
    response: { statusCode: row.status_code, body: row.response_body },
  };
}

export function requireIdempotencyKey(value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    throw apiError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
  }
  if (value.length > 200) {
    throw apiError('BAD_REQUEST', 'Idempotency-Key header is too long');
  }
  return value;
}
