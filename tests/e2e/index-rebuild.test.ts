import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import {
  completeUpstreamParse,
  createReadyKnowledgeBase,
  prepareApprovedDocument,
  seedRetrievalChunk,
} from '../helpers/flow.js';

/**
 * M-10 / 原 M21：索引重建后旧 evidence 仍可读。
 *
 * 断言口径：
 * - 重建产生新的索引修订与新的映射行，旧映射不被覆盖；
 * - 重建前产生的 evidence 仍按自己的 index_revision 可读；
 * - 重建后的检索使用新的索引修订；
 * - 重建不重新上传文件，也不改变审核结论。
 */
describe('M-10 索引重建保留旧引用', () => {
  let harness: Harness;
  let token: string;
  let kbId: string;
  let knowledgeRef: string;
  let version: string;
  let documentId: string;
  let datasetId: string;
  let firstEvidenceId: string;
  let firstIndexRevision: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'reindex' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
    const kb = await createReadyKnowledgeBase(harness, token, 'M10 重建知识库');
    kbId = kb.kbId;
    const document = await prepareApprovedDocument(harness, token, kbId, { marker: 'M10-REINDEX' });
    knowledgeRef = document.knowledgeRef;
    version = document.version;
    documentId = document.documentId;
    datasetId = document.datasetId;
    seedRetrievalChunk(harness, { documentId, datasetId, content: 'M10-REINDEX' });
  });

  afterAll(async () => {
    await harness.close();
  });

  async function retrieve(): Promise<any> {
    return harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M10-REINDEX', kb_ids: [kbId] },
    });
  }

  it('重建前检索产生一条绑定首个索引修订的证据', async () => {
    const response = await retrieve();
    expect(response.status).toBe(200);
    const evidence = response.body.data.evidence as any[];
    expect(evidence).toHaveLength(1);
    expect(evidence[0].index_revision).toBeTruthy();
    firstEvidenceId = evidence[0].evidence_id as string;
    firstIndexRevision = evidence[0].index_revision as string;
  });

  it('重建产生新的索引修订与新的映射行，旧映射不被覆盖', async () => {
    const reindex = await harness.request({
      method: 'POST',
      path: `/knowledge/${knowledgeRef}/versions/${version}/reindex`,
      token,
      idempotencyKey: 'm10-reindex-1',
    });
    expect(reindex.status).toBe(202);
    const operationId = reindex.body.data.operation_id as string;
    expect(operationId).toBeTruthy();

    await harness.advanceAll();
    completeUpstreamParse(harness, { documentId });
    await harness.advanceAll();

    const operation = await harness.request({
      method: 'GET',
      path: `/operations/${operationId}`,
      token,
    });
    expect(operation.status).toBe(200);
    expect(operation.body.data.state).toBe('succeeded');

    const { rows } = await harness.pool.query(
      `SELECT id, status FROM index_revision
        WHERE scope_id = $1 AND knowledge_id = $2 AND knowledge_version = $3
        ORDER BY created_at`,
      [harness.projectId, knowledgeRef, version],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(firstIndexRevision);
    // 旧修订保留在库中，只标记为已被取代，不删除。
    expect(rows[0].status).toBe('superseded');
    expect(rows[1].status).toBe('ready');

    const mappings = await harness.pool.query(
      `SELECT index_revision FROM knowledge_index_map
        WHERE scope_id = $1 AND document_id = $2`,
      [harness.projectId, documentId],
    );
    expect(mappings.rows).toHaveLength(2);
  });

  it('重建前的旧 evidence 仍然可读，且仍指向旧的索引修订', async () => {
    const detail = await harness.request({
      method: 'GET',
      path: `/evidence/${firstEvidenceId}`,
      token,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.data.index_revision).toBe(firstIndexRevision);
  });

  it('重建后的检索使用新的索引修订', async () => {
    const after = await retrieve();
    const newIndexRevision = after.body.data.evidence[0].index_revision as string;
    expect(newIndexRevision).not.toBe(firstIndexRevision);
  });

  it('重建不重新上传文件，也不改变审核结论', async () => {
    const uploadsBefore = harness.ragflow.calls.filter(
      (call) => call.method === 'POST' && /\/documents$/.test(call.path),
    ).length;

    await harness.request({
      method: 'POST',
      path: `/knowledge/${knowledgeRef}/versions/${version}/reindex`,
      token,
      idempotencyKey: 'm10-reindex-2',
    });
    await harness.advanceAll();
    completeUpstreamParse(harness, { documentId });
    await harness.advanceAll();

    const uploadsAfter = harness.ragflow.calls.filter(
      (call) => call.method === 'POST' && /\/documents$/.test(call.path),
    ).length;
    expect(uploadsAfter).toBe(uploadsBefore);

    const detail = await harness.request({
      method: 'GET',
      path: `/knowledge/${knowledgeRef}/versions/${version}`,
      token,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.data.review_status).toBe('approved');
    expect(detail.body.data.status).toBe('ready');
  });

  it('缺少 knowledge:manage 的主体不能触发重建', async () => {
    const readerToken = await harness.token({
      subject: 'reader-1',
      permissions: ['knowledge:read', 'source:read'],
    });
    const response = await harness.request({
      method: 'POST',
      path: `/knowledge/${knowledgeRef}/versions/${version}/reindex`,
      token: readerToken,
      idempotencyKey: 'm10-reindex-forbidden',
    });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('对不存在的知识版本重建返回 404', async () => {
    const response = await harness.request({
      method: 'POST',
      path: `/knowledge/${knowledgeRef}/versions/9.9.9/reindex`,
      token,
      idempotencyKey: 'm10-reindex-missing',
    });
    expect(response.status).toBe(404);
  });
});
