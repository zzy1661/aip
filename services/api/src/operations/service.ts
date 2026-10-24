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
   * 远端文档名：由来源标识派生，跨来源唯一。
   *
   * 用户文件名可能重复（同一个知识库里两份同名不同正文的文件），
   * 只按用户文件名核对上游会把旧文档错认成新来源。远端名带来源标识，
   * 用户可见的显示名仍然是来源文件名。
   */
  remoteName?: string;
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
 * 发送意图阶段 -> 上一个阶段。
 *
 * 外部写请求发出之前先把「发送意图」写进操作进度；只有确认请求没有送达
 * （连接阶段失败）时，才把阶段退回上一个，让下一轮可以安全重发。
 */
const SEND_INTENT_PREVIOUS_STAGE: Record<string, string> = {
  dataset_create_attempted: 'dataset_pending',
  upload_attempted: 'upload_pending',
  parse_attempted: 'uploaded',
  reindex_attempted: 'reindex_pending',
};

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

/**
 * 只读核对的失败。
 *
 * 只读核对（列数据集 / 列文档 / 查解析状态）失败**什么都证明不了**：
 * 它既不能证明之前的写请求已经送达，也不能证明没有送达。
 * 因此它绝不能被当成「写请求未送达」而清掉发送意图——只允许延后这次核对。
 */
class ReadCheckError extends Error {
  constructor(readonly inner: unknown) {
    super('read-only verification failed');
    this.name = 'ReadCheckError';
  }
}

/**
 * 写请求的失败。
 *
 * 记录这次写对应的发送意图阶段：只有「这个阶段自己的写请求确定没送达」
 * 才允许把该阶段退回，否则会覆盖掉已经确认过的前序步骤。
 */
class WriteAttemptError extends Error {
  constructor(
    readonly intentStage: string,
    readonly inner: unknown,
  ) {
    super('upstream write failed');
    this.name = 'WriteAttemptError';
  }
}

/** 执行一次只读核对，并标记它的失败来源。 */
async function readCheck<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new ReadCheckError(error);
  }
}

/** 执行一次写请求，并标记它所属的发送意图阶段。 */
async function writeAttempt<T>(intentStage: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new WriteAttemptError(intentStage, error);
  }
}

/**
 * 远端文档名：由来源标识派生，跨来源唯一。
 *
 * 上游文档名就是上传时的文件名。同一知识库里可能存在同名不同正文的来源，
 * 只按用户文件名匹配会把旧文档错认成新来源。远端名带上来源标识后，
 * 「同名」不再是来源身份的唯一线索；用户可见的显示名仍是来源文件名。
 */
export function remoteDocumentName(
  sourceName: string,
  sourceFileId: string,
  sourceFileVersion: string,
): string {
  const dot = sourceName.lastIndexOf('.');
  const stem = dot > 0 ? sourceName.slice(0, dot) : sourceName;
  const extension = dot > 0 ? sourceName.slice(dot) : '';
  const identity = `${sourceFileId}-${sourceFileVersion}`.replace(/[^a-zA-Z0-9_-]/g, '');
  return `${stem}--${identity}${extension}`;
}

interface FailureDecision {
  /** 操作终态：failed / in_progress / unknown_outcome。 */
  state: 'failed' | 'in_progress' | 'unknown_outcome';
  message: string;
  /** 资源状态回落；null 表示保持现状（瞬时故障不应把资源判死）。 */
  resourceStatus: 'failed' | 'unknown_outcome' | null;
  /**
   * 请求是否确定没有送达上游。
   *
   * 只有这一种失败允许重发同一个写请求：连接都没建立，请求一定没到上游。
   */
  notDelivered: boolean;
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
 *
 * readOnly 表示这次故障来自**只读核对**而不是写请求。只读核对的失败不能
 * 用来判断写请求的送达情况：它「确定没送达」的结论只对这次核对成立，
 * 对之前的写请求不成立，因此 notDelivered 恒为 false，
 * 否则「核对没连上」会被误当成「之前的写没送达」而触发重发。
 * 其余分类（确定失败 / 暂时不可用）保持不变。
 */
function classifyFailure(error: unknown, readOnly = false): FailureDecision {
  const decision = classifyUpstreamFailure(error);
  if (!readOnly) return decision;
  return { ...decision, notDelivered: false };
}

function classifyUpstreamFailure(error: unknown): FailureDecision {
  if (error instanceof RagFlowBusinessError) {
    return {
      state: 'failed',
      message: `upstream business failure code=${error.upstreamCode}`,
      resourceStatus: 'failed',
      notDelivered: false,
    };
  }
  if (error instanceof RagFlowProtocolError) {
    return {
      state: 'failed',
      message: 'upstream response did not match the fixed contract',
      resourceStatus: 'failed',
      notDelivered: false,
    };
  }
  if (error instanceof RagFlowUnavailableError) {
    if (error.kind === 'credential_rejected') {
      return {
        state: 'failed',
        message: 'upstream rejected the platform credential',
        resourceStatus: 'failed',
        notDelivered: false,
      };
    }
    if (error.kind === 'not_delivered') {
      // 请求确定没有送达上游，重发安全。
      return {
        state: 'in_progress',
        message: `upstream is temporarily unavailable: ${error.reason}`,
        resourceStatus: null,
        notDelivered: true,
      };
    }
    if (error.kind === 'delivered_unknown') {
      if (error.writeAttempt) {
        // 写请求的结果不可知：远端可能已经生效，禁止盲重发。
        return {
          state: 'unknown_outcome',
          message: 'upstream write response was not confirmed',
          resourceStatus: 'unknown_outcome',
          notDelivered: false,
        };
      }
      return {
        state: 'in_progress',
        message: `upstream is temporarily unavailable: ${error.reason}`,
        resourceStatus: null,
        notDelivered: false,
      };
    }
    if (error.writeAttempt) {
      // 上游回了 5xx：写请求的结论由上游给出，是确定性的失败。
      return {
        state: 'failed',
        message: `upstream rejected the write: ${error.reason}`,
        resourceStatus: 'failed',
        notDelivered: false,
      };
    }
    return {
      state: 'in_progress',
      message: `upstream is temporarily unavailable: ${error.reason}`,
      resourceStatus: null,
      notDelivered: false,
    };
  }
  return {
    state: 'failed',
    message: 'unexpected upstream failure',
    resourceStatus: 'failed',
    notDelivered: false,
  };
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

  /**
   * 撤回是终态：已撤回的知识版本不能再被任何流程推进。
   *
   * 判断必须以数据库里的事实为准，不能靠调用方手里的进度快照：
   * 迟到的 worker 手上只有自己那份快照，看不到之后发生的撤回。
   */
  async function isWithdrawn(
    scopeId: string,
    knowledgeId: string | undefined,
    version: string | undefined,
  ): Promise<boolean> {
    if (!knowledgeId || !version) return false;
    const status = await withTransaction(pool, (client) =>
      knowledgeRepo.findKnowledgeStatus(client, scopeId, knowledgeId, version),
    );
    return status === 'withdrawn';
  }

  /**
   * 清掉发送意图。
   *
   * 只有确认请求没有送达上游（连接阶段失败）时才允许这样做：
   * 阶段退回上一个之后，下一轮推进可以重新发送同一个写请求。
   */
  function clearSendIntent(progress: OperationProgress): OperationProgress {
    const previous = SEND_INTENT_PREVIOUS_STAGE[progress.stage];
    if (previous === undefined) return progress;
    return { ...progress, stage: previous };
  }

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
      remoteName: result.remoteName,
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
      // 撤回是终态：已撤回的版本不再回落状态，否则失败分支会把撤回改写掉。
      await knowledgeRepo.updateKnowledgeStateUnlessWithdrawn(
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
          return await advanceKnowledgeBaseCreate(scopeId, operationId, epoch, progress, claimed.attempt);
        case 'document.upload':
          return await advanceDocumentUpload(scopeId, operationId, epoch, progress, claimed.attempt);
        case 'document.parse':
          return await advanceDocumentParse(scopeId, operationId, epoch, progress);
        case 'document.reindex':
          return await advanceDocumentReindex(scopeId, operationId, epoch, progress, claimed.attempt);
        case 'knowledge.withdraw':
          return await advanceKnowledgeWithdraw(scopeId, operationId, epoch, progress);
        default:
          throw new Error(`unsupported operation kind ${claimed.kind}`);
      }
    } catch (error) {
      return await handleFailure(error, scopeId, operationId, epoch, claimed.attempt);
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
    attempt: number,
  ): Promise<OperationResult> {
    if (error instanceof StaleEpochError) {
      // 已被更新的 epoch 取代：本轮不写任何状态，直接返回当前事实。
      return currentResult(scopeId, operationId, 'in_progress', null);
    }

    // 读失败与写失败必须分开处理：
    // - 写失败：只有「这个写请求自己确定没送达」才允许清掉它的发送意图；
    // - 读失败：只读核对失败什么都证明不了，任何发送意图都不许清，只能延后核对。
    const readOnlyFailure = error instanceof ReadCheckError;
    const intentStage = error instanceof WriteAttemptError ? error.intentStage : undefined;
    const inner =
      error instanceof ReadCheckError || error instanceof WriteAttemptError ? error.inner : error;
    const failure = classifyFailure(inner, readOnlyFailure);
    // 核对失败要能一眼看出是「核对」失败：它与「写失败」的处置完全不同。
    // 确定的失败（协议不符、业务失败）保留上游分类原文，不加前缀。
    const message =
      readOnlyFailure && failure.state === 'in_progress'
        ? `upstream verification read failed: ${failure.message}`
        : failure.message;

    let outcome: { state: string; message: string } = { state: failure.state, message };
    try {
      await withTransaction(pool, async (client) => {
        // 失败处理必须以数据库里**最新的持久检查点**为准：
        // 本轮推进过程中可能已经确认过前序步骤（上传成功、解析已触发），
        // 用入口处的旧快照回写会把这些确认过的进度覆盖掉，
        // 下一步就会重复已经完成过的写动作。
        const latest = await readProgress(client, scopeId, operationId);

        // 只有「这个写请求自己确定没送达」才允许清掉它的发送意图。
        // 读失败的连接错误说的是「这次核对没送达」，与写请求无关。
        const outstandingIntent = SEND_INTENT_PREVIOUS_STAGE[latest.stage] !== undefined;
        const mayClearIntent =
          failure.notDelivered &&
          !readOnlyFailure &&
          intentStage !== undefined &&
          latest.stage === intentStage;

        // 写结果未知，或者核对失败但仍有未确认的写：都转入 unknown_outcome，
        // 后续只允许只读核对，绝不重发。
        // 确定的核对失败（协议不符、业务失败）仍然照常终结，不在这里降级。
        if (
          failure.state === 'unknown_outcome' ||
          (readOnlyFailure && failure.state === 'in_progress' && outstandingIntent)
        ) {
          const unknownMessage = readOnlyFailure
            ? `${message}; the earlier write outcome is still unknown`
            : message;
          // 资源状态先落、操作状态后落：与撤回事务保持同一把行锁顺序
          // （知识版本 → 操作），否则两边的行锁会互相等待。
          await rollbackResourceStatus(
            client,
            scopeId,
            latest,
            failure.resourceStatus ?? 'unknown_outcome',
          );
          // 先落「结果未知」标记：它禁止后续推进重发同一个写请求。
          await writeProgress(
            client,
            scopeId,
            operationId,
            { ...latest, outcomeUnknown: true },
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
              ? `${unknownMessage}; automatic verification stopped after ${attempt} attempts, manual review required`
              : unknownMessage,
            epoch,
          );
          if (!deferred) throw new StaleEpochError(operationId);
          outcome = { state: 'unknown_outcome', message: unknownMessage };
          return;
        }

        if (failure.state === 'in_progress') {
          if (mayClearIntent) {
            // 请求确定没有送达上游：只清掉这一个写请求的发送意图，
            // 已经确认过的前序步骤（远端 ID、已上传）原样保留。
            await writeProgress(
              client,
              scopeId,
              operationId,
              clearSendIntent(latest),
              epoch,
            );
          }
          await retryOperation(
            client,
            scopeId,
            operationId,
            epoch,
            message,
            attempt,
          );
          return;
        }

        // 终态失败：资源状态先落、操作状态后落。
        await rollbackResourceStatus(
          client,
          scopeId,
          latest,
          failure.resourceStatus ?? 'failed',
        );
        await fenceOperationState(
          client,
          scopeId,
          operationId,
          epoch,
          failure.state,
          message,
        );
      });
    } catch (writeError) {
      if (writeError instanceof StaleEpochError) {
        return currentResult(scopeId, operationId, 'in_progress', null);
      }
      throw writeError;
    }

    const current = await opsRepo.findOperation(pool, scopeId, operationId);
    return {
      operationId,
      state: current?.state ?? outcome.state,
      resourceId: current?.resource_id ?? null,
      remoteId: current?.remote_id ?? null,
      lastError: current?.last_error ?? outcome.message,
    };
  }

  /** A missing listing or idle state never proves that a write was not delivered. */
  async function deferUnknownWrite(
    scopeId: string, operationId: string, epoch: number,
    progress: OperationProgress, attempt: number, message: string,
  ): Promise<OperationResult> {
    const capped = attempt >= unknownOutcomeMaxAttempts;
    const lastError = capped ? `${message}; automatic verification stopped, manual review required` : message;
    await withTransaction(pool, async (client) => {
      // 以数据库里最新的检查点为准：回写时不能覆盖掉本轮已确认的进度。
      const latest = await readProgress(client, scopeId, operationId);
      await rollbackResourceStatus(client, scopeId, latest, 'unknown_outcome');
      await writeProgress(client, scopeId, operationId, { ...latest, outcomeUnknown: true }, epoch);
      const updated = await opsRepo.deferOperation(client, scopeId, operationId,
        capped ? MANUAL_REVIEW_PARK_MS : unknownOutcomeDelay(attempt), lastError, epoch);
      if (!updated) throw new StaleEpochError(operationId);
    });
    return { operationId, state: 'unknown_outcome',
      resourceId: progress.knowledgeId ?? progress.kbId ?? null,
      remoteId: progress.documentId ?? progress.datasetId ?? null, lastError };
  }

  async function advanceKnowledgeBaseCreate(
    scopeId: string,
    operationId: string,
    epoch: number,
    progress: OperationProgress,
    attempt: number,
  ): Promise<OperationResult> {
    if (progress.datasetId) {
      await withTransaction(pool, (client) =>
        fenceOperationState(client, scopeId, operationId, epoch, 'succeeded', null),
      );
      return { operationId, state: 'succeeded', resourceId: progress.kbId ?? null, remoteId: progress.datasetId, lastError: null };
    }

    // 发送意图已经落库但本地没有远端 ID：上一次写入的结果不可知，
    // 只能只读核对，禁止直接重发——重发会造出第二个同名数据集。
    const interrupted = progress.stage === 'dataset_create_attempted';
    if (progress.outcomeUnknown || interrupted) {
      // 只读核对：它失败不能证明上一次的写请求没送达。
      const existing = await readCheck(() => ragflow.listDatasetsByName(progress.datasetName!));
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
      return deferUnknownWrite(scopeId, operationId, epoch, progress, attempt,
        existing.length > 1 ? 'multiple upstream datasets match; manual check required'
          : 'upstream dataset creation outcome is unknown; manual check required');
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
    const dataset = await writeAttempt('dataset_create_attempted', () =>
      ragflow.createDataset({
        name: progress.datasetName!,
        description: '',
      }),
    );
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
    attempt: number,
  ): Promise<OperationResult> {
    if (!progress.datasetId) {
      throw new Error('document upload operation has no dataset id');
    }
    // 撤回是终态：已撤回的知识版本不再上传，也不再推进解析。
    if (await isWithdrawn(scopeId, progress.knowledgeId, progress.knowledgeVersion)) {
      const message = 'knowledge version was withdrawn before the upload completed';
      await withTransaction(pool, (client) =>
        fenceOperationState(client, scopeId, operationId, epoch, 'cancelled', message),
      );
      return {
        operationId,
        state: 'cancelled',
        resourceId: progress.knowledgeId ?? null,
        remoteId: null,
        lastError: message,
      };
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

      // 远端文档名由来源标识派生：用户文件名可能重复，
      // 只按用户文件名核对上游会把另一份来源的旧文档错认成这次的上传。
      const remoteName =
        progress.remoteName ??
        remoteDocumentName(source.name, progress.sourceFileId!, progress.sourceFileVersion!);

      // 发送意图已落库但本地没有远端文档 ID：上一次上传的结果不可知。
      // 按远端唯一名只读核对上游，唯一命中才认领，绝不重新上传——重传会造出第二个同名文档。
      const interrupted = progress.stage === 'upload_attempted';
      if (progress.outcomeUnknown || interrupted) {
        // 只读核对：它失败不能证明上一次的写请求没送达。
        const documents = await readCheck(() => ragflow.listDocuments(progress.datasetId!));
        const matches = documents.filter((document) => document.name === remoteName);
        if (matches.length === 1) {
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
              { ...progress, stage: 'uploaded', documentId: matches[0]!.id, remoteName },
              epoch,
            );
          });
          progress = { ...progress, stage: 'uploaded', documentId: matches[0]!.id, remoteName };
        } else {
          return deferUnknownWrite(scopeId, operationId, epoch, progress, attempt,
            matches.length > 1 ? 'multiple upstream documents match; manual check required'
              : 'upstream upload outcome is unknown; manual check required');
        }
      }

      if (!progress.documentId) {
        const content = await files.read(source.storage_key);
        // 发送意图与远端唯一名在同一次写入里落库：
        // 恢复时才知道上一次到底有没有发出去、发出去的是哪个名字。
        await withTransaction(pool, (client) =>
          writeProgress(
            client,
            scopeId,
            operationId,
            { ...progress, stage: 'upload_attempted', remoteName },
            epoch,
          ),
        );
        const uploaded = await writeAttempt('upload_attempted', () =>
          ragflow.uploadDocument({
            datasetId: progress.datasetId!,
            filename: remoteName,
            contentType: source.mime,
            content,
          }),
        );
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
            { ...progress, stage: 'uploaded', documentId: uploaded.documentId, remoteName },
            epoch,
          );
        });
        progress = { ...progress, stage: 'uploaded', documentId: uploaded.documentId, remoteName };
      }
    }

    // 触发解析同样是一个写请求：发送意图先落库，
    // 恢复时只读确认上游状态，无法确认送达结果则暂停等待人工核查。
    const parseStartInterrupted = progress.stage === 'parse_attempted';
    if (progress.outcomeUnknown || parseStartInterrupted) {
      // 只读核对：它失败不能证明上一次的解析启动请求没送达，只能延后核对。
      const status = await readCheck(() =>
        ragflow.getDocumentStatus({
          datasetId: progress.datasetId!,
          documentId: progress.documentId!,
        }),
      );
      if (status.run === 'UNSTART') {
        return deferUnknownWrite(scopeId, operationId, epoch, progress, attempt,
          'upstream parse start outcome is unknown; manual check required');
      }
    } else {
      await withTransaction(pool, (client) =>
        writeProgress(
          client,
          scopeId,
          operationId,
          { ...progress, stage: 'parse_attempted' },
          epoch,
        ),
      );
      await writeAttempt('parse_attempted', () =>
        ragflow.startParse({
          datasetId: progress.datasetId!,
          documentIds: [progress.documentId!],
        }),
      );
    }
    // 解析是独立的长时操作，登记为单独的操作项由 worker 轮询。
    const withdrawn = await withTransaction(pool, async (client) => {
      // 撤回是终态：条件更新命中 0 行说明版本已被撤回，不再推进。
      const updated = await knowledgeRepo.updateKnowledgeStateUnlessWithdrawn(
        client,
        scopeId,
        progress.knowledgeId!,
        progress.knowledgeVersion!,
        { status: 'parsing' },
      );
      if (!updated) {
        await fenceOperationState(
          client,
          scopeId,
          operationId,
          epoch,
          'cancelled',
          'knowledge version was withdrawn before the upload completed',
        );
        return true;
      }
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
      await writeProgress(
        client,
        scopeId,
        operationId,
        { ...progress, stage: 'parse_started' },
        epoch,
      );
      return false;
    });
    if (withdrawn) {
      return {
        operationId,
        state: 'cancelled',
        resourceId: progress.knowledgeId ?? null,
        remoteId: progress.documentId ?? null,
        lastError: 'knowledge version was withdrawn before the upload completed',
      };
    }
    return { operationId, state: 'succeeded', resourceId: progress.knowledgeId ?? null, remoteId: progress.documentId ?? null, lastError: null };
  }

  /**
   * 失败/空结果分支：先落资源状态再落操作终态。
   *
   * 行锁顺序与撤回事务一致（知识版本 → 操作），避免互相等待。
   * 资源状态写不进去说明版本已撤回：操作记为 cancelled，而不是 failed。
   */
  async function settleWithResourceStatus(
    scopeId: string,
    operationId: string,
    epoch: number,
    progress: OperationProgress,
    resourceStatus: 'failed' | 'empty',
    operationState: 'failed' | 'succeeded',
    message: string,
  ): Promise<{ state: 'failed' | 'succeeded' | 'cancelled'; lastError: string }> {
    return withTransaction(pool, async (client) => {
      const updated = await knowledgeRepo.updateKnowledgeStateUnlessWithdrawn(
        client,
        scopeId,
        progress.knowledgeId!,
        progress.knowledgeVersion!,
        { status: resourceStatus },
      );
      const withdrawn = updated === null;
      const finalState = withdrawn ? 'cancelled' : operationState;
      const finalError = withdrawn ? 'knowledge version was withdrawn' : message;
      await fenceOperationState(client, scopeId, operationId, epoch, finalState, finalError);
      return { state: finalState, lastError: finalError };
    });
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
    const datasetId = progress.datasetId;
    const documentId = progress.documentId;

    // 撤回是终态：已撤回的知识版本不再推进解析。
    // 迟到的解析完成不能把它改回 ready——否则撤回的知识会复活，来源文件重新可下载。
    if (await isWithdrawn(scopeId, progress.knowledgeId, progress.knowledgeVersion)) {
      const message = 'knowledge version was withdrawn before the parse completed';
      await withTransaction(pool, (client) =>
        fenceOperationState(client, scopeId, operationId, epoch, 'cancelled', message),
      );
      return {
        operationId,
        state: 'cancelled',
        resourceId: progress.knowledgeId ?? null,
        remoteId: progress.documentId,
        lastError: message,
      };
    }

    // 解析有截止时间：超过截止仍未完成就进入终态失败，停止自动轮询，
    // 并把知识版本置为 failed，让用户看到明确状态而不是一直「解析中」。
    if (progress.createdAt) {
      const elapsed = Date.now() - progress.createdAt.getTime();
      if (elapsed > deps.parseDeadlineMs) {
        const message = `parse deadline exceeded after ${Math.round(elapsed / 1000)}s`;
        const settled = await settleWithResourceStatus(
          scopeId,
          operationId,
          epoch,
          progress,
          'failed',
          'failed',
          message,
        );
        return {
          operationId,
          state: settled.state,
          resourceId: progress.knowledgeId ?? null,
          remoteId: progress.documentId,
          lastError: settled.lastError,
        };
      }
    }

    const status = await readCheck(() =>
      ragflow.getDocumentStatus({
        datasetId,
        documentId,
      }),
    );

    if (status.run === 'DONE') {
      const chunkCount = status.chunk_count ?? 0;
      const progressComplete = status.progress !== null && status.progress >= 1;
      if (progressComplete && chunkCount > 0) {
        const ready = await withTransaction(pool, async (client) => {
          // 先落资源状态再落操作终态：与撤回事务保持同一把行锁顺序。
          const applied = await markKnowledgeReady(client, scopeId, progress, chunkCount);
          await fenceOperationState(
            client,
            scopeId,
            operationId,
            epoch,
            applied ? 'succeeded' : 'cancelled',
            applied ? null : 'knowledge version was withdrawn before the parse completed',
          );
          return applied;
        });
        return {
          operationId,
          state: ready ? 'succeeded' : 'cancelled',
          resourceId: progress.knowledgeId ?? null,
          remoteId: progress.documentId,
          lastError: ready ? null : 'knowledge version was withdrawn before the parse completed',
        };
      }
      if (chunkCount === 0) {
        const message = 'upstream reported DONE with zero chunks';
        const settled = await settleWithResourceStatus(
          scopeId,
          operationId,
          epoch,
          progress,
          'empty',
          'succeeded',
          message,
        );
        return {
          operationId,
          state: settled.state,
          resourceId: progress.knowledgeId ?? null,
          remoteId: progress.documentId,
          lastError: settled.lastError,
        };
      }
      const message = 'upstream reported DONE before progress completed';
      await withTransaction(pool, (client) =>
        fenceOperationState(client, scopeId, operationId, epoch, 'in_progress', message),
      );
      return { operationId, state: 'in_progress', resourceId: progress.knowledgeId ?? null, remoteId: progress.documentId, lastError: message };
    }

    if (status.run === 'FAIL') {
      // 只保留错误分类，不回显上游原文：progress_msg 可能带出上游内部细节。
      const settled = await settleWithResourceStatus(
        scopeId,
        operationId,
        epoch,
        progress,
        'failed',
        'failed',
        'parse failed upstream',
      );
      return {
        operationId,
        state: settled.state,
        resourceId: progress.knowledgeId ?? null,
        remoteId: progress.documentId,
        lastError: settled.lastError,
      };
    }

    if (status.run === 'CANCEL') {
      const settled = await settleWithResourceStatus(
        scopeId,
        operationId,
        epoch,
        progress,
        'failed',
        'failed',
        'parse cancelled',
      );
      return {
        operationId,
        state: settled.state,
        resourceId: progress.knowledgeId ?? null,
        remoteId: progress.documentId,
        lastError: settled.lastError,
      };
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
    attempt: number,
  ): Promise<OperationResult> {
    if (!progress.datasetId || !progress.documentId) {
      throw new Error('reindex operation is missing the remote document identity');
    }
    const datasetId = progress.datasetId;
    const documentId = progress.documentId;

    // 撤回是终态：已撤回的知识版本不再重建索引。
    if (await isWithdrawn(scopeId, progress.knowledgeId, progress.knowledgeVersion)) {
      const message = 'knowledge version was withdrawn before the reindex completed';
      await withTransaction(pool, (client) =>
        fenceOperationState(client, scopeId, operationId, epoch, 'cancelled', message),
      );
      return {
        operationId,
        state: 'cancelled',
        resourceId: progress.knowledgeId ?? null,
        remoteId: progress.documentId,
        lastError: message,
      };
    }

    const interrupted = progress.stage === 'reindex_attempted';
    if (progress.outcomeUnknown || interrupted) {
      // 启动解析的结果未知：只读核对，禁止根据旧状态重发。
      // 只读核对失败不能证明这次写没送达：它只能延后核对。
      const observed = await readCheck(() =>
        ragflow.getDocumentStatus({
          datasetId,
          documentId,
        }),
      );
      if (observed.run === 'UNSTART' || observed.run === 'DONE') {
        // Neither an idle document nor an old completed index identifies this write.
        return deferUnknownWrite(scopeId, operationId, epoch, progress, attempt,
          'upstream reindex outcome is unknown; manual check required');
      }
      // An active parse can be polled without sending another write.
    } else if (progress.stage !== 'reindex_started') {
      // 发送意图先落库：恢复时才知道上一次到底有没有发出去。
      await withTransaction(pool, (client) =>
        writeProgress(
          client,
          scopeId,
          operationId,
          { ...progress, stage: 'reindex_attempted' },
          epoch,
        ),
      );
      await writeAttempt('reindex_attempted', () =>
        ragflow.startParse({
          datasetId,
          documentIds: [documentId],
        }),
      );
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

    const status = await readCheck(() =>
      ragflow.getDocumentStatus({
        datasetId,
        documentId,
      }),
    );
    if (status.run === 'FAIL' || status.run === 'CANCEL') {
      const message = status.run === 'FAIL' ? 'reindex failed upstream' : 'reindex cancelled';
      const settled = await settleWithResourceStatus(
        scopeId,
        operationId,
        epoch,
        progress,
        'failed',
        'failed',
        message,
      );
      return {
        operationId,
        state: settled.state,
        resourceId: progress.knowledgeId ?? null,
        remoteId: progress.documentId,
        lastError: settled.lastError,
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
    const ready = message
      ? false
      : await withTransaction(pool, async (client) => {
          // 先落资源状态再落操作终态：与撤回事务保持同一把行锁顺序。
          const applied = await markKnowledgeReady(client, scopeId, progress, chunkCount);
          await fenceOperationState(
            client,
            scopeId,
            operationId,
            epoch,
            applied ? 'succeeded' : 'cancelled',
            applied ? null : 'knowledge version was withdrawn before the reindex completed',
          );
          return applied;
        });
    return {
      operationId,
      state: message ? 'in_progress' : ready ? 'succeeded' : 'cancelled',
      resourceId: progress.knowledgeId ?? null,
      remoteId: progress.documentId,
      lastError: message ?? (ready ? null : 'knowledge version was withdrawn before the reindex completed'),
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
    const datasetId = progress.datasetId;
    const documentId = progress.documentId;
    // 删除是写操作：先只读确认文档是否还在，在才删，避免结果未知时盲目重发。
    // 只读核对失败不能证明删除请求没送达，只能延后核对。
    const documents = await readCheck(() => ragflow.listDocuments(datasetId));
    const stillPresent = documents.some((document) => document.id === documentId);
    if (stillPresent) {
      await writeAttempt('withdraw_pending', () =>
        ragflow.deleteDocument({
          datasetId,
          documentId,
        }),
      );
    }

    await withTransaction(pool, (client) =>
      fenceOperationState(client, scopeId, operationId, epoch, 'succeeded', null),
    );
    return { operationId, state: 'succeeded', resourceId: progress.knowledgeId ?? null, remoteId: progress.documentId, lastError: null };
  }

  /**
   * 解析完成后登记索引版本并把知识版本置为可检索。
   * 返回 false 表示该版本已撤回：撤回是终态，既不建索引也不改状态。
   */
  async function markKnowledgeReady(
    client: PoolClient,
    scopeId: string,
    progress: OperationProgress,
    chunkCount: number,
  ): Promise<boolean> {
    const knowledge = await knowledgeRepo.findKnowledgeRevision(
      client,
      scopeId,
      progress.knowledgeId!,
      progress.knowledgeVersion!,
    );
    if (!knowledge) {
      throw new Error('knowledge revision disappeared during parse completion');
    }
    // 先落资源状态：撤回是终态，已撤回的版本不能被迟到的解析改回 ready。
    const applied = await knowledgeRepo.updateKnowledgeStateUnlessWithdrawn(
      client,
      scopeId,
      progress.knowledgeId!,
      progress.knowledgeVersion!,
      { status: 'ready' },
    );
    if (!applied) {
      return false;
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
    return true;
  }

  return { createOperation, readProgress, writeProgress, advance };
}

export type OperationsService = ReturnType<typeof createOperationsService>;
