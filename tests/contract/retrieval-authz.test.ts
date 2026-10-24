import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import {
  createReadyKnowledgeBase,
  prepareApprovedDocument,
  seedRetrievalChunk,
} from '../helpers/flow.js';

/**
 * M16 / M18：检索路径上的权限与白名单边界。
 *
 * 断言口径：
 * - 缺少 knowledge:read 时检索被拒，且拒绝发生在上游之前（出口请求数为 0）；
 * - 文档详情同样按权限鉴权；
 * - 客户端显式引用「有权 + 无权」混合的知识集合时，不泄露无权资源的任何信息；
 * - 上游 HTTP 200 但业务码非 0 或结构不符时，整体失败，不得伪装成空结果；
 * - metadata 不能替代 ID 级别的白名单限制。
 */
describe('M16/M18 检索权限与白名单边界', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm16m18' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('缺少 knowledge:read 的主体检索被拒，且不产生任何上游请求', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M16 无检索权');
    const document = await prepareApprovedDocument(harness, token, kbId, { marker: 'M16-NOPERM' });
    seedRetrievalChunk(harness, {
      documentId: document.documentId,
      datasetId: document.datasetId,
      content: 'M16-NOPERM',
    });

    const noRetrieval = await harness.token({
      subject: 'user-no-read',
      permissions: ['knowledge:write'],
    });
    const before = harness.ragflow.calls.length;
    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token: noRetrieval,
      json: { query: 'M16-NOPERM', kb_ids: [kbId] },
    });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
    const upstreamCalls = harness.ragflow.calls.slice(before);
    expect(upstreamCalls.filter((call) => call.path === '/api/v1/retrieval')).toHaveLength(0);
  });

  it('缺少 knowledge:read 的主体读取文档详情被拒', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M16 详情鉴权');
    const document = await prepareApprovedDocument(harness, token, kbId, { marker: 'M16-DETAIL' });

    const noRead = await harness.token({
      subject: 'user-no-read',
      permissions: ['knowledge:write'],
    });
    const response = await harness.request({
      method: 'GET',
      path: `/knowledge/${document.knowledgeRef}/versions/${document.version}`,
      token: noRead,
    });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('客户端混传有权与无权知识时，无权部分不泄露存在性', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M16 混传');
    const document = await prepareApprovedDocument(harness, token, kbId, { marker: 'M16-MIX' });

    const otherToken = await harness.token({
      subject: 'user-other',
      permissions: ALL_PERMISSIONS,
    });
    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token: otherToken,
      json: {
        query: 'M16-MIX',
        kb_ids: [kbId],
        knowledge_refs: [document.knowledgeRef, '2f1f0f3a-0f3a-4f0a-9a0f-0a1b2c3d4e5f'],
      },
    });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
    expect(JSON.stringify(response.body)).not.toContain(document.knowledgeRef);
  });

  it('上游 HTTP 200 但业务码非 0 时整体失败，不伪装成空结果', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M18 业务码非零');
    const document = await prepareApprovedDocument(harness, token, kbId, { marker: 'M18-CODE' });
    seedRetrievalChunk(harness, {
      documentId: document.documentId,
      datasetId: document.datasetId,
      content: 'M18-CODE',
    });
    harness.ragflow.enqueue(
      (call) => call.method === 'POST' && call.path === '/api/v1/retrieval',
      {
        status: 200,
        body: { code: 500, message: 'upstream rejected', data: null },
      },
    );

    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M18-CODE', kb_ids: [kbId] },
    });

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.body.data).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('M18-CODE');
  });

  it('上游回包结构不符时整体失败', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M18 结构不符');
    const document = await prepareApprovedDocument(harness, token, kbId, { marker: 'M18-SHAPE' });
    seedRetrievalChunk(harness, {
      documentId: document.documentId,
      datasetId: document.datasetId,
      content: 'M18-SHAPE',
    });
    harness.ragflow.enqueue(
      (call) => call.method === 'POST' && call.path === '/api/v1/retrieval',
      {
        status: 200,
        body: { code: 0, message: 'success', data: { chunks: 'not-an-array' } },
      },
    );

    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M18-SHAPE', kb_ids: [kbId] },
    });

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.body.data).toBeUndefined();
  });

  it('metadata 不能替代 ID 级别的白名单限制', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M18 metadata 伪装');
    const document = await prepareApprovedDocument(harness, token, kbId, { marker: 'M18-META' });
    // 上游把未授权文档伪装成白名单内的 metadata：document_id 仍然越权。
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
                id: 'chunk-meta-spoof',
                content: 'M18-META',
                document_id: 'doc-not-authorized',
                dataset_id: document.datasetId,
                metadata: { document_id: document.documentId },
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
      json: { query: 'M18-META', kb_ids: [kbId] },
    });

    expect(response.status).toBe(502);
    expect(response.body.code).toBe('RAGFLOW_PROTOCOL_ERROR');
    expect(response.body.data).toBeUndefined();
  });
});
