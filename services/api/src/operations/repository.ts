import type { QueryClient } from '../db/pool.js';
import type { OperationView } from '@aip/contracts';

export interface OperationRow {
  id: string;
  subject: string;
  kind: string;
  idempotency_key: string;
  request_hash: string;
  state: string;
  resource_id: string | null;
  remote_id: string | null;
  attempt: number;
  epoch: number;
  lease_until: Date | null;
  next_attempt_at: Date | null;
  last_error: string | null;
  result: unknown;
  created_at: Date;
  updated_at: Date;
}

export async function insertOperation(
  client: QueryClient,
  input: {
    scopeId: string;
    id: string;
    subject: string;
    kind: string;
    idempotencyKey: string;
    requestHash: string;
    state: string;
    resourceId?: string | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO operation
       (scope_id, id, subject, kind, idempotency_key, request_hash, state, resource_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.scopeId,
      input.id,
      input.subject,
      input.kind,
      input.idempotencyKey,
      input.requestHash,
      input.state,
      input.resourceId ?? null,
    ],
  );
}

export async function findOperation(
  client: QueryClient,
  scopeId: string,
  id: string,
): Promise<OperationRow | null> {
  const { rows } = await client.query<OperationRow>(
    `SELECT * FROM operation WHERE scope_id = $1 AND id = $2`,
    [scopeId, id],
  );
  return rows[0] ?? null;
}

export async function findOperationByIdempotencyKey(
  client: QueryClient,
  scopeId: string,
  subject: string,
  kind: string,
  idempotencyKey: string,
): Promise<OperationRow | null> {
  const { rows } = await client.query<OperationRow>(
    `SELECT * FROM operation
      WHERE scope_id = $1 AND subject = $2 AND kind = $3 AND idempotency_key = $4`,
    [scopeId, subject, kind, idempotencyKey],
  );
  return rows[0] ?? null;
}

export async function setOperationRemoteId(
  client: QueryClient,
  scopeId: string,
  id: string,
  remoteId: string,
  state: string,
  expectedEpoch?: number,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE operation
        SET remote_id = $3, state = $4, updated_at = now()
      WHERE scope_id = $1 AND id = $2
        AND ($5::bigint IS NULL OR epoch = $5::bigint)`,
    [scopeId, id, remoteId, state, expectedEpoch ?? null],
  );
  return (rowCount ?? 0) > 0;
}

export async function setOperationState(
  client: QueryClient,
  scopeId: string,
  id: string,
  state: string,
  lastError: string | null,
  expectedEpoch?: number,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE operation
        SET state = $3, last_error = $4, next_attempt_at = NULL, updated_at = now()
      WHERE scope_id = $1 AND id = $2 AND ($5::bigint IS NULL OR epoch = $5::bigint)`,
    [scopeId, id, state, lastError, expectedEpoch ?? null],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * 登记「写入结果未知」：推迟下一次自动处理。
 *
 * 写请求的结果未知时不能盲目重发，因此这类操作必须先经过只读核对，
 * 核对不通过就一直停在这里等待人工介入；推迟时间避免 worker 热循环。
 */
export async function deferOperation(
  client: QueryClient,
  scopeId: string,
  id: string,
  deferMs: number,
  lastError: string | null,
  expectedEpoch?: number,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE operation
        SET state = 'unknown_outcome', last_error = $3,
            next_attempt_at = now() + ($4 || ' milliseconds')::interval, updated_at = now()
      WHERE scope_id = $1 AND id = $2
        AND ($5::bigint IS NULL OR epoch = $5::bigint)`,
    [scopeId, id, lastError, String(deferMs), expectedEpoch ?? null],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * 领取操作租约。
 *
 * 领取即开启新的 epoch：epoch 是这一轮推进的栅栏令牌。
 * 后续所有状态写入都必须带上本轮 epoch，迟到的旧 epoch 写入会被数据库直接忽略。
 */
export async function claimOperationLease(
  client: QueryClient,
  scopeId: string,
  id: string,
  leaseMs: number,
): Promise<OperationRow | null> {
  const { rows } = await client.query<OperationRow>(
    `UPDATE operation
        SET lease_until = now() + ($3 || ' milliseconds')::interval,
            attempt = attempt + 1,
            epoch = epoch + 1,
            updated_at = now()
      WHERE scope_id = $1 AND id = $2
        AND (lease_until IS NULL OR lease_until < now())
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        AND state IN ('pending', 'in_progress', 'unknown_outcome')
      RETURNING *`,
    [scopeId, id, String(leaseMs)],
  );
  return rows[0] ?? null;
}

/**
 * 释放租约。
 *
 * 必须带上本轮 epoch：迟到的旧 worker 不能把新 worker 的租约清掉，
 * 否则第二个 worker 会在新 worker 还在处理时再次领取同一操作。
 */
export async function releaseOperationLease(
  client: QueryClient,
  scopeId: string,
  id: string,
  expectedEpoch?: number,
): Promise<void> {
  await client.query(
    `UPDATE operation SET lease_until = NULL, updated_at = now()
      WHERE scope_id = $1 AND id = $2
        AND ($3::bigint IS NULL OR epoch = $3::bigint)`,
    [scopeId, id, expectedEpoch ?? null],
  );
}

export async function listClaimableOperations(
  client: QueryClient,
  scopeId: string,
  limit: number,
): Promise<OperationRow[]> {
  const { rows } = await client.query<OperationRow>(
    `SELECT * FROM operation
      WHERE scope_id = $1
        AND state IN ('pending', 'in_progress', 'unknown_outcome')
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        AND (lease_until IS NULL OR lease_until < now())
      ORDER BY created_at
      LIMIT $2`,
    [scopeId, limit],
  );
  return rows;
}

/**
 * 找出某个知识版本在途的上传/解析/重建操作。
 *
 * 撤回时用它取消在途操作：撤回是终态，在途的 worker 必须停下来，
 * 否则迟到的完成分支会把已撤回的版本改回 ready。
 */
export async function findInFlightOperationsForKnowledge(
  client: QueryClient,
  scopeId: string,
  knowledgeId: string,
  version: string,
): Promise<OperationRow[]> {
  const { rows } = await client.query<OperationRow>(
    `SELECT * FROM operation
      WHERE scope_id = $1
        AND kind IN ('document.upload', 'document.parse', 'document.reindex')
        AND state IN ('pending', 'in_progress', 'unknown_outcome')
        AND result->>'knowledgeId' = $2
        AND result->>'knowledgeVersion' = $3
      ORDER BY created_at`,
    [scopeId, knowledgeId, version],
  );
  return rows;
}

/**
 * 取消在途操作。
 *
 * 取消会递增 epoch：正在跑的那一轮 worker 的后续写入全部命中 0 行，
 * 它随即回滚，不会再把已撤回的资源改回可检索状态。
 */
export async function cancelOperations(
  client: QueryClient,
  scopeId: string,
  ids: string[],
  reason: string,
): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }
  const { rowCount } = await client.query(
    `UPDATE operation
        SET state = 'cancelled', epoch = epoch + 1, lease_until = NULL,
            next_attempt_at = NULL, last_error = $3, updated_at = now()
      WHERE scope_id = $1 AND id = ANY($2::uuid[])
        AND state IN ('pending', 'in_progress', 'unknown_outcome')`,
    [scopeId, ids, reason],
  );
  return rowCount ?? 0;
}

export function toOperationView(row: OperationRow): OperationView {
  return {
    operation_id: row.id,
    kind: row.kind,
    state: row.state,
    resource_id: row.resource_id,
    remote_id: row.remote_id,
    attempt: row.attempt,
    last_error: row.last_error,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
