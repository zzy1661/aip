import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import {
  createReadyKnowledgeBase,
  prepareApprovedDocument,
  seedRetrievalChunk,
  uploadAndParse,
} from '../helpers/flow.js';

/**
 * M16：文档级授权检索与来源引用。
 *
 * 断言口径：只有授权范围内的文档进入上游白名单；证据必须带可核验的来源定位；
 * 上游返回白名单外的内容一律整体失败。
 */
describe('M16 授权检索与来源引用', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm16' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('授权范围内的检索返回证据与来源引用', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M16 知识库');
    const document = await prepareApprovedDocument(harness, token, kbId, { marker: 'M16-DOC' });
    seedRetrievalChunk(harness, {
      documentId: document.documentId,
      datasetId: document.datasetId,
      content: '包含 M16-DOC 的知识片段',
    });

    const before = harness.ragflow.calls.length;
    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M16-DOC', kb_ids: [kbId] },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('authorized_evidence');
    const evidence = response.body.data.evidence;
    expect(evidence).toHaveLength(1);
    expect(evidence[0].knowledge_ref).toBe(document.knowledgeRef);
    expect(evidence[0].knowledge_version).toBe(document.version);
    expect(evidence[0].source_locator.source_file_id).toBe(document.sourceRef);
    expect(evidence[0].source_locator.source_file_version).toBe(document.version);
    expect(evidence[0].content).toContain('M16-DOC');
    expect(evidence[0].chunk_hash).toMatch(/^[0-9a-f]{64}$/);

    const retrievalCalls = harness.ragflow.calls
      .slice(before)
      .filter((call) => call.method === 'POST' && call.path === '/api/v1/retrieval');
    expect(retrievalCalls).toHaveLength(1);
    const payload = JSON.parse(retrievalCalls[0]!.body);
    expect(payload.dataset_ids).toEqual([document.datasetId]);
    expect(payload.document_ids).toEqual([document.documentId]);
  });

  it('未审核通过的知识不进入白名单，也不触发上游调用', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M16 未审核');
    const document = await uploadAndParse(harness, token, kbId, { marker: 'M16-PENDING' });
    seedRetrievalChunk(harness, {
      documentId: document.documentId,
      datasetId: document.datasetId,
      content: 'M16-PENDING',
    });

    const before = harness.ragflow.calls.length;
    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M16-PENDING', kb_ids: [kbId] },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('no_match');
    expect(response.body.data.evidence).toHaveLength(0);
    const upstreamCalls = harness.ragflow.calls.slice(before);
    expect(upstreamCalls.filter((call) => call.path === '/api/v1/retrieval')).toHaveLength(0);
  });

  it('上游返回白名单之外的文档时整体失败', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M16 越权回包');
    const document = await prepareApprovedDocument(harness, token, kbId, { marker: 'M16-IN' });
    seedRetrievalChunk(harness, {
      documentId: document.documentId,
      datasetId: document.datasetId,
      content: 'M16-IN',
    });
    // 模拟上游忽略白名单过滤：直接回一个未授权文档的分块。
    harness.ragflow.enqueue(
      (call) => call.method === 'POST' && call.path === '/api/v1/retrieval',
      {
        status: 200,
        body: {
          code: 0,
          message: 'success',
          data: {
            chunks: [
              {
                id: 'chunk-out-of-scope',
                content: 'M16-OUT',
                document_id: 'doc-not-authorized',
                dataset_id: document.datasetId,
                similarity: 0.9,
              },
            ],
          },
        },
      },
    );

    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M16', kb_ids: [kbId] },
    });

    expect(response.status).toBe(502);
    expect(response.body.code).toBe('RAGFLOW_PROTOCOL_ERROR');
    expect(response.body.data).toBeUndefined();
  });

  it('显式引用无权访问的知识时按 404 处理，不泄露资源是否存在', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M16 显式引用');
    const document = await prepareApprovedDocument(harness, token, kbId, { marker: 'M16-REF' });

    const otherToken = await harness.token({
      subject: 'user-2',
      permissions: ALL_PERMISSIONS,
    });
    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token: otherToken,
      json: { query: 'M16-REF', kb_ids: [kbId], knowledge_refs: [document.knowledgeRef] },
    });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });
});
