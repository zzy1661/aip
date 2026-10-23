import type { Pool, PoolClient } from 'pg';
import {
  appliesToSchema,
  createKnowledgeBaseRequestSchema,
  isApplicable,
  isConditional,
  knowledgeReviewRequestSchema,
  knowledgeWithdrawRequestSchema,
  retrievalRequestSchema,
  type AppliesTo,
  type DocumentSummary,
  type EvidenceItem,
  type KnowledgeBaseDetail,
  type KnowledgeBaseSummary,
  type KnowledgeReviewRequest,
  type RetrievalResponse,
  type RetrievalStatus,
} from '@aip/contracts';
import { apiError, fieldIssue } from '../http/errors.js';
import { Validator } from '../http/validate.js';
import { runIdempotent } from '../idempotency/service.js';
import { withTransaction } from '../db/uow.js';
import { hashObject, newDatasetName, newId, sha256Hex } from '../util/hash.js';
import type { Principal } from '../auth/principal.js';
import type { RagFlowAdapter } from '../ragflow/adapter.js';
import type { FileStore } from '../files/store.js';
import type { OperationsService } from '../operations/service.js';
import { validateUpload, type ValidatedUpload } from '../files/validate.js';
import * as repo from './repository.js';
import * as authz from './authorization.js';
import * as opsRepo from '../operations/repository.js';

export interface KnowledgeDeps {
  pool: Pool;
  validator: Validator;
  ragflow: RagFlowAdapter;
  operations: OperationsService;
  files: FileStore;
  limits: {
    uploadMaxBytes: number;
    retrievalMaxDocuments: number;
    parseDeadlineMs: number;
  };
  parserHash: string;
  embeddingRevision: string;
}

export interface UploadInput {
  originalName: string;
  mimeType: string;
  content: Buffer;
  version: string;
  appliesTo: Record<string, unknown>;
}

export function createKnowledgeService(deps: KnowledgeDeps) {
  const { pool, validator, ragflow, operations, files } = deps;

  /**
   * 适用条件必须在入库前显式声明模式。
   * 空对象不合法：它无法区分「通用」与「尚未声明」，一旦被默认为通用，
   * 后续审核与检索都无法发现知识缺少适用条件这一事实。
   */
  function normalizeAppliesTo(raw: unknown): Record<string, unknown> {
    const appliesTo = validator.assert<AppliesTo>(appliesToSchema, raw, 'applies_to');
    if (appliesTo.mode === 'conditional' && Object.keys(appliesTo.conditions ?? {}).length === 0) {
      throw apiError('CONTRACT_INVALID', 'request failed contract validation', [
        fieldIssue('applies_to.conditions', 'at least one condition is required'),
      ]);
    }
    return appliesTo as unknown as Record<string, unknown>;
  }

  async function createKnowledgeBase(
    principal: Principal,
    body: unknown,
    idempotencyKey: string,
  ): Promise<{ statusCode: number; body: unknown }> {
    const request = validator.assert<{ name: string; description?: string }>(
      createKnowledgeBaseRequestSchema,
      body,
    );
    const requestHash = hashObject({ operation: 'knowledge_bases.create', request });

    return withTransaction(pool, async (client) => {
      const outcome = await runIdempotent(
        client,
        {
          scopeId: principal.scope,
          subject: principal.subject,
          operation: 'knowledge_bases.create',
          key: idempotencyKey,
          requestHash,
        },
        async () => {
          const kbId = newId();
          const datasetName = newDatasetName(principal.scope);
          const operationId = await operations.createOperation(
            client,
            {
              kind: 'knowledge_base.create',
              scopeId: principal.scope,
              subject: principal.subject,
              idempotencyKey,
              request: { name: request.name, description: request.description ?? '' },
            },
            kbId,
          );
          await repo.insertKnowledgeBase(client, {
            scopeId: principal.scope,
            id: kbId,
            name: request.name,
            description: request.description ?? '',
            status: 'creating',
            operationId,
          });
          await operations.writeProgress(client, principal.scope, operationId, {
            stage: 'dataset_pending',
            kbId,
            datasetName,
          });
          return {
            statusCode: 202,
            body: { data: { operation_id: operationId, kb_id: kbId } },
          };
        },
      );
      return { statusCode: outcome.response.statusCode, body: outcome.response.body };
    });
  }

  async function listKnowledgeBases(
    principal: Principal,
  ): Promise<KnowledgeBaseSummary[]> {
    const rows = await repo.listKnowledgeBases(pool, principal.scope);
    return rows.map(repo.toKnowledgeBaseSummary);
  }

  async function getKnowledgeBase(
    principal: Principal,
    kbId: string,
  ): Promise<KnowledgeBaseDetail> {
    const row = await repo.findKnowledgeBase(pool, principal.scope, kbId);
    if (!row) {
      throw apiError('NOT_FOUND', 'knowledge base not found');
    }
    const documents = await repo.listKnowledgeRevisions(pool, principal.scope, kbId);
    return repo.toKnowledgeBaseDetail(row, documents.length);
  }

  async function uploadDocument(
    principal: Principal,
    kbId: string,
    input: UploadInput,
    idempotencyKey: string,
  ): Promise<{ statusCode: number; body: unknown }> {
    // 上传校验全部在调用上游之前完成，非法请求不会产生任何 RAGFlow 调用。
    const validated: ValidatedUpload = validateUpload(
      {
        originalName: input.originalName,
        mimeType: input.mimeType,
        content: input.content,
      },
      deps.limits.uploadMaxBytes,
    );
    const appliesTo = normalizeAppliesTo(input.appliesTo);

    const kb = await repo.findKnowledgeBase(pool, principal.scope, kbId);
    if (!kb) {
      throw apiError('NOT_FOUND', 'knowledge base not found');
    }
    if (!kb.ragflow_dataset_id) {
      throw apiError('STATE_CONFLICT', 'knowledge base is not ready for uploads', [
        fieldIssue('kb_id', `knowledge base status is ${kb.status}`),
      ]);
    }

    const datasetId = kb.ragflow_dataset_id;

    const requestHash = hashObject({
      operation: 'knowledge_documents.upload',
      kbId,
      version: input.version,
      sha256: validated.sha256,
    });

    const sourceFileId = newId();
    const knowledgeId = newId();
    const storageKey = files.buildStorageKey(principal.scope, sourceFileId, input.version);

    return withTransaction(pool, async (client) => {
      const outcome = await runIdempotent(
        client,
        {
          scopeId: principal.scope,
          subject: principal.subject,
          operation: 'knowledge_documents.upload',
          key: idempotencyKey,
          requestHash,
        },
        async () => {
          // 文件先落盘再入库：事务回滚会留下孤儿文件，但不会留下指向缺失文件的记录。
          await files.write(storageKey, validated.content);
          await repo.insertSourceFileRevision(client, {
            scopeId: principal.scope,
            id: sourceFileId,
            version: input.version,
            name: validated.basename,
            mime: validated.mime,
            size: validated.content.length,
            sha256: validated.sha256,
            storageKey,
            createdBy: principal.subject,
          });
          const contentHash = sha256Hex(validated.sha256);
          await repo.insertKnowledgeRevision(client, {
            scopeId: principal.scope,
            knowledgeId,
            version: input.version,
            kbId,
            sourceFileId,
            sourceFileVersion: input.version,
            status: 'uploaded',
            appliesTo,
            contentHash,
            createdBy: principal.subject,
          });
          // 上传者在同一事务内获得该知识版本的读取与下载授权。
          await authz.grantDocument(client, {
            scopeId: principal.scope,
            knowledgeId,
            knowledgeVersion: input.version,
            subject: principal.subject,
            canRead: true,
            canDownload: true,
          });

          const operationId = await operations.createOperation(
            client,
            {
              kind: 'document.upload',
              scopeId: principal.scope,
              subject: principal.subject,
              idempotencyKey,
              request: { kbId, knowledgeId, version: input.version, sha256: validated.sha256 },
            },
            knowledgeId,
          );
          await operations.writeProgress(client, principal.scope, operationId, {
            stage: 'upload_pending',
            kbId,
            datasetId,
            knowledgeId,
            knowledgeVersion: input.version,
            sourceFileId,
            sourceFileVersion: input.version,
          });
          await repo.updateKnowledgeState(client, principal.scope, knowledgeId, input.version, {
            status: 'parse_queued',
          });

          return {
            statusCode: 202,
            body: {
              data: {
                operation_id: operationId,
                knowledge_ref: knowledgeId,
                source_ref: sourceFileId,
              },
            },
          };
        },
      );
      return { statusCode: outcome.response.statusCode, body: outcome.response.body };
    });
  }

  async function listDocuments(
    principal: Principal,
    kbId: string,
  ): Promise<DocumentSummary[]> {
    const kb = await repo.findKnowledgeBase(pool, principal.scope, kbId);
    if (!kb) {
      throw apiError('NOT_FOUND', 'knowledge base not found');
    }
    const rows = await repo.listKnowledgeRevisions(pool, principal.scope, kbId);
    const visible: DocumentSummary[] = [];
    for (const row of rows) {
      const allowed = await authz.filterReadable(
        pool,
        principal.scope,
        principal.subject,
        [row.knowledge_id],
      );
      if (!allowed.has(row.knowledge_id)) continue;
      visible.push(await decorateDocument(principal.scope, row));
    }
    return visible;
  }

  async function decorateDocument(
    scopeId: string,
    row: repo.KnowledgeRow,
  ): Promise<DocumentSummary> {
    const operation = await pool.query<{ last_error: string | null; state: string }>(
      `SELECT last_error, state FROM operation
        WHERE scope_id = $1 AND resource_id = $2
        ORDER BY created_at DESC LIMIT 1`,
      [scopeId, row.knowledge_id],
    );
    const index = await pool.query<{ id: string; chunk_count: number | null }>(
      `SELECT ir.id, ir.chunk_count FROM index_revision ir
        WHERE ir.scope_id = $1 AND ir.knowledge_id = $2 AND ir.knowledge_version = $3
        ORDER BY ir.created_at DESC LIMIT 1`,
      [scopeId, row.knowledge_id, row.version],
    );
    return repo.toDocumentSummary(row, {
      indexRevision: index.rows[0]?.id ?? null,
      chunkCount: index.rows[0]?.chunk_count ?? null,
      lastError: operation.rows[0]?.last_error ?? null,
      stale: operation.rows[0]?.state === 'unknown_outcome',
    });
  }

  async function getDocument(
    principal: Principal,
    knowledgeId: string,
    version: string,
  ): Promise<DocumentSummary> {
    const row = await repo.findKnowledgeRevision(
      pool,
      principal.scope,
      knowledgeId,
      version,
    );
    if (!row) {
      throw apiError('NOT_FOUND', 'knowledge version not found');
    }
    const allowed = await authz.filterReadable(pool, principal.scope, principal.subject, [
      knowledgeId,
    ]);
    if (!allowed.has(knowledgeId)) {
      throw apiError('NOT_FOUND', 'knowledge version not found');
    }
    return decorateDocument(principal.scope, row);
  }

  async function review(
    principal: Principal,
    knowledgeId: string,
    version: string,
    body: unknown,
  ): Promise<{ data: unknown }> {
    const request = validator.assert<KnowledgeReviewRequest>(
      knowledgeReviewRequestSchema,
      body,
    );
    const validFrom = parseValidityPoint(request.valid_from, 'valid_from');
    const validUntil = parseValidityPoint(request.valid_until, 'valid_until');
    if (validFrom && validUntil && validUntil.getTime() <= validFrom.getTime()) {
      throw apiError('CONTRACT_INVALID', 'request failed contract validation', [
        fieldIssue('valid_until', 'must be later than valid_from'),
      ]);
    }
    // 有效期只对「通过」的审核结论有意义；驳回不写入有效期区间。
    const effectiveValidFrom = request.decision === 'approved' ? validFrom : null;
    const effectiveValidUntil = request.decision === 'approved' ? validUntil : null;

    return withTransaction(pool, async (client) => {
      const row = await repo.findKnowledgeRevision(client, principal.scope, knowledgeId, version);
      if (!row) {
        throw apiError('NOT_FOUND', 'knowledge version not found');
      }
      if (row.content_hash !== request.expected_hash) {
        throw apiError('STATE_CONFLICT', 'expected_hash does not match the current content', [
          fieldIssue('expected_hash', 'content changed since the hash was observed'),
        ]);
      }
      const updated = await repo.updateKnowledgeState(
        client,
        principal.scope,
        knowledgeId,
        version,
        {
          reviewStatus: request.decision,
          validFrom: effectiveValidFrom,
          validUntil: effectiveValidUntil,
        },
        row.state_revision,
      );
      if (!updated) {
        throw apiError('STATE_CONFLICT', 'state revision is stale', [
          fieldIssue('state_revision', `current state revision is ${row.state_revision}`),
        ]);
      }
      await repo.insertReview(client, {
        scopeId: principal.scope,
        knowledgeId,
        version,
        decision: request.decision,
        reviewer: principal.subject,
        expectedHash: request.expected_hash,
        reason: request.reason,
        validFrom,
        validUntil,
      });
      return {
        data: {
          knowledge_id: knowledgeId,
          version,
          review_status: request.decision,
          state_revision: updated.state_revision,
          reviewer: principal.subject,
          expected_hash: request.expected_hash,
          reviewed_at: new Date().toISOString(),
          valid_from: effectiveValidFrom ? effectiveValidFrom.toISOString() : null,
          valid_until: effectiveValidUntil ? effectiveValidUntil.toISOString() : null,
        },
      };
    });
  }

  async function withdraw(
    principal: Principal,
    knowledgeId: string,
    version: string,
    body: unknown,
  ): Promise<{ data: unknown }> {
    const request = validator.assert<{
      expected_state_revision: number;
      reason: string;
    }>(knowledgeWithdrawRequestSchema, body);

    return withTransaction(pool, async (client) => {
      const row = await repo.findKnowledgeRevision(client, principal.scope, knowledgeId, version);
      if (!row) {
        throw apiError('NOT_FOUND', 'knowledge version not found');
      }
      const updated = await repo.updateKnowledgeState(
        client,
        principal.scope,
        knowledgeId,
        version,
        { status: 'withdrawn' },
        request.expected_state_revision,
      );
      if (!updated) {
        throw apiError('STATE_CONFLICT', 'state revision is stale', [
          fieldIssue(
            'expected_state_revision',
            `current state revision is ${row.state_revision}`,
          ),
        ]);
      }
      // 授权版本递增：撤回提交后开始的响应不能再读到旧的授权。
      await authz.bumpAuthzRevision(client, principal.scope);

      const indexMap = await repo.findIndexMapByDocumentForKnowledge(
        client,
        principal.scope,
        knowledgeId,
        version,
      );
      if (indexMap) {
        const operationId = await operations.createOperation(
          client,
          {
            kind: 'knowledge.withdraw',
            scopeId: principal.scope,
            subject: principal.subject,
            idempotencyKey: `withdraw:${knowledgeId}:${version}`,
            request: { knowledgeId, version },
          },
          knowledgeId,
        );
        await operations.writeProgress(client, principal.scope, operationId, {
          stage: 'withdraw_pending',
          knowledgeId,
          knowledgeVersion: version,
          datasetId: indexMap.dataset_id,
          documentId: indexMap.document_id,
        });
      }
      return {
        data: {
          knowledge_id: knowledgeId,
          version,
          status: 'withdrawn',
          state_revision: updated.state_revision,
        },
      };
    });
  }

  async function retrieval(
    principal: Principal,
    body: unknown,
  ): Promise<RetrievalResponse> {
    const request = validator.assert<{
      query: string;
      kb_ids: string[];
      knowledge_refs?: string[];
      context?: Record<string, unknown>;
      top_n?: number;
    }>(retrievalRequestSchema, body);
    const topN = request.top_n ?? 10;

    if (request.knowledge_refs && request.knowledge_refs.length > 0) {
      await assertExplicitlyVisible(principal, request.knowledge_refs);
    }

    const authorized = await authz.listAuthorizedDocuments(pool, {
      scopeId: principal.scope,
      subject: principal.subject,
      kbIds: request.kb_ids,
      knowledgeRefs: request.knowledge_refs,
    });

    // 空授权集合：本次检索不产生任何外部 HTTP 请求。
    if (authorized.length === 0) {
      return { status: 'no_match', evidence: [] };
    }

    // 适用条件过滤：条件不适用的知识不得进入白名单，也不得触发上游调用。
    const applicable = authorized.filter((entry) =>
      isApplicable(entry.applies_to, request.context),
    );
    const awaitingContext = authorized.filter(
      (entry) =>
        !isApplicable(entry.applies_to, request.context) && isConditional(entry.applies_to),
    );
    if (applicable.length === 0) {
      // 只有条件知识且上下文不足时返回 needs_context，同样不产生上游请求。
      return {
        status: awaitingContext.length > 0 ? 'needs_context' : 'no_match',
        evidence: [],
      };
    }

    if (applicable.length > deps.limits.retrievalMaxDocuments) {
      throw apiError(
        'AUTHORIZED_SCOPE_TOO_LARGE',
        'authorized document count exceeds the platform limit for a single retrieval',
        [
          fieldIssue(
            'kb_ids',
            `${applicable.length} authorized documents exceed the limit of ${deps.limits.retrievalMaxDocuments}`,
          ),
        ],
      );
    }

    const datasetIds = [...new Set(applicable.map((entry) => entry.dataset_id))];
    if (datasetIds.length > 1) {
      throw apiError(
        'AUTHORIZED_SCOPE_TOO_LARGE',
        'the authorized scope spans more than one dataset; narrow the request',
        [fieldIssue('kb_ids', `${datasetIds.length} datasets are in scope`)],
      );
    }

    const allowedDocumentIds = new Set(applicable.map((entry) => entry.document_id));
    const chunks = await ragflow.retrieve({
      question: request.query,
      datasetIds,
      documentIds: [...allowedDocumentIds],
      pageSize: topN,
    });

    // 上游回包中出现白名单之外的文档：整体失败，不把越权内容放进响应或缓存。
    for (const chunk of chunks) {
      if (!allowedDocumentIds.has(chunk.document_id)) {
        throw apiError(
          'RAGFLOW_PROTOCOL_ERROR',
          'upstream returned a document outside the authorized whitelist',
        );
      }
      if (!datasetIds.includes(chunk.dataset_id)) {
        throw apiError(
          'RAGFLOW_PROTOCOL_ERROR',
          'upstream returned a dataset outside the authorized whitelist',
        );
      }
    }

    const delivery = await withTransaction(pool, async (client) => {
      const revision = await authz.lockAuthzState(client, principal.scope);
      const knowledgeIds = [...new Set(chunks.map((chunk) => chunk.document_id))];
      const stillAuthorized = await authz.filterStillAuthorized(
        client,
        principal.scope,
        principal.subject,
        await resolveKnowledgeIds(client, principal.scope, chunks.map((c) => c.document_id)),
      );
      const evidence: EvidenceItem[] = [];
      for (const chunk of chunks) {
        const mapping = await repo.findIndexMapByDocument(client, principal.scope, chunk.document_id);
        if (!mapping) {
          throw apiError('RAGFLOW_PROTOCOL_ERROR', 'upstream chunk has no local index mapping');
        }
        if (!stillAuthorized.has(mapping.knowledge_id)) {
          continue;
        }
        const evidenceId = newId();
        const chunkHash = sha256Hex(chunk.content);
        const locator = buildLocator(mapping.source_file_id, mapping.source_file_version, chunk.positions);
        await repo.insertEvidence(client, {
          scopeId: principal.scope,
          id: evidenceId,
          knowledgeRef: mapping.knowledge_id,
          knowledgeVersion: mapping.knowledge_version,
          indexRevision: mapping.index_revision,
          sourceFileRevision: mapping.source_file_id,
          chunkId: chunk.id,
          chunkHash,
          locator,
          content: chunk.content,
          contentDigest: chunkHash,
          score: chunk.similarity ?? 0,
          authzRevision: revision,
        });
        evidence.push({
          evidence_id: evidenceId,
          knowledge_ref: mapping.knowledge_id,
          knowledge_version: mapping.knowledge_version,
          index_revision: mapping.index_revision,
          source_file_revision: mapping.source_file_id,
          source_locator: {
            source_file_id: mapping.source_file_id,
            source_file_version: mapping.source_file_version,
            incomplete: chunk.positions === null || chunk.positions.length === 0,
            ...(chunk.positions ? { positions: chunk.positions } : {}),
          },
          chunk_id: chunk.id,
          chunk_hash: chunkHash,
          score: chunk.similarity ?? 0,
          content: chunk.content,
        });
      }
      void knowledgeIds;
      return { revision, evidence };
    });

    const status: RetrievalStatus =
      delivery.evidence.length > 0 ? 'authorized_evidence' : 'no_match';
    return { status, evidence: delivery.evidence };
  }

  async function resolveKnowledgeIds(
    client: PoolClient,
    scopeId: string,
    documentIds: string[],
  ): Promise<string[]> {
    if (documentIds.length === 0) return [];
    const { rows } = await client.query<{ knowledge_id: string }>(
      `SELECT ir.knowledge_id FROM knowledge_index_map kim
         JOIN index_revision ir ON ir.scope_id = kim.scope_id AND ir.id = kim.index_revision
        WHERE kim.scope_id = $1 AND kim.document_id = ANY($2::text[])`,
      [scopeId, documentIds],
    );
    return rows.map((row) => row.knowledge_id);
  }

  async function assertExplicitlyVisible(
    principal: Principal,
    knowledgeRefs: string[],
  ): Promise<void> {
    for (const knowledgeId of knowledgeRefs) {
      const target = await repo.findLatestKnowledgeRevision(
        pool,
        principal.scope,
        knowledgeId,
      );
      if (!target) {
        throw apiError('NOT_FOUND', 'knowledge version not found');
      }
      const allowed = await authz.filterReadable(pool, principal.scope, principal.subject, [
        knowledgeId,
      ]);
      if (!allowed.has(knowledgeId)) {
        // 无权访问的显式引用统一按 404 处理，不泄露资源是否存在。
        throw apiError('NOT_FOUND', 'knowledge version not found');
      }
      if (target.review_status !== 'approved') {
        throw apiError('INDEX_NOT_READY', 'the requested knowledge is not approved yet', [
          fieldIssue(
            'knowledge_refs',
            `knowledge ${knowledgeId} review status is ${target.review_status}`,
          ),
        ]);
      }
      if (target.status !== 'ready') {
        throw apiError('INDEX_NOT_READY', 'the requested knowledge is not indexed yet', [
          fieldIssue('knowledge_refs', `knowledge ${knowledgeId} status is ${target.status}`),
        ]);
      }
    }
  }

  async function downloadSource(
    principal: Principal,
    fileId: string,
    version: string,
  ): Promise<{ content: Buffer; name: string; mime: string; sha256: string }> {
    const source = await repo.findSourceFileRevision(pool, principal.scope, fileId, version);
    if (!source) {
      throw apiError('NOT_FOUND', 'source file not found');
    }
    const knowledge = await repo.findKnowledgeBySourceFile(
      pool,
      principal.scope,
      fileId,
      version,
    );
    if (!knowledge) {
      throw apiError('NOT_FOUND', 'source file not found');
    }
    const allowed = await authz.filterReadable(pool, principal.scope, principal.subject, [
      knowledge.knowledge_id,
    ]);
    if (!allowed.has(knowledge.knowledge_id)) {
      throw apiError('NOT_FOUND', 'source file not found');
    }
    const canDownload = await authz.hasDownloadGrant(
      pool,
      principal.scope,
      principal.subject,
      knowledge.knowledge_id,
      knowledge.version,
    );
    if (!canDownload) {
      throw apiError('FORBIDDEN', 'download is not granted for this document');
    }
    const content = await files.read(source.storage_key);
    return {
      content,
      name: source.name,
      mime: source.mime,
      sha256: source.sha256,
    };
  }

  async function getEvidence(principal: Principal, evidenceId: string): Promise<unknown> {
    const row = await repo.findEvidence(pool, principal.scope, evidenceId);
    if (!row) {
      throw apiError('NOT_FOUND', 'evidence not found');
    }
    const allowed = await authz.filterStillAuthorized(pool, principal.scope, principal.subject, [
      row.knowledge_ref,
    ]);
    if (!allowed.has(row.knowledge_ref)) {
      throw apiError('NOT_FOUND', 'evidence not found');
    }
    return {
      evidence_id: row.id,
      knowledge_ref: row.knowledge_ref,
      knowledge_version: row.knowledge_version,
      index_revision: row.index_revision,
      source_file_revision: row.source_file_revision,
      chunk_id: row.chunk_id,
      chunk_hash: row.chunk_hash,
      locator: row.locator,
      content: row.content,
      score: row.score,
    };
  }

  async function getOperation(principal: Principal, operationId: string): Promise<unknown> {
    const row = await opsRepo.findOperation(pool, principal.scope, operationId);
    if (!row) {
      throw apiError('NOT_FOUND', 'operation not found');
    }
    if (row.subject !== principal.subject) {
      const allowed = await pool.query(
        `SELECT 1 FROM principal_grant
          WHERE scope_id = $1 AND subject = $2 AND permission = 'operations:read'`,
        [principal.scope, principal.subject],
      );
      if (allowed.rowCount === 0) {
        throw apiError('NOT_FOUND', 'operation not found');
      }
    }
    return opsRepo.toOperationView(row);
  }

  return {
    limits: deps.limits,
    createKnowledgeBase,
    listKnowledgeBases,
    getKnowledgeBase,
    uploadDocument,
    listDocuments,
    getDocument,
    review,
    withdraw,
    retrieval,
    downloadSource,
    getEvidence,
    getOperation,
  };
}

function parseValidityPoint(value: string | undefined, field: string): Date | null {
  if (value === undefined) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw apiError('CONTRACT_INVALID', 'request failed contract validation', [
      fieldIssue(field, 'must be an ISO-8601 timestamp'),
    ]);
  }
  return parsed;
}

function buildLocator(
  sourceFileId: string,
  sourceFileVersion: string,
  positions: unknown[] | null,
): Record<string, unknown> {
  return {
    source_file_id: sourceFileId,
    source_file_version: sourceFileVersion,
    incomplete: positions === null || positions.length === 0,
    ...(positions ? { positions } : {}),
  };
}

export type KnowledgeService = ReturnType<typeof createKnowledgeService>;
