import type { QueryClient } from '../db/pool.js';
import type {
  DocumentSummary,
  KnowledgeBaseDetail,
  KnowledgeBaseSummary,
  KnowledgeReviewRecord,
} from '@aip/contracts';

export interface KnowledgeBaseRow {
  id: string;
  name: string;
  description: string;
  status: string;
  ragflow_dataset_id: string | null;
  operation_id: string | null;
  created_at: Date;
}

export interface KnowledgeRow {
  knowledge_id: string;
  version: string;
  kb_id: string;
  source_file_id: string;
  source_file_version: string;
  source_file_name: string;
  source_sha256: string;
  mime: string;
  size: string;
  review_status: string;
  status: string;
  state_revision: number;
  applies_to: Record<string, unknown>;
  content_hash: string;
  created_at: Date;
}

export async function insertKnowledgeBase(
  client: QueryClient,
  input: {
    scopeId: string;
    id: string;
    name: string;
    description: string;
    status: string;
    operationId: string | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO knowledge_base (scope_id, id, name, description, status, operation_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.scopeId,
      input.id,
      input.name,
      input.description,
      input.status,
      input.operationId,
    ],
  );
}

export async function updateKnowledgeBase(
  client: QueryClient,
  scopeId: string,
  id: string,
  patch: { status?: string; ragflowDatasetId?: string | null },
): Promise<void> {
  await client.query(
    `UPDATE knowledge_base
        SET status = COALESCE($3, status),
            ragflow_dataset_id = COALESCE($4, ragflow_dataset_id)
      WHERE scope_id = $1 AND id = $2`,
    [scopeId, id, patch.status ?? null, patch.ragflowDatasetId ?? null],
  );
}

export async function findKnowledgeBase(
  client: QueryClient,
  scopeId: string,
  id: string,
): Promise<KnowledgeBaseRow | null> {
  const { rows } = await client.query<KnowledgeBaseRow>(
    `SELECT id, name, description, status, ragflow_dataset_id, operation_id, created_at
       FROM knowledge_base WHERE scope_id = $1 AND id = $2`,
    [scopeId, id],
  );
  return rows[0] ?? null;
}

export async function listKnowledgeBases(
  client: QueryClient,
  scopeId: string,
): Promise<KnowledgeBaseRow[]> {
  const { rows } = await client.query<KnowledgeBaseRow>(
    `SELECT id, name, description, status, ragflow_dataset_id, operation_id, created_at
       FROM knowledge_base WHERE scope_id = $1 ORDER BY created_at`,
    [scopeId],
  );
  return rows;
}

export async function insertSourceFileRevision(
  client: QueryClient,
  input: {
    scopeId: string;
    id: string;
    version: string;
    name: string;
    mime: string;
    size: number;
    sha256: string;
    storageKey: string;
    createdBy: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO source_file_revision
       (scope_id, id, version, name, mime, size, sha256, storage_key, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.scopeId,
      input.id,
      input.version,
      input.name,
      input.mime,
      input.size,
      input.sha256,
      input.storageKey,
      input.createdBy,
    ],
  );
}

export async function findSourceFileRevision(
  client: QueryClient,
  scopeId: string,
  id: string,
  version: string,
): Promise<{
  id: string;
  version: string;
  name: string;
  mime: string;
  size: string;
  sha256: string;
  storage_key: string;
} | null> {
  const { rows } = await client.query<{
    id: string;
    version: string;
    name: string;
    mime: string;
    size: string;
    sha256: string;
    storage_key: string;
  }>(
    `SELECT id, version, name, mime, size, sha256, storage_key
       FROM source_file_revision WHERE scope_id = $1 AND id = $2 AND version = $3`,
    [scopeId, id, version],
  );
  return rows[0] ?? null;
}

export async function insertKnowledgeRevision(
  client: QueryClient,
  input: {
    scopeId: string;
    knowledgeId: string;
    version: string;
    kbId: string;
    sourceFileId: string;
    sourceFileVersion: string;
    status: string;
    appliesTo: Record<string, unknown>;
    contentHash: string;
    createdBy: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO knowledge_revision
       (scope_id, knowledge_id, version, kb_id, source_file_id, source_file_version,
        review_status, status, state_revision, applies_to, content_hash, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, 1, $8::jsonb, $9, $10)`,
    [
      input.scopeId,
      input.knowledgeId,
      input.version,
      input.kbId,
      input.sourceFileId,
      input.sourceFileVersion,
      input.status,
      JSON.stringify(input.appliesTo),
      input.contentHash,
      input.createdBy,
    ],
  );
}

const KNOWLEDGE_SELECT = `
  SELECT kr.knowledge_id, kr.version, kr.kb_id, kr.source_file_id, kr.source_file_version,
         sfr.name AS source_file_name, sfr.sha256 AS source_sha256, sfr.mime, sfr.size,
         kr.review_status, kr.status, kr.state_revision, kr.applies_to, kr.content_hash,
         kr.created_at
    FROM knowledge_revision kr
    JOIN source_file_revision sfr
      ON sfr.scope_id = kr.scope_id AND sfr.id = kr.source_file_id
     AND sfr.version = kr.source_file_version
`;

export async function findKnowledgeRevision(
  client: QueryClient,
  scopeId: string,
  knowledgeId: string,
  version: string,
): Promise<KnowledgeRow | null> {
  const { rows } = await client.query<KnowledgeRow>(
    `${KNOWLEDGE_SELECT} WHERE kr.scope_id = $1 AND kr.knowledge_id = $2 AND kr.version = $3`,
    [scopeId, knowledgeId, version],
  );
  return rows[0] ?? null;
}

export async function listKnowledgeRevisions(
  client: QueryClient,
  scopeId: string,
  kbId: string | null,
): Promise<KnowledgeRow[]> {
  const values: unknown[] = [scopeId];
  let filter = '';
  if (kbId) {
    values.push(kbId);
    filter = `AND kr.kb_id = $${values.length}`;
  }
  const { rows } = await client.query<KnowledgeRow>(
    `${KNOWLEDGE_SELECT} WHERE kr.scope_id = $1 ${filter} ORDER BY kr.created_at`,
    values,
  );
  return rows;
}

/** 全部版本，供显式引用（只给 knowledge_id）定位最新版本。 */
export async function listAllVersions(
  client: QueryClient,
  scopeId: string,
  knowledgeId: string,
): Promise<KnowledgeRow[]> {
  const { rows } = await client.query<KnowledgeRow>(
    `${KNOWLEDGE_SELECT} WHERE kr.scope_id = $1 AND kr.knowledge_id = $2 ORDER BY kr.created_at DESC`,
    [scopeId, knowledgeId],
  );
  return rows;
}

export async function findLatestKnowledgeRevision(
  client: QueryClient,
  scopeId: string,
  knowledgeId: string,
): Promise<KnowledgeRow | null> {
  const versions = await listAllVersions(client, scopeId, knowledgeId);
  return versions[0] ?? null;
}

export async function findKnowledgeBySourceFile(
  client: QueryClient,
  scopeId: string,
  fileId: string,
  version: string,
): Promise<{ knowledge_id: string; version: string } | null> {
  const { rows } = await client.query<{ knowledge_id: string; version: string }>(
    `SELECT knowledge_id, version FROM knowledge_revision
      WHERE scope_id = $1 AND source_file_id = $2 AND source_file_version = $3
      ORDER BY created_at DESC LIMIT 1`,
    [scopeId, fileId, version],
  );
  return rows[0] ?? null;
}

export async function updateKnowledgeState(
  client: QueryClient,
  scopeId: string,
  knowledgeId: string,
  version: string,
  patch: { status?: string; reviewStatus?: string },
  expectedStateRevision?: number,
): Promise<KnowledgeRow | null> {
  const { rows } = await client.query<KnowledgeRow>(
    `UPDATE knowledge_revision
        SET status = COALESCE($4, status),
            review_status = COALESCE($5, review_status),
            state_revision = state_revision + CASE WHEN ($4 IS NOT NULL OR $5 IS NOT NULL) THEN 1 ELSE 0 END
      WHERE scope_id = $1 AND knowledge_id = $2 AND version = $3
        AND ($6::integer IS NULL OR state_revision = $6::integer)
      RETURNING knowledge_id, version, review_status, status, state_revision`,
    [
      scopeId,
      knowledgeId,
      version,
      patch.status ?? null,
      patch.reviewStatus ?? null,
      expectedStateRevision ?? null,
    ],
  );
  return rows[0] ?? null;
}

export async function insertReview(
  client: QueryClient,
  input: {
    scopeId: string;
    knowledgeId: string;
    version: string;
    decision: string;
    reviewer: string;
    expectedHash: string;
    reason: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO knowledge_review
       (scope_id, knowledge_id, version, decision, reviewer, expected_hash, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.scopeId,
      input.knowledgeId,
      input.version,
      input.decision,
      input.reviewer,
      input.expectedHash,
      input.reason,
    ],
  );
}

export async function listReviews(
  client: QueryClient,
  scopeId: string,
  knowledgeId: string,
  version: string,
): Promise<KnowledgeReviewRecord[]> {
  const { rows } = await client.query<{
    knowledge_id: string;
    version: string;
    decision: 'approved' | 'rejected';
    reviewer: string;
    expected_hash: string;
    reason: string;
    reviewed_at: Date;
  }>(
    `SELECT knowledge_id, version, decision, reviewer, expected_hash, reason, reviewed_at
       FROM knowledge_review
      WHERE scope_id = $1 AND knowledge_id = $2 AND version = $3
      ORDER BY reviewed_at`,
    [scopeId, knowledgeId, version],
  );
  return rows.map((row) => ({
    knowledge_id: row.knowledge_id,
    version: row.version,
    decision: row.decision,
    reviewer: row.reviewer,
    expected_hash: row.expected_hash,
    reason: row.reason,
    reviewed_at: row.reviewed_at.toISOString(),
  }));
}

export async function insertIndexRevision(
  client: QueryClient,
  input: {
    scopeId: string;
    id: string;
    knowledgeId: string;
    knowledgeVersion: string;
    parserHash: string;
    embeddingRevision: string;
    status: string;
    chunkCount?: number | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO index_revision
       (scope_id, id, knowledge_id, knowledge_version, parser_hash, embedding_revision, status, chunk_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.scopeId,
      input.id,
      input.knowledgeId,
      input.knowledgeVersion,
      input.parserHash,
      input.embeddingRevision,
      input.status,
      input.chunkCount ?? null,
    ],
  );
}

export async function setIndexRevisionStatus(
  client: QueryClient,
  scopeId: string,
  id: string,
  status: string,
): Promise<void> {
  await client.query(
    `UPDATE index_revision SET status = $3 WHERE scope_id = $1 AND id = $2`,
    [scopeId, id, status],
  );
}

export async function insertIndexMap(
  client: QueryClient,
  input: {
    scopeId: string;
    indexRevision: string;
    kbId: string;
    datasetId: string;
    documentId: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO knowledge_index_map
       (scope_id, index_revision, kb_id, dataset_id, document_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      input.scopeId,
      input.indexRevision,
      input.kbId,
      input.datasetId,
      input.documentId,
    ],
  );
}

export async function findIndexMapByDocument(
  client: QueryClient,
  scopeId: string,
  documentId: string,
): Promise<{
  index_revision: string;
  kb_id: string;
  dataset_id: string;
  document_id: string;
  knowledge_id: string;
  knowledge_version: string;
  source_file_id: string;
  source_file_version: string;
} | null> {
  const { rows } = await client.query<{
    index_revision: string;
    kb_id: string;
    dataset_id: string;
    document_id: string;
    knowledge_id: string;
    knowledge_version: string;
    source_file_id: string;
    source_file_version: string;
  }>(
    `SELECT kim.index_revision, kim.kb_id, kim.dataset_id, kim.document_id,
            ir.knowledge_id, ir.knowledge_version,
            kr.source_file_id, kr.source_file_version
       FROM knowledge_index_map kim
       JOIN index_revision ir
         ON ir.scope_id = kim.scope_id AND ir.id = kim.index_revision
       JOIN knowledge_revision kr
         ON kr.scope_id = ir.scope_id AND kr.knowledge_id = ir.knowledge_id
        AND kr.version = ir.knowledge_version
      WHERE kim.scope_id = $1 AND kim.document_id = $2`,
    [scopeId, documentId],
  );
  return rows[0] ?? null;
}

export async function findIndexMapByDocumentForKnowledge(
  client: QueryClient,
  scopeId: string,
  knowledgeId: string,
  knowledgeVersion: string,
): Promise<{ index_revision: string; dataset_id: string; document_id: string } | null> {
  const { rows } = await client.query<{
    index_revision: string;
    dataset_id: string;
    document_id: string;
  }>(
    `SELECT kim.index_revision, kim.dataset_id, kim.document_id
       FROM knowledge_index_map kim
       JOIN index_revision ir
         ON ir.scope_id = kim.scope_id AND ir.id = kim.index_revision
      WHERE kim.scope_id = $1 AND ir.knowledge_id = $2 AND ir.knowledge_version = $3`,
    [scopeId, knowledgeId, knowledgeVersion],
  );
  return rows[0] ?? null;
}

export async function insertEvidence(
  client: QueryClient,
  input: {
    scopeId: string;
    id: string;
    knowledgeRef: string;
    knowledgeVersion: string;
    indexRevision: string;
    sourceFileRevision: string;
    chunkId: string;
    chunkHash: string;
    locator: Record<string, unknown>;
    content: string;
    contentDigest: string;
    score: number;
    authzRevision: number;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO evidence
       (scope_id, id, knowledge_ref, knowledge_version, index_revision, source_file_revision,
        chunk_id, chunk_hash, locator, content, content_digest, score, authz_revision)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13)`,
    [
      input.scopeId,
      input.id,
      input.knowledgeRef,
      input.knowledgeVersion,
      input.indexRevision,
      input.sourceFileRevision,
      input.chunkId,
      input.chunkHash,
      JSON.stringify(input.locator),
      input.content,
      input.contentDigest,
      input.score,
      input.authzRevision,
    ],
  );
}

export async function findEvidence(
  client: QueryClient,
  scopeId: string,
  id: string,
): Promise<{
  id: string;
  knowledge_ref: string;
  knowledge_version: string;
  index_revision: string;
  source_file_revision: string;
  chunk_id: string;
  chunk_hash: string;
  locator: Record<string, unknown>;
  content: string;
  content_digest: string;
  score: number;
  authz_revision: string;
} | null> {
  const { rows } = await client.query<{
    id: string;
    knowledge_ref: string;
    knowledge_version: string;
    index_revision: string;
    source_file_revision: string;
    chunk_id: string;
    chunk_hash: string;
    locator: Record<string, unknown>;
    content: string;
    content_digest: string;
    score: number;
    authz_revision: string;
  }>(
    `SELECT id, knowledge_ref, knowledge_version, index_revision, source_file_revision,
            chunk_id, chunk_hash, locator, content, content_digest, score, authz_revision
       FROM evidence WHERE scope_id = $1 AND id = $2`,
    [scopeId, id],
  );
  return rows[0] ?? null;
}

export function toKnowledgeBaseSummary(row: KnowledgeBaseRow): KnowledgeBaseSummary {
  return {
    kb_id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    ragflow_dataset_id: row.ragflow_dataset_id,
    operation_id: row.operation_id,
    created_at: row.created_at.toISOString(),
  };
}

export function toKnowledgeBaseDetail(
  row: KnowledgeBaseRow,
  documentCount: number,
): KnowledgeBaseDetail {
  return { ...toKnowledgeBaseSummary(row), document_count: documentCount };
}

export function toDocumentSummary(
  row: KnowledgeRow,
  extras: {
    indexRevision: string | null;
    chunkCount: number | null;
    lastError: string | null;
    stale: boolean;
  },
): DocumentSummary {
  return {
    knowledge_id: row.knowledge_id,
    version: row.version,
    kb_id: row.kb_id,
    source_file_id: row.source_file_id,
    source_file_version: row.source_file_version,
    source_file_name: row.source_file_name,
    source_sha256: row.source_sha256,
    mime: row.mime,
    size: Number.parseInt(row.size, 10),
    review_status: row.review_status,
    status: row.status,
    state_revision: row.state_revision,
    index_revision: extras.indexRevision,
    chunk_count: extras.chunkCount,
    last_error: extras.lastError,
    stale: extras.stale,
    applies_to: row.applies_to,
    created_at: row.created_at.toISOString(),
  };
}
