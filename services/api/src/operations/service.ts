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
}

export interface OperationsDeps {
  pool: Pool;
  ragflow: RagFlowAdapter;
  files: FileStore;
  parseDeadlineMs: number;
  parserHash: string;
  embeddingRevision: string;
}

function describeError(error: unknown): { state: string; message: string } {
  if (error instanceof RagFlowBusinessError) {
    return { state: 'failed', message: `upstream business failure code=${error.upstreamCode}` };
  }
  if (error instanceof RagFlowProtocolError) {
    return { state: 'failed', message: 'upstream response did not match the fixed contract' };
  }
  if (error instanceof RagFlowUnavailableError) {
    return {
      state: error.timedOut ? 'failed' : 'unknown_outcome',
      message: error.timedOut ? 'upstream timed out' : 'upstream response was not confirmed',
    };
  }
  return { state: 'failed', message: 'unexpected upstream failure' };
}

export function createOperationsService(deps: OperationsDeps) {
  const { pool, ragflow, files } = deps;

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
      kbId: result.kbId,
      datasetId: result.datasetId,
      documentId: result.documentId,
      knowledgeId: result.knowledgeId,
      knowledgeVersion: result.knowledgeVersion,
      sourceFileId: result.sourceFileId,
      sourceFileVersion: result.sourceFileVersion,
      datasetName: result.datasetName,
    };
  }

  async function writeProgress(
    client: PoolClient,
    scopeId: string,
    operationId: string,
    progress: OperationProgress,
  ): Promise<void> {
    await client.query(
      `UPDATE operation SET result = $3::jsonb, updated_at = now() WHERE scope_id = $1 AND id = $2`,
      [scopeId, operationId, JSON.stringify(progress)],
    );
  }

  /**
   * 推进一个待处理操作。
   * 写操作不做盲重试：只有确认过远端结果的阶段才会被跳过。
   */
  async function advance(
    operationId: string,
    scopeId: string,
  ): Promise<OperationResult> {
    const claimed = await withTransaction(pool, async (client) =>
      opsRepo.claimOperationLease(client, scopeId, operationId, 30_000),
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

    const progress = await withTransaction(pool, (client) =>
      readProgress(client, scopeId, operationId),
    );

    try {
      switch (claimed.kind) {
        case 'knowledge_base.create':
          return await advanceKnowledgeBaseCreate(scopeId, operationId, progress);
        case 'document.upload':
          return await advanceDocumentUpload(scopeId, operationId, progress);
        case 'document.parse':
          return await advanceDocumentParse(scopeId, operationId, progress);
        case 'knowledge.withdraw':
          return await advanceKnowledgeWithdraw(scopeId, operationId, progress);
        default:
          throw new Error(`unsupported operation kind ${claimed.kind}`);
      }
    } catch (error) {
      const described = describeError(error);
      await withTransaction(pool, (client) =>
        opsRepo.setOperationState(client, scopeId, operationId, described.state, described.message),
      );
      const current = await opsRepo.findOperation(pool, scopeId, operationId);
      return {
        operationId,
        state: described.state,
        resourceId: current?.resource_id ?? null,
        remoteId: current?.remote_id ?? null,
        lastError: described.message,
      };
    }
  }

  async function advanceKnowledgeBaseCreate(
    scopeId: string,
    operationId: string,
    progress: OperationProgress,
  ): Promise<OperationResult> {
    if (progress.datasetId) {
      await withTransaction(pool, (client) =>
        opsRepo.setOperationState(client, scopeId, operationId, 'succeeded', null),
      );
      return { operationId, state: 'succeeded', resourceId: progress.kbId ?? null, remoteId: progress.datasetId, lastError: null };
    }

    // 响应丢失时先按稳定名称核对，唯一命中才继续，否则保持 unknown_outcome 交人工核查。
    if (progress.datasetName) {
      const existing = await ragflow.listDatasetsByName(progress.datasetName);
      if (existing.length === 1) {
        await withTransaction(pool, async (client) => {
          await opsRepo.setOperationRemoteId(client, scopeId, operationId, existing[0]!.id, 'succeeded');
          await writeProgress(client, scopeId, operationId, {
            ...progress,
            stage: 'dataset_created',
            datasetId: existing[0]!.id,
          });
          await knowledgeRepo.updateKnowledgeBase(client, scopeId, progress.kbId!, {
            status: 'ready',
            ragflowDatasetId: existing[0]!.id,
          });
        });
        return { operationId, state: 'succeeded', resourceId: progress.kbId ?? null, remoteId: existing[0]!.id, lastError: null };
      }
      if (existing.length > 1) {
        const message = 'multiple upstream datasets match the stable name; manual check required';
        await withTransaction(pool, (client) =>
          opsRepo.setOperationState(client, scopeId, operationId, 'unknown_outcome', message),
        );
        return { operationId, state: 'unknown_outcome', resourceId: progress.kbId ?? null, remoteId: null, lastError: message };
      }
    }

    const dataset = await ragflow.createDataset({
      name: progress.datasetName!,
      description: '',
    });
    await withTransaction(pool, async (client) => {
      await opsRepo.setOperationRemoteId(client, scopeId, operationId, dataset.datasetId, 'succeeded');
      await writeProgress(client, scopeId, operationId, {
        ...progress,
        stage: 'dataset_created',
        datasetId: dataset.datasetId,
      });
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
    progress: OperationProgress,
  ): Promise<OperationResult> {
    if (!progress.datasetId) {
      throw new Error('document upload operation has no dataset id');
    }
    if (progress.stage === 'parse_started' && progress.documentId) {
      await withTransaction(pool, (client) =>
        opsRepo.setOperationState(client, scopeId, operationId, 'succeeded', null),
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
          opsRepo.setOperationState(client, scopeId, operationId, 'failed', message),
        );
        return { operationId, state: 'failed', resourceId: progress.knowledgeId ?? null, remoteId: null, lastError: message };
      }
      const content = await files.read(source.storage_key);
      const uploaded = await ragflow.uploadDocument({
        datasetId: progress.datasetId!,
        filename: source.name,
        contentType: source.mime,
        content,
      });
      await withTransaction(pool, (client) =>
        opsRepo.setOperationRemoteId(client, scopeId, operationId, uploaded.documentId, 'in_progress'),
      );
      await withTransaction(pool, (client) =>
        writeProgress(client, scopeId, operationId, {
          ...progress,
          stage: 'uploaded',
          documentId: uploaded.documentId,
        }),
      );
      progress = { ...progress, stage: 'uploaded', documentId: uploaded.documentId };
    }

    await ragflow.startParse({
      datasetId: progress.datasetId!,
      documentIds: [progress.documentId!],
    });
    await withTransaction(pool, (client) =>
      writeProgress(client, scopeId, operationId, { ...progress, stage: 'parse_started' }),
    );
    // 解析是独立的长时操作，登记为单独的操作项由 worker 轮询。
    const parseOperationId = await withTransaction(pool, async (client) => {
      const id = await createOperation(
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
      await writeProgress(client, scopeId, id, {
        ...progress,
        stage: 'parse_polling',
      });
      await knowledgeRepo.updateKnowledgeState(
        client,
        scopeId,
        progress.knowledgeId!,
        progress.knowledgeVersion!,
        { status: 'parsing' },
      );
      return id;
    });
    await withTransaction(pool, (client) =>
      opsRepo.setOperationState(client, scopeId, operationId, 'succeeded', null),
    );
    return { operationId, state: 'succeeded', resourceId: progress.knowledgeId ?? null, remoteId: progress.documentId ?? null, lastError: null };
  }

  async function advanceDocumentParse(
    scopeId: string,
    operationId: string,
    progress: OperationProgress,
  ): Promise<OperationResult> {
    if (!progress.datasetId || !progress.documentId) {
      throw new Error('parse operation is missing the remote document identity');
    }
    const status = await ragflow.getDocumentStatus({
      datasetId: progress.datasetId,
      documentId: progress.documentId,
    });

    if (status.run === 'DONE') {
      const chunkCount = status.chunk_count ?? 0;
      const progressComplete = status.progress !== null && status.progress >= 1;
      if (progressComplete && chunkCount > 0) {
        await withTransaction(pool, (client) =>
          markKnowledgeReady(client, scopeId, progress, chunkCount),
        );
        await withTransaction(pool, (client) =>
          opsRepo.setOperationState(client, scopeId, operationId, 'succeeded', null),
        );
        return { operationId, state: 'succeeded', resourceId: progress.knowledgeId ?? null, remoteId: progress.documentId, lastError: null };
      }
      if (chunkCount === 0) {
        const message = 'upstream reported DONE with zero chunks';
        await withTransaction(pool, async (client) => {
          await knowledgeRepo.updateKnowledgeState(
            client,
            scopeId,
            progress.knowledgeId!,
            progress.knowledgeVersion!,
            { status: 'empty' },
          );
        });
        await withTransaction(pool, (client) =>
          opsRepo.setOperationState(client, scopeId, operationId, 'succeeded', message),
        );
        return { operationId, state: 'succeeded', resourceId: progress.knowledgeId ?? null, remoteId: progress.documentId, lastError: message };
      }
      const message = 'upstream reported DONE before progress completed';
      await withTransaction(pool, (client) =>
        opsRepo.setOperationState(client, scopeId, operationId, 'in_progress', message),
      );
      return { operationId, state: 'in_progress', resourceId: progress.knowledgeId ?? null, remoteId: progress.documentId, lastError: message };
    }

    if (status.run === 'FAIL') {
      const message = status.progress_msg
        ? `parse failed: ${status.progress_msg}`
        : 'parse failed';
      await withTransaction(pool, (client) =>
        opsRepo.setOperationState(client, scopeId, operationId, 'failed', message),
      );
      return { operationId, state: 'failed', resourceId: progress.knowledgeId ?? null, remoteId: progress.documentId, lastError: message };
    }

    if (status.run === 'CANCEL') {
      const message = 'parse cancelled';
      await withTransaction(pool, (client) =>
        opsRepo.setOperationState(client, scopeId, operationId, 'failed', message),
      );
      return { operationId, state: 'failed', resourceId: progress.knowledgeId ?? null, remoteId: progress.documentId, lastError: message };
    }

    await withTransaction(pool, (client) =>
      opsRepo.setOperationState(client, scopeId, operationId, 'in_progress', null),
    );
    return { operationId, state: 'in_progress', resourceId: progress.knowledgeId ?? null, remoteId: progress.documentId, lastError: null };
  }

  async function advanceKnowledgeWithdraw(
    scopeId: string,
    operationId: string,
    progress: OperationProgress,
  ): Promise<OperationResult> {
    if (!progress.datasetId || !progress.documentId) {
      await withTransaction(pool, (client) =>
        opsRepo.setOperationState(client, scopeId, operationId, 'succeeded', null),
      );
      return { operationId, state: 'succeeded', resourceId: progress.knowledgeId ?? null, remoteId: null, lastError: null };
    }
    await ragflow.deleteDocument({
      datasetId: progress.datasetId,
      documentId: progress.documentId,
    });
    await withTransaction(pool, (client) =>
      opsRepo.setOperationState(client, scopeId, operationId, 'succeeded', null),
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
