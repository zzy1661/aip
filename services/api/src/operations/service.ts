import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../db/uow.js';
import type { RagFlowAdapter } from '../ragflow/adapter.js';
import { RagFlowBusinessError, RagFlowProtocolError, RagFlowUnavailableError } from '../ragflow/errors.js';
import type { FileStore } from '../files/store.js';
import { hashObject, newId } from '../util/hash.js';
import * as opsRepo from './repository.js';
import * as knowledgeRepo from '../knowledge/repository.js';

async function findSourceFile(
  client: PoolClient,
  scopeId: string,
  fileId: string,
  version: string,
): Promise<{ name: string; mime: string; storage_key: string } | null> {
  const { rows } = await client.query<{ name: string; mime: string; storage_key: string }>(
    `SELECT name, mime, storage_key FROM source_file_revision
      WHERE scope_id = $1 AND id = $2 AND version = $3`,
    [scopeId, fileId, version],
  );
  return rows[0] ?? null;
}

export type OperationKind =
  | 'knowledge_base.create'
  | 'document.upload'
  | 'document.parse'
  | 'document.reindex'
  | 'knowledge.withdraw';

export interface OperationPayload {
  kind: OperationKind;
  scopeId: string;
  subject: string;
  idempotencyKey: string;
  request: Record<string, unknown>;
}

export interface OperationResult {
  operationId: string;
  state: string;
  resourceId: string | null;
  remoteId: string | null;
  lastError: string | null;
}

/** 操作载荷中的阶段信息，写操作响应丢失后据此继续，不重复提交。 */
interface OperationProgress {
  stage: string;
  subject?: string;
  kbId?: string;
  datasetId?: string;
  documentId?: string;
  knowledgeId?: string;
  knowledgeVersion?: string;
  sourceFileId?: string;
  sourceFileVersion?: string;
  datasetName?: string;
  /**
   * 写请求是否已经送达上游但结果不可知。
   *
   * 一旦置位，后续推进只允许只读核对，禁止重发同一个写请求。
   */
  outcomeUnknown?: boolean;
  /** 操作登记时间，用于判断解析是否超过截止时间。 */
  createdAt?: Date;
}

export interface OperationsDeps {
  pool: Pool;
  ragflow: RagFlowAdapter;
  files: FileStore;
  parseDeadlineMs: number;
  parserHash: string;
  embeddingRevision: string;
  /** 写入结果未知后的冷静期：期间不自动重发写请求。 */
  unknownOutcomeDeferMs?: number;
  /** unknown_outcome 自动核对的最长间隔，避免长期热循环。 */
  unknownOutcomeMaxDeferMs?: number;
  /** unknown_outcome 自动核对的次数上限，超过后停止自动核对，转人工处理。 */
  unknownOutcomeMaxAttempts?: number;
  /**
   * 操作租约时长。
   *
   * 必须大于单轮推进的最坏耗时（只读总预算 + 上传超时 + 数据库开销），
   * 否则处理途中租约到期会被第二个 worker 重新领取，同一操作被并发推进。
   */
  leaseMs?: number;
  /** 瞬时故障后的重试退避基数。 */
  retryBackoffMs?: number;
  /** 瞬时故障后的重试退避上限。 */
  retryBackoffMaxMs?: number;
}

const DEFAULT_UNKNOWN_OUTCOME_DEFER_MS = 60_000;
const DEFAULT_UNKNOWN_OUTCOME_MAX_DEFER_MS = 3_600_000;
const DEFAULT_UNKNOWN_OUTCOME_MAX_ATTEMPTS = 8;
/**
 * 停止自动核对后把下一次自动核对推到足够远的未来。
 *
 * 操作保持 unknown_outcome 终态可见，但不会再被 worker 自动领取，
 * 只能由人工核对上游结果后处置。
 */
const MANUAL_REVIEW_PARK_MS = 100 * 365 * 24 * 60 * 60 * 1000;
const DEFAULT_LEASE_MS = 180_000;
const DEFAULT_RETRY_BACKOFF_MS = 5_000;
const DEFAULT_RETRY_BACKOFF_MAX_MS = 300_000;

/**
 * 本轮推进已被更新的 epoch 取代。
 *
 * 抛出它意味着「另一个 worker 已经接手这个操作」：本轮不得再写任何状态，
 * 事务会整体回滚，资源状态也不会被迟到的一方覆盖。
 */
class StaleEpochError extends Error {
  constructor(readonly operationId: string) {
    super(`operation ${operationId} was advanced by a newer epoch`);
    this.name = 'StaleEpochError';
  }
}

interface FailureDecision {
  /** 操作终态：failed / in_progress / unknown_outcome。 */
  state: 'failed' | 'in_progress' | 'unknown_outcome';
  message: string;
  /** 资源状态回落；null 表示保持现状（瞬时故障不应把资源判死）。 */
  resourceStatus: 'failed' | 'unknown_outcome' | null;
}

/**
 * 把上游故障翻译成操作终态。
 *
 * 判定依据只有一条：**上游有没有给出响应**。
 * - 给了响应（业务失败、协议不符、凭据被拒、5xx）：结论是确定的，
 *   直接终结为 failed 并回落资源状态，重试不会改变结论；
 * - 没给响应：请求可能已经送达上游。
 *   连接阶段失败（not_delivered）可以安全重发；
 *   中途失败（delivered_unknown）对写请求必须转入 unknown_outcome 并只做只读核对，
 *   对只读请求可以安全重试。
 */
function classifyFailure(error: unknown): FailureDecision {
  if (error instanceof RagFlowBusinessError) {
    return {
      state: 'failed',
      message: `upstream business failure code=${error.upstreamCode}`,
      resourceStatus: 'failed',
    };
  }
  if (error instanceof RagFlowProtocolError) {
    return {
      state: 'failed',
      message: 'upstream response did not match the fixed contract',
      resourceStatus: 'failed',
    };
  }
  if (error instanceof RagFlowUnavailableError) {
    if (error.kind === 'credential_rejected') {
      return {
        state: 'failed',
        message: 'upstream rejected the platform credential',
        resourceStatus: 'failed',
      };
    }
    if (error.kind === 'not_delivered') {
      // 请求确定没有送达上游，重发安全。
      return {
        state: 'in_progress',
        message: `upstream is temporarily unavailable: ${error.reason}`,
        resourceStatus: null,
      };
    }
    if (error.kind === 'delivered_unknown') {
      if (error.writeAttempt) {
        // 写请求的结果不可知：远端可能已经生效，禁止盲重发。
        return {
          state: 'unknown_outcome',
          message: 'upstream write response was not confirmed',
          resourceStatus: 'unknown_outcome',
        };
      }
      return {
        state: 'in_progress',
        message: `upstream is temporarily unavailable: ${error.reason}`,
        resourceStatus: null,
      };
    }
    if (error.writeAttempt) {
      // 上游回了 5xx：写请求的结论由上游给出，是确定性的失败。
      return {
        state: 'failed',
        message: `upstream rejected the write: ${error.reason}`,
        resourceStatus: 'failed',
      };
    }
    return {
      state: 'in_progress',
      message: `upstream is temporarily unavailable: ${error.reason}`,
      resourceStatus: null,
    };
  }
  return { state: 'failed', message: 'unexpected upstream failure', resourceStatus: 'failed' };
}

export function createOperationsService(deps: OperationsDeps) {
  const { pool, ragflow, files } = deps;
  const unknownOutcomeDeferMs = deps.unknownOutcomeDeferMs ?? DEFAULT_UNKNOWN_OUTCOME_DEFER_MS;
  const unknownOutcomeMaxDeferMs =
    deps.unknownOutcomeMaxDeferMs ?? DEFAULT_UNKNOWN_OUTCOME_MAX_DEFER_MS;
  const unknownOutcomeMaxAttempts =
    deps.unknownOutcomeMaxAttempts ?? DEFAULT_UNKNOWN_OUTCOME_MAX_ATTEMPTS;
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const retryBackoffMs = deps.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const retryBackoffMaxMs = deps.retryBackoffMaxMs ?? DEFAULT_RETRY_BACKOFF_MAX_MS;

  async function createOperation(
    client: PoolClient,
    payload: OperationPayload,
    resourceId: string | null,
  ): Promise<string> {
    const id = newId();
    await opsRepo.insertOperation(client, {
      scopeId: payload.scopeId,
      id,
      subject: payload.subject,
      kind: payload.kind,
      idempotencyKey: payload.idempotencyKey,
      requestHash: hashObject(payload.request),
      state: 'pending',
      resourceId,
    });
    return id;
  }

  async function readProgress(
    client: PoolClient,
    scopeId: string,
    operationId: string,
  ): Promise<OperationProgress> {
    const row = await opsRepo.findOperation(client, scopeId, operationId);
    const result = (row?.result ?? {}) as Partial<OperationProgress>;
    return {
      stage: result.stage ?? 'init',
      subject: row?.subject,
      createdAt: row?.created_at,
      kbId: result.kbId,
      datasetId: result.datasetId,
      documentId: result.documentId,
      knowledgeId: result.knowledgeId,
      knowledgeVersion: result.knowledgeVersion,
      sourceFileId: result.sourceFileId,
      sourceFileVersion: result.sourceFileVersion,
      datasetName: result.datasetName,
      outcomeUnknown: result.outcomeUnknown === true,
    };
  }

  /**
   * 写入操作进度。
   *
   * 带 epoch 时这是一次栅栏写入：epoch 已经被更新的 worker 取代时，
   * 更新命中 0 行并抛 StaleEpochError，事务整体回滚。
   */
  async function writeProgress(
    client: PoolClient,
    scopeId: string,
    operationId: string,
    progress: OperationProgress,
    expectedEpoch?: number,
  ): Promise<void> {
    const { rowCount } = await client.query(
      `UPDATE operation SET result = $3::jsonb, updated_at = now()
        WHERE scope_id = $1 AND id = $2
          AND ($4::bigint IS NULL OR epoch = $4::bigint)`,
      [scopeId, operationId, JSON.stringify(progress), expectedEpoch ?? null],
    );
    if ((rowCount ?? 0) === 0) {
      throw new StaleEpochError(operationId);
    }
  }

  /** 栅栏写入操作状态；命中 0 行说明本轮已被更新的 epoch 取代。 */
  async function fenceOperationState(
    client: PoolClient,
    scopeId: string,
    operationId: string,
    epoch: number,
    state: string,
    lastError: string | null,
  ): Promise<void> {
    const updated = await opsRepo.setOperationState(
      client,
      scopeId,
      operationId,
      state,
      lastError,
      epoch,
    );
    if (!updated) {
      throw new StaleEpochError(operationId);
    }
  }

  /**
   * 瞬时故障后的退避重试。
   *
   * 操作保持 in_progress，不终结流水线；退避避免上游持续不可用时 worker 热循环。
   */
  async function retryOperation(
    client: PoolClient,
    scopeId: string,
    operationId: string,
    epoch: number,
    message: string,
    attempt: number,
  ): Promise<void> {
    const delay = Math.min(retryBackoffMs * 2 ** Math.max(0, attempt - 1), retryBackoffMaxMs);
    const { rowCount } = await client.query(
      `UPDATE operation
          SET state = 'in_progress', last_error = $4,
              next_attempt_at = now() + ($5 || ' milliseconds')::interval, updated_at = now()
        WHERE scope_id = $1 AND id = $2 AND epoch = $3::bigint`,
      [scopeId, operationId, epoch, message, String(delay)],
    );
    if ((rowCount ?? 0) === 0) {
      throw new StaleEpochError(operationId);
    }
  }

  /** unknown_outcome 的自动核对间隔按尝试次数指数退避，并设上限。 */
  function unknownOutcomeDelay(attempt: number): number {
    const scaled = unknownOutcomeDeferMs * 2 ** Math.max(0, attempt - 1);
    return Math.min(scaled, unknownOutcomeMaxDeferMs);
  }

  /**
   * 资源状态回落。
   *
   * 操作终态与资源状态必须一致：否则知识库会永远停在 creating、
   * 知识版本永远停在 parse_queued，用户看不到真实失败原因。
   */
  async function rollbackResourceStatus(
    client: PoolClient,
    scopeId: string,
    progress: OperationProgress,
    status: 'failed' | 'unknown_outcome',
  ): Promise<void> {
    if (progress.kbId) {
      await knowledgeRepo.updateKnowledgeBase(client, scopeId, progress.kbId, { status });
    }
    if (progress.knowledgeId && progress.knowledgeVersion) {
      await knowledgeRepo.updateKnowledgeState(
        client,
        scopeId,
        progress.knowledgeId,
        progress.knowledgeVersion,
        { status },
      );
    }
  }

  /**
   * 推进一个待处理操作。
   *
   * 写操作不做盲重试：只有确认过远端结果的阶段才会被跳过。
   * 本轮推进以领取时的 epoch 为栅栏令牌，迟到的旧 epoch 写入一律被忽略。
   */
  async function advance(
    operationId: string,
    scopeId: string,
  ): Promise<OperationResult> {
    const claimed = await withTransaction(pool, async (client) =>
      opsRepo.claimOperationLease(client, scopeId, operationId, leaseMs),
    );
    if (!claimed) {
      const current = await opsRepo.findOperation(pool, scopeId, operationId);
      if (!current) throw new Error(`operation ${operationId} not found`);
      return {
        operationId,
        state: current.state,
        resourceId: current.resource_id,
        remoteId: current.remote_id,
        lastError: current.last_error,
      };
    }

    const epoch = claimed.epoch;
    const progress = await withTransaction(pool, (client) =>
      readProgress(client, scopeId, operationId),
    );

    try {
      switch (claimed.kind) {
        case 'knowledge_base.create':
          return await advanceKnowledgeBaseCreate(scopeId, operationId, epoch, progress);
        case 'document.upload':
          return await advanceDocumentUpload(scopeId, operationId, epoch, progress);
        case 'document.parse':
          return await advanceDocumentParse(scopeId, operationId, epoch, progress);
        case 'document.reindex':
          return await advanceDocumentReindex(scopeId, operationId, epoch, progress);
        case 'knowledge.withdraw':
          return await advanceKnowledgeWithdraw(scopeId, operationId, epoch, progress);
        default:
          throw new Error(`unsupported operation kind ${claimed.kind}`);
      }
    } catch (error) {
      return await handleFailure(error, scopeId, operationId, epoch, progress, claimed.attempt);
    } finally {
      // 本轮处理结束即释放租约：未达终态的操作要能被下一轮立即接管，
      // 否则轮询间隔会被租约时长悄悄放大。释放必须带 epoch，
      // 否则迟到的旧 worker 会把新 worker 的租约清掉。
      await withTransaction(pool, (client) =>
        opsRepo.releaseOperationLease(client, scopeId, operationId, epoch),
      );
    }
  }

  async function currentResult(
    scopeId: string,
    operationId: string,
    fallbackState: string,
    lastError: string | null,
  ): Promise<OperationResult> {
    const current = await opsRepo.findOperation(pool, scopeId, operationId);
    return {
      operationId,
      state: current?.state ?? fallbackState,
      resourceId: current?.resource_id ?? null,
      remoteId: current?.remote_id ?? null,
      lastError: current?.last_error ?? lastError,
    };
  }

  async function handleFailure(
    error: unknown,
    scopeId: string,
    operationId: string,
    epoch: number,
    progress: OperationProgress,
    attempt: number,
  ): Promise<OperationResult> {
    if (error instanceof StaleEpochError) {
      // 已被更新的 epoch 取代：本轮不写任何状态，直接返回当前事实。
      return currentResult(scopeId, operationId, 'in_progress', null);
    }

    const failure = classifyFailure(error);
    try {
      await withTransaction(pool, async (client) => {
        if (failure.state === 'unknown_outcome') {
          // 先落「结果未知」标记：它禁止后续推进重发同一个写请求。
          await writeProgress(
            client,
            scopeId,
            operationId,
            { ...progress, outcomeUnknown: true },
            epoch,
          );
          // 自动核对有次数上限：超过上限后不再自动重试，
          // 操作停在 unknown_outcome 等人工核对上游结果，避免无限循环。
          const capped = attempt >= unknownOutcomeMaxAttempts;
          const deferred = await opsRepo.deferOperation(
            client,
            scopeId,
            operationId,
            capped ? MANUAL_REVIEW_PARK_MS : unknownOutcomeDelay(attempt),
            capped
              ? `${failure.message}; automatic verification stopped after ${attempt} attempts, manual review required`
              : failure.message,
            epoch,
          );
          if (!deferred) throw new StaleEpochError(operationId);
        } else if (failure.state === 'in_progress') {
          await retryOperation(
            client,
            scopeId,
            operationId,
            epoch,
            failure.message,
            attempt,
          );
        } else {
          await fenceOperationState(
            client,
            scopeId,
            operationId,
            epoch,
            failure.state,
            failure.message,
          );
        }
        if (failure.resourceStatus) {
          await rollbackResourceStatus(client, scopeId, progress, failure.resourceStatus);
        }
      });
    } catch (writeError) {
      if (writeError instanceof StaleEpochError) {
        return currentResult(scopeId, operationId, 'in_progress', null);
      }
      throw writeError;
    }

    return {
      operationId,
      state: failure.state,
      resourceId: progress.knowledgeId ?? progress.kbId ?? null,
      remoteId: progress.documentId ?? progress.datasetId ?? null,
      lastError: failure.message,
    };
  }

  async function advanceKnowledgeBaseCreate(
    scopeId: string,
    operationId: string,
    epoch: number,
    progress: OperationProgress,
  ): Promise<OperationResult> {
    if (progress.datasetId) {
      await withTransaction(pool, (client) =>
        fenceOperationState(client, scopeId, operationId, epoch, 'succeeded', null),
      );
      return { operationId, state: 'succeeded', resourceId: progress.kbId ?? null, remoteId: progress.datasetId, lastError: null };
    }

    // 结果未知时只做只读核对：创建请求可能已经在上游生效，重发会造出重复数据集。
    if (progress.outcomeUnknown) {
      const existing = await ragflow.listDatasetsByName(progress.datasetName!);
      if (existing.length === 1) {
        await withTransaction(pool, async (client) => {
          await fenceOperationState(client, scopeId, operationId, epoch, 'succeeded', null);
          const updated = await opsRepo.setOperationRemoteId(
            client,
            scopeId,
            operationId,
            existing[0]!.id,
            'succeeded',
            epoch,
          );
          if (!updated) throw new StaleEpochError(operationId);
          await writeProgress(
            client,
            scopeId,
            operationId,
            { ...progress, stage: 'dataset_created', datasetId: existing[0]!.id },
            epoch,
          );
          await knowledgeRepo.updateKnowledgeBase(client, scopeId, progress.kbId!, {
            status: 'ready',
            ragflowDatasetId: existing[0]!.id,
          });
        });
        return { operationId, state: 'succeeded', resourceId: progress.kbId ?? null, remoteId: existing[0]!.id, lastError: null };
      }
      const message =
        existing.length > 1
          ? 'multiple upstream datasets match the stable name; manual check required'
          : 'upstream dataset creation outcome is unknown; manual check required';
      await withTransaction(pool, async (client) => {
        const deferred = await opsRepo.deferOperation(
          client,
          scopeId,
          operationId,
          unknownOutcomeDelay(1),
          message,
          epoch,
        );
        if (!deferred) throw new StaleEpochError(operationId);
      });
      return { operationId, state: 'unknown_outcome', resourceId: progress.kbId ?? null, remoteId: null, lastError: message };
    }

    // 请求确定没有送达上游时重发是安全的；这里只记录尝试痕迹。
    await withTransaction(pool, (client) =>
      writeProgress(
        client,
        scopeId,
        operationId,
        { ...progress, stage: 'dataset_create_attempted' },
        epoch,
      ),
    );
    const dataset = await ragflow.createDataset({
      name: progress.datasetName!,
      description: '',
    });
    await withTransaction(pool, async (client) => {
      await fenceOperationState(client, scopeId, operationId, epoch, 'succeeded', null);
      const updated = await opsRepo.setOperationRemoteId(
        client,
        scopeId,
        operationId,
        dataset.datasetId,
        'succeeded',
        epoch,
      );
      if (!updated) throw new StaleEpochError(operationId);
      await writeProgress(
        client,
        scopeId,
        operationId,
        { ...progress, stage: 'dataset_created', datasetId: dataset.datasetId },
        epoch,
      );
      await knowledgeRepo.updateKnowledgeBase(client, scopeId, progress.kbId!, {
        status: 'ready',
        ragflowDatasetId: dataset.datasetId,
      });
    });
    return { operationId, state: 'succeeded', resourceId: progress.kbId ?? null, remoteId: dataset.datasetId, lastError: null };
  }

  async function advanceDocumentUpload(
    scopeId: string,
    operationId: string,
    epoch: number,
    progress: OperationProgress,
  ): Promise<OperationResult> {
    if (!progress.datasetId) {
      throw new Error('document upload operation has no dataset id');
    }
    if (progress.stage === 'parse_started' && progress.documentId) {
      await withTransaction(pool, (client) =>
        fenceOperationState(client, scopeId, operationId, epoch, 'succeeded', null),
      );
      return { operationId, state: 'succeeded', resourceId: progress.knowledgeId ?? null, remoteId: progress.documentId, lastError: null };
    }

    if (!progress.documentId) {
      if (!progress.sourceFileId || !progress.sourceFileVersion) {
        throw new Error('document upload operation is missing the source file identity');
      }
      const source = await withTransaction(pool, (client) =>
        findSourceFile(client, scopeId, progress.sourceFileId!, progress.sourceFileVersion!),
      );
      if (!source) {
        const message = 'source file revision is missing';
        await withTransaction(pool, (client) =>
          fenceOperationState(client, scopeId, operationId, epoch, 'failed', message),
        );
        return { operationId, state: 'failed', resourceId: progress.knowledgeId ?? null, remoteId: null, lastError: message };
      }

      if (progress.outcomeUnknown) {
        // 上传结果未知：按文件名只读核对上游，唯一命中才认领，绝不重新上传。
        const documents = await ragflow.listDocuments(progress.datasetId!);
        const matches = documents.filter((document) => document.name === source.name);
        if (matches.length !== 1) {
          const message =
            matches.length === 0
              ? 'upstream upload outcome is unknown; manual check required'
              : 'multiple upstream documents match the file name; manual check required';
          await withTransaction(pool, async (client) => {
            const deferred = await opsRepo.deferOperation(
              client,
              scopeId,
              operationId,
              unknownOutcomeDelay(1),
              message,
              epoch,
            );
            if (!deferred) throw new StaleEpochError(operationId);
          });
          return {
            operationId,
            state: 'unknown_outcome',
            resourceId: progress.knowledgeId ?? null,
            remoteId: null,
            lastError: message,
          };
        }
        await withTransaction(pool, async (client) => {
          const updated = await opsRepo.setOperationRemoteId(
            client,
            scopeId,
            operationId,
            matches[0]!.id,
            'in_progress',
            epoch,
          );
          if (!updated) throw new StaleEpochError(operationId);
          await writeProgress(
            client,
            scopeId,
            operationId,
            { ...progress, stage: 'uploaded', documentId: matches[0]!.id },
            epoch,
          );
        });
        progress = { ...progress, stage: 'uploaded', documentId: matches[0]!.id };
      } else {
        const content = await files.read(source.storage_key);
        await withTransaction(pool, (client) =>
          writeProgress(
            client,
            scopeId,
            operationId,
            { ...progress, stage: 'upload_attempted' },
            epoch,
          ),
        );
        const uploaded = await ragflow.uploadDocument({
          datasetId: progress.datasetId!,
          filename: source.name,
          contentType: source.mime,
          content,
        });
        await withTransaction(pool, async (client) => {
          const updated = await opsRepo.setOperationRemoteId(
            client,
            scopeId,
            operationId,
            uploaded.documentId,
            'in_progress',
            epoch,
          );
          if (!updated) throw new StaleEpochError(operationId);
          await writeProgress(
            client,
            scopeId,
            operationId,
            { ...progress, stage: 'uploaded', documentId: uploaded.documentId },
            epoch,
          );
        });
        progress = { ...progress, stage: 'uploaded', documentId: uploaded.documentId };
      }
    }

    if (progress.outcomeUnknown) {
      // 解析启动请求的结果未知：先只读确认上游是否已经在解析，避免重复触发解析。
      const status = await ragflow.getDocumentStatus({
        datasetId: progress.datasetId!,
        documentId: progress.documentId!,
      });
      if (status.run === 'UNSTART') {
        await ragflow.startParse({
          datasetId: progress.datasetId!,
          documentIds: [progress.documentId!],
        });
      }
    } else {
      await withTransaction(pool, (client) =>
        writeProgress(client, scopeId, operationId, { ...progress, stage: 'parse_attempted' }, epoch),
      );
      await ragflow.startParse({
        datasetId: progress.datasetId!,
        documentIds: [progress.documentId!],
      });
    }
    // 解析是独立的长时操作，登记为单独的操作项由 worker 轮询。
    await withTransaction(pool, async (client) => {
      await fenceOperationState(client, scopeId, operationId, epoch, 'succeeded', null);
      const parseOperationId = await createOperation(
        client,
        {
          kind: 'document.parse',
          scopeId,
          subject: progress.subject ?? 'system',
          idempotencyKey: `parse:${progress.knowledgeId}:${progress.knowledgeVersion}`,
          request: { knowledgeId: progress.knowledgeId, version: progress.knowledgeVersion },
        },
        progress.knowledgeId ?? null,
      );
      await writeProgress(
        client,
        scopeId,
        parseOperationId,
        { ...progress, stage: 'parse_polling' },
      );
      await knowledgeRepo.updateKnowledgeState(
        client,
        scopeId,
        progress.knowledgeId!,
        progress.knowledgeVersion!,
        { status: 'parsing' },
      );
    });
    return { operationId, state: 'succeeded', resourceId: progress.knowledgeId ?? null, remoteId: progress.documentId ?? null, lastError: null };
  }

  async function advanceDocumentParse(
    scopeId: string,
    operationId: string,
    epoch: number,
    progress: OperationProgress,
  ): Promise<OperationResult> {
    if (!progress.datasetId || !progress.documentId) {
      throw new Error('parse operation is missing the remote document identity');
    }

    // 解析有截止时间：超过截止仍未完成就进入终态失败，停止自动轮询，
    // 并把知识版本置为 failed，让用户看到明确状态而不是一直「解析中」。
    if (progress.createdAt) {
      const elapsed = Date.now() - progress.createdAt.getTime();
      if (elapsed > deps.parseDeadlineMs) {
        const message = `parse deadline exceeded after ${Math.round(elapsed / 1000)}s`;
        await withTransaction(pool, async (client) => {
          await fenceOperationState(client, scopeId, operationId, epoch, 'failed', message);
          await knowledgeRepo.updateKnowledgeState(
            client,
            scopeId,
            progress.knowledgeId!,
            progress.knowledgeVersion!,
            { status: 'failed' },
          );
        });
        return {
          operationId,
          state: 'failed',
          resourceId: progress.knowledgeId ?? null,
          remoteId: progress.documentId,
          lastError: message,
        };
      }
    }

    const status = await ragflow.getDocumentStatus({
      datasetId: progress.datasetId,
      documentId: progress.documentId,
    });

    if (status.run === 'DONE') {
      const chunkCount = status.chunk_count ?? 0;
      const progressComplete = status.progress !== null && status.progress >= 1;
      if (progressComplete && chunkCount > 0) {
        await withTransaction(pool, async (client) => {
          await fenceOperationState(client, scopeId, operationId, epoch, 'succeeded', null);
          await markKnowledgeReady(client, scopeId, progress, chunkCount);
        });
        return { operationId, state: 'succeeded', resourceId: progress.knowledgeId ?? null, remoteId: progress.documentId, lastError: null };
      }
      if (chunkCount === 0) {
        const message = 'upstream reported DONE with zero chunks';
        await withTransaction(pool, async (client) => {
          await fenceOperationState(client, scopeId, operationId, epoch, 'succeeded', message);
          await knowledgeRepo.updateKnowledgeState(
            client,
            scopeId,
            progress.knowledgeId!,
            progress.knowledgeVersion!,
            { status: 'empty' },
          );
        });
        return { operationId, state: 'succeeded', resourceId: progress.knowledgeId ?? null, remoteId: progress.documentId, lastError: message };
      }
      const message = 'upstream reported DONE before progress completed';
      await withTransaction(pool, (client) =>
        fenceOperationState(client, scopeId, operationId, epoch, 'in_progress', message),
      );
      return { operationId, state: 'in_progress', resourceId: progress.knowledgeId ?? null, remoteId: progress.documentId, lastError: message };
    }

    if (status.run === 'FAIL') {
      // 只保留错误分类，不回显上游原文：progress_msg 可能带出上游内部细节。
      const message = 'parse failed upstream';
      await withTransaction(pool, async (client) => {
        await fenceOperationState(client, scopeId, operationId, epoch, 'failed', message);
        await knowledgeRepo.updateKnowledgeState(
          client,
          scopeId,
          progress.knowledgeId!,
          progress.knowledgeVersion!,
          { status: 'failed' },
        );
      });
      return { operationId, state: 'failed', resourceId: progress.knowledgeId ?? null, remoteId: progress.documentId, lastError: message };
    }

    if (status.run === 'CANCEL') {
      const message = 'parse cancelled';
      await withTransaction(pool, async (client) => {
        await fenceOperationState(client, scopeId, operationId, epoch, 'failed', message);
        await knowledgeRepo.updateKnowledgeState(
          client,
          scopeId,
          progress.knowledgeId!,
          progress.knowledgeVersion!,
          { status: 'failed' },
        );
      });
      return { operationId, state: 'failed', resourceId: progress.knowledgeId ?? null, remoteId: progress.documentId, lastError: message };
    }

    await withTransaction(pool, (client) =>
      fenceOperationState(client, scopeId, operationId, epoch, 'in_progress', null),
    );
    return { operationId, state: 'in_progress', resourceId: progress.knowledgeId ?? null, remoteId: progress.documentId, lastError: null };
  }

  /**
   * 索引重建：重新解析同一个上游文档，产生新的索引版本。
   *
   * 旧索引版本与旧映射不删除，旧 evidence 仍然指向自己的 index_revision 可读；
   * 新索引版本建立新的映射行，检索使用最新索引版本。
   */
  async function advanceDocumentReindex(
    scopeId: string,
    operationId: string,
    epoch: number,
    progress: OperationProgress,
  ): Promise<OperationResult> {
    if (!progress.datasetId || !progress.documentId) {
      throw new Error('reindex operation is missing the remote document identity');
    }

    if (progress.outcomeUnknown) {
      // 启动解析的结果未知：先只读确认上游状态，确认还没开始解析才允许启动，
      // 避免重复触发重建。
      const observed = await ragflow.getDocumentStatus({
        datasetId: progress.datasetId,
        documentId: progress.documentId,
      });
      if (observed.run === 'UNSTART') {
        await ragflow.startParse({
          datasetId: progress.datasetId,
          documentIds: [progress.documentId],
        });
      }
    } else if (progress.stage !== 'reindex_started') {
      // 启动解析成功后才记阶段：明确「未送达」的失败可以安全重发，
      // 结果未知的失败走上面的只读核对分支，不会盲重发。
      await ragflow.startParse({
        datasetId: progress.datasetId,
        documentIds: [progress.documentId],
      });
      await withTransaction(pool, (client) =>
        writeProgress(
          client,
          scopeId,
          operationId,
          { ...progress, stage: 'reindex_started' },
          epoch,
        ),
      );
    }

    const status = await ragflow.getDocumentStatus({
      datasetId: progress.datasetId,
      documentId: progress.documentId,
    });
    if (status.run === 'FAIL' || status.run === 'CANCEL') {
      const message = status.run === 'FAIL' ? 'reindex failed upstream' : 'reindex cancelled';
      await withTransaction(pool, async (client) => {
        await fenceOperationState(client, scopeId, operationId, epoch, 'failed', message);
        await knowledgeRepo.updateKnowledgeState(
          client,
          scopeId,
          progress.knowledgeId!,
          progress.knowledgeVersion!,
          { status: 'failed' },
        );
      });
      return {
        operationId,
        state: 'failed',
        resourceId: progress.knowledgeId ?? null,
        remoteId: progress.documentId,
        lastError: message,
      };
    }
    if (status.run !== 'DONE') {
      await withTransaction(pool, (client) =>
        fenceOperationState(client, scopeId, operationId, epoch, 'in_progress', null),
      );
      return {
        operationId,
        state: 'in_progress',
        resourceId: progress.knowledgeId ?? null,
        remoteId: progress.documentId,
        lastError: null,
      };
    }

    const chunkCount = status.chunk_count ?? 0;
    const message =
      status.progress !== null && status.progress >= 1 && chunkCount > 0
        ? null
        : 'upstream reported DONE before the rebuilt index was complete';
    await withTransaction(pool, async (client) => {
      await fenceOperationState(
        client,
        scopeId,
        operationId,
        epoch,
        message ? 'in_progress' : 'succeeded',
        message,
      );
      if (!message) {
        await markKnowledgeReady(client, scopeId, progress, chunkCount);
      }
    });
    return {
      operationId,
      state: message ? 'in_progress' : 'succeeded',
      resourceId: progress.knowledgeId ?? null,
      remoteId: progress.documentId,
      lastError: message,
    };
  }

  async function advanceKnowledgeWithdraw(
    scopeId: string,
    operationId: string,
    epoch: number,
    progress: OperationProgress,
  ): Promise<OperationResult> {
    if (!progress.datasetId || !progress.documentId) {
      await withTransaction(pool, (client) =>
        fenceOperationState(client, scopeId, operationId, epoch, 'succeeded', null),
      );
      return { operationId, state: 'succeeded', resourceId: progress.knowledgeId ?? null, remoteId: null, lastError: null };
    }
    // 删除是写操作：先只读确认文档是否还在，在才删，避免结果未知时盲目重发。
    const documents = await ragflow.listDocuments(progress.datasetId);
    const stillPresent = documents.some((document) => document.id === progress.documentId);
    if (stillPresent) {
      await ragflow.deleteDocument({
        datasetId: progress.datasetId,
        documentId: progress.documentId,
      });
    }

    await withTransaction(pool, (client) =>
      fenceOperationState(client, scopeId, operationId, epoch, 'succeeded', null),
    );
    return { operationId, state: 'succeeded', resourceId: progress.knowledgeId ?? null, remoteId: progress.documentId, lastError: null };
  }

  /** 解析完成后登记索引版本并把知识版本置为可检索。 */
  async function markKnowledgeReady(
    client: PoolClient,
    scopeId: string,
    progress: OperationProgress,
    chunkCount: number,
  ): Promise<void> {
    const knowledge = await knowledgeRepo.findKnowledgeRevision(
      client,
      scopeId,
      progress.knowledgeId!,
      progress.knowledgeVersion!,
    );
    if (!knowledge) {
      throw new Error('knowledge revision disappeared during parse completion');
    }
    const indexRevisionId = newId();
    await knowledgeRepo.insertIndexRevision(client, {
      scopeId,
      id: indexRevisionId,
      knowledgeId: progress.knowledgeId!,
      knowledgeVersion: progress.knowledgeVersion!,
      parserHash: deps.parserHash,
      embeddingRevision: deps.embeddingRevision,
      status: 'ready',
      chunkCount,
    });
    await knowledgeRepo.insertIndexMap(client, {
      scopeId,
      indexRevision: indexRevisionId,
      kbId: knowledge.kb_id,
      datasetId: progress.datasetId!,
      documentId: progress.documentId!,
    });
    // 索引重建时旧修订不删除，只标为已被取代：旧 evidence 仍按自己的
    // index_revision 解析，重建不覆盖历史。
    await knowledgeRepo.supersedeIndexRevisions(
      client,
      scopeId,
      progress.knowledgeId!,
      progress.knowledgeVersion!,
      indexRevisionId,
    );
    await knowledgeRepo.updateKnowledgeState(
      client,
      scopeId,
      progress.knowledgeId!,
      progress.knowledgeVersion!,
      { status: 'ready' },
    );
  }

  return { createOperation, readProgress, writeProgress, advance };
}

export type OperationsService = ReturnType<typeof createOperationsService>;
