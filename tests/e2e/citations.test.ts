import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { knowledgeAuthorization, withTransaction } from '@aip/api';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import {
  createReadyKnowledgeBase,
  prepareApprovedDocument,
  seedRetrievalChunk,
} from '../helpers/flow.js';

/**
 * M21：检索结果的来源引用。
 *
 * 断言口径：
 * - 每条证据都必须能追溯到来源文件、来源版本与知识版本；
 * - 文本类来源缺少可核验位置时必须显式标记 incomplete，不得伪造页码；
 * - 证据详情与来源下载都要再过一次授权校验。
 */
describe('M21 来源引用', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm21' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  async function prepare() {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M21 知识库');
    const document = await prepareApprovedDocument(harness, token, kbId, { marker: 'M21-CITE' });
    return { kbId, document };
  }

  it('证据带有来源文件、来源版本与知识版本', async () => {
    const { kbId, document } = await prepare();
    seedRetrievalChunk(harness, {
      documentId: document.documentId,
      datasetId: document.datasetId,
      content: 'M21-CITE',
      positions: [{ page: 3, text: 'M21-CITE' }],
    });

    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M21-CITE', kb_ids: [kbId] },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('authorized_evidence');
    const evidence = response.body.data.evidence as any[];
    expect(evidence).toHaveLength(1);
    expect(evidence[0].knowledge_ref).toBe(document.knowledgeRef);
    expect(evidence[0].knowledge_version).toBe(document.version);
    expect(evidence[0].source_locator.source_file_id).toBe(document.sourceRef);
    expect(evidence[0].source_locator.source_file_version).toBe(document.version);
    expect(evidence[0].source_locator.incomplete).toBe(false);
    expect(evidence[0].source_locator.positions).toHaveLength(1);
    expect(evidence[0].chunk_id).toBeTruthy();
    expect(evidence[0].chunk_hash).toBeTruthy();
    expect(typeof evidence[0].score).toBe('number');
  });

  it('没有可核验位置时标记 incomplete 而不是伪造页码', async () => {
    const { kbId, document } = await prepare();
    seedRetrievalChunk(harness, {
      documentId: document.documentId,
      datasetId: document.datasetId,
      content: 'M21-CITE',
      positions: null,
    });

    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M21-CITE', kb_ids: [kbId] },
    });

    const evidence = response.body.data.evidence as any[];
    expect(evidence).toHaveLength(1);
    expect(evidence[0].source_locator.incomplete).toBe(true);
    expect(evidence[0].source_locator.page).toBeUndefined();
  });

  it('证据详情可按 evidence_id 回查，且携带同样的来源定位', async () => {
    const { kbId, document } = await prepare();
    seedRetrievalChunk(harness, {
      documentId: document.documentId,
      datasetId: document.datasetId,
      content: 'M21-CITE',
    });

    const retrieval = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M21-CITE', kb_ids: [kbId] },
    });
    const evidenceId = retrieval.body.data.evidence[0].evidence_id as string;

    const detail = await harness.request({
      method: 'GET',
      path: `/evidence/${evidenceId}`,
      token,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.data.evidence_id).toBe(evidenceId);
    expect(detail.body.data.knowledge_ref).toBe(document.knowledgeRef);
    expect(detail.body.data.locator.source_file_id).toBe(document.sourceRef);
  });

  it('来源下载返回原始字节与内容哈希', async () => {
    const { document } = await prepare();
    const response = await harness.request({
      method: 'GET',
      path: `/sources/${document.sourceRef}/versions/${document.version}/download`,
      token,
    });
    expect(response.status).toBe(200);
    // 哈希必须与上传原文的实际 sha256 一致，而不是只验证「是个 64 位十六进制」。
    const expected = createHash('sha256').update(document.content, 'utf8').digest('hex');
    expect(response.headers.get('x-content-sha256')).toBe(expected);
    expect(response.text).toContain('M21-CITE');
  });

  it('证据快照落库并记录授权修订号', async () => {
    const { kbId, document } = await prepare();
    seedRetrievalChunk(harness, {
      documentId: document.documentId,
      datasetId: document.datasetId,
      content: 'M21-CITE',
    });

    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M21-CITE', kb_ids: [kbId] },
    });
    const evidenceId = response.body.data.evidence[0].evidence_id as string;

    const { rows } = await harness.pool.query(
      `SELECT source_file_revision, chunk_id, chunk_hash, content_digest, authz_revision, locator
         FROM evidence WHERE scope_id = $1 AND id = $2`,
      [harness.projectId, evidenceId],
    );
    expect(rows).toHaveLength(1);
    // source_file_revision 存的是来源文件修订行的 uuid，版本号在 locator 里。
    expect(rows[0].source_file_revision).toBe(document.sourceRef);
    expect(rows[0].locator.source_file_version).toBe(document.version);
    expect(rows[0].chunk_id).toBeTruthy();
    expect(rows[0].chunk_hash).toBeTruthy();
    expect(rows[0].content_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(rows[0].authz_revision)).toBeGreaterThan(0);
  });

  it('授权被撤销后证据详情不可回查', async () => {
    const { kbId, document } = await prepare();
    seedRetrievalChunk(harness, {
      documentId: document.documentId,
      datasetId: document.datasetId,
      content: 'M21-CITE',
    });

    const retrieval = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M21-CITE', kb_ids: [kbId] },
    });
    const evidenceId = retrieval.body.data.evidence[0].evidence_id as string;

    await withTransaction(harness.pool, (client) =>
      knowledgeAuthorization.revokeDocument(client, {
        scopeId: harness.projectId,
        knowledgeId: document.knowledgeRef,
        knowledgeVersion: document.version,
        subject: 'user-1',
      }),
    );

    const detail = await harness.request({
      method: 'GET',
      path: `/evidence/${evidenceId}`,
      token,
    });
    expect(detail.status).toBe(404);
  });
});
