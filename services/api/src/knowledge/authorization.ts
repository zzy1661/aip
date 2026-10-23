import type { QueryClient } from '../db/pool.js';

/**
 * 文档级授权与授权版本。
 *
 * authz_state 行锁只覆盖「本地末次授权判定 + 有界响应交付」这一段，
 * 不得跨越上游网络调用或长时间下载流持有。
 */

export interface AuthorizedDocument {
  knowledge_id: string;
  knowledge_version: string;
  kb_id: string;
  dataset_id: string;
  document_id: string;
  index_revision: string;
  can_download: boolean;
  applies_to: Record<string, unknown>;
}

export async function isDenied(
  client: QueryClient,
  scopeId: string,
  subject: string,
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM local_deny WHERE scope_id = $1 AND subject = $2`,
    [scopeId, subject],
  );
  return rows.length > 0;
}

export async function ensureAuthzState(client: QueryClient, scopeId: string): Promise<void> {
  await client.query(
    `INSERT INTO authz_state (scope_id, revision) VALUES ($1, 1)
     ON CONFLICT (scope_id) DO NOTHING`,
    [scopeId],
  );
}

export async function currentAuthzRevision(
  client: QueryClient,
  scopeId: string,
): Promise<number> {
  const { rows } = await client.query<{ revision: string }>(
    `SELECT revision FROM authz_state WHERE scope_id = $1`,
    [scopeId],
  );
  return rows[0] ? Number.parseInt(rows[0].revision, 10) : 0;
}

/** 取得授权行锁。调用方必须在同一事务内完成末次授权判定与响应构建。 */
export async function lockAuthzState(
  client: QueryClient,
  scopeId: string,
): Promise<number> {
  await ensureAuthzState(client, scopeId);
  const { rows } = await client.query<{ revision: string }>(
    `SELECT revision FROM authz_state WHERE scope_id = $1 FOR UPDATE`,
    [scopeId],
  );
  return rows[0] ? Number.parseInt(rows[0].revision, 10) : 0;
}

export async function bumpAuthzRevision(client: QueryClient, scopeId: string): Promise<number> {
  await ensureAuthzState(client, scopeId);
  const { rows } = await client.query<{ revision: string }>(
    `UPDATE authz_state SET revision = revision + 1 WHERE scope_id = $1 RETURNING revision`,
    [scopeId],
  );
  return rows[0] ? Number.parseInt(rows[0].revision, 10) : 0;
}

export async function grantDocument(
  client: QueryClient,
  input: {
    scopeId: string;
    knowledgeId: string;
    knowledgeVersion: string;
    subject: string;
    canRead: boolean;
    canDownload: boolean;
  },
): Promise<number> {
  await client.query(
    `INSERT INTO document_grant
       (scope_id, knowledge_id, knowledge_version, subject, can_read, can_download)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (scope_id, knowledge_id, knowledge_version, subject)
     DO UPDATE SET can_read = EXCLUDED.can_read, can_download = EXCLUDED.can_download`,
    [
      input.scopeId,
      input.knowledgeId,
      input.knowledgeVersion,
      input.subject,
      input.canRead,
      input.canDownload,
    ],
  );
  return bumpAuthzRevision(client, input.scopeId);
}

export async function revokeDocument(
  client: QueryClient,
  input: {
    scopeId: string;
    knowledgeId: string;
    knowledgeVersion: string;
    subject: string;
  },
): Promise<number> {
  await client.query(
    `UPDATE document_grant
        SET can_read = false, can_download = false
      WHERE scope_id = $1 AND knowledge_id = $2 AND knowledge_version = $3 AND subject = $4`,
    [input.scopeId, input.knowledgeId, input.knowledgeVersion, input.subject],
  );
  return bumpAuthzRevision(client, input.scopeId);
}

/** 检索白名单：主体有权 + 审核通过 + 未撤回 + 索引就绪 + 适用条件匹配。 */
export async function listAuthorizedDocuments(
  client: QueryClient,
  input: {
    scopeId: string;
    subject: string;
    kbIds: string[];
    knowledgeRefs?: string[];
  },
): Promise<AuthorizedDocument[]> {
  const values: unknown[] = [input.scopeId, input.subject];
  values.push(input.kbIds.length > 0 ? input.kbIds : null);
  const kbParam = `$${values.length}`;

  let knowledgeFilter = '';
  if (input.knowledgeRefs && input.knowledgeRefs.length > 0) {
    values.push(input.knowledgeRefs);
    knowledgeFilter = `AND kr.knowledge_id::text = ANY($${values.length}::text[])`;
  }

  const { rows } = await client.query<{
    knowledge_id: string;
    knowledge_version: string;
    kb_id: string;
    dataset_id: string;
    document_id: string;
    index_revision: string;
    can_download: boolean;
    applies_to: Record<string, unknown>;
  }>(
    `SELECT kr.knowledge_id, kr.version AS knowledge_version, kim.kb_id,
            kim.dataset_id, kim.document_id, kim.index_revision,
            dg.can_download, kr.applies_to
       FROM knowledge_revision kr
       JOIN document_grant dg
         ON dg.scope_id = kr.scope_id AND dg.knowledge_id = kr.knowledge_id
        AND dg.knowledge_version = kr.version AND dg.subject = $2
       JOIN index_revision ir
         ON ir.scope_id = kr.scope_id AND ir.knowledge_id = kr.knowledge_id
        AND ir.knowledge_version = kr.version AND ir.status = 'ready'
       JOIN knowledge_index_map kim
         ON kim.scope_id = ir.scope_id AND kim.index_revision = ir.id
      WHERE kr.scope_id = $1
        AND dg.can_read = true
        AND kr.review_status = 'approved'
        AND kr.status = 'ready'
        AND (kr.valid_from IS NULL OR kr.valid_from <= now())
        AND (kr.valid_until IS NULL OR kr.valid_until > now())
        AND (${kbParam}::uuid[] IS NULL OR kim.kb_id = ANY(${kbParam}::uuid[]))
        ${knowledgeFilter}`,
    values,
  );
  return rows.map((row) => ({
    knowledge_id: row.knowledge_id,
    knowledge_version: row.knowledge_version,
    kb_id: row.kb_id,
    dataset_id: row.dataset_id,
    document_id: row.document_id,
    index_revision: row.index_revision,
    can_download: row.can_download,
    applies_to: row.applies_to,
  }));
}

/** 资源级可见性：只看文档授权，不看审核状态（上传者要能看到自己尚未审核的文档）。 */
export async function filterReadable(
  client: QueryClient,
  scopeId: string,
  subject: string,
  knowledgeIds: string[],
): Promise<Set<string>> {
  if (knowledgeIds.length === 0) return new Set();
  const { rows } = await client.query<{ knowledge_id: string }>(
    `SELECT knowledge_id FROM document_grant
      WHERE scope_id = $1 AND subject = $2 AND can_read = true
        AND knowledge_id::text = ANY($3::text[])`,
    [scopeId, subject, knowledgeIds],
  );
  return new Set(rows.map((row) => row.knowledge_id));
}

/**
 * 末次授权复核：命中集合必须在交付前重新确认仍然可读。
 * 同时排除已撤回与未审核通过的知识版本。
 */
export async function filterStillAuthorized(
  client: QueryClient,
  scopeId: string,
  subject: string,
  knowledgeIds: string[],
): Promise<Set<string>> {
  if (knowledgeIds.length === 0) return new Set();
  const { rows } = await client.query<{ knowledge_id: string }>(
    `SELECT DISTINCT dg.knowledge_id
       FROM document_grant dg
       JOIN knowledge_revision kr
         ON kr.scope_id = dg.scope_id AND kr.knowledge_id = dg.knowledge_id
        AND kr.version = dg.knowledge_version
      WHERE dg.scope_id = $1 AND dg.subject = $2 AND dg.can_read = true
        AND dg.knowledge_id::text = ANY($3::text[])
        AND kr.status <> 'withdrawn'
        AND kr.review_status = 'approved'
        AND (kr.valid_from IS NULL OR kr.valid_from <= now())
        AND (kr.valid_until IS NULL OR kr.valid_until > now())`,
    [scopeId, subject, knowledgeIds],
  );
  return new Set(rows.map((row) => row.knowledge_id));
}

export async function hasDownloadGrant(
  client: QueryClient,
  scopeId: string,
  subject: string,
  knowledgeId: string,
  knowledgeVersion: string,
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM document_grant
      WHERE scope_id = $1 AND subject = $2 AND knowledge_id = $3
        AND knowledge_version = $4 AND can_download = true`,
    [scopeId, subject, knowledgeId, knowledgeVersion],
  );
  return rows.length > 0;
}
