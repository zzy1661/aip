import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { knowledgeAuthorization } from '@aip/api';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import {
  createReadyKnowledgeBase,
  prepareApprovedDocument,
  seedRetrievalChunk,
} from '../helpers/flow.js';

/**
 * M17 / M20：撤回后的授权边界。
 *
 * 断言口径：
 * - 授权集合里只剩已撤回的知识时，检索必须返回 no_match，
 *   并且不得产生任何外部 HTTP 请求（零出口调用）；
 * - 授权集合里同时存在未撤回知识时，已撤回的文档不得进入上游白名单。
 */
describe('M17/M20 撤回后的授权边界', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'withdrawn' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  async function withdraw(knowledgeRef: string, version: string): Promise<void> {
    const detail = await harness.request({
      method: 'GET',
      path: `/knowledge/${knowledgeRef}/versions/${version}`,
      token,
    });
    const response = await harness.request({
      method: 'POST',
      path: `/knowledge/${knowledgeRef}/versions/${version}/withdraw`,
      token,
      json: {
        expected_state_revision: detail.body.data.state_revision as number,
        reason: '授权集合边界验证',
      },
    });
    expect(response.status).toBe(200);
  }

  it('授权集合里只有已撤回知识时，检索返回 no_match 且零上游调用', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M17 撤回授权');
    const document = await prepareApprovedDocument(harness, token, kbId, {
      marker: 'M17-WITHDRAWN',
    });
    seedRetrievalChunk(harness, {
      documentId: document.documentId,
      datasetId: document.datasetId,
      content: 'M17-WITHDRAWN',
    });

    await withdraw(document.knowledgeRef, document.version);

    const before = harness.ragflow.calls.length;
    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M17-WITHDRAWN', kb_ids: [kbId] },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('no_match');
    expect(response.body.data.evidence).toEqual([]);
    // 授权集合为空时不得发出任何上游请求。
    expect(harness.ragflow.calls.slice(before)).toHaveLength(0);
    expect(
      harness.ragflow.calls.filter((call) => call.path === '/api/v1/retrieval'),
    ).toHaveLength(0);
  });

  it('已撤回的知识不再出现在检索白名单里', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M17 白名单');
    const document = await prepareApprovedDocument(harness, token, kbId, {
      marker: 'M17-WHITELIST',
    });

    const beforeWithdraw = await knowledgeAuthorization.listAuthorizedDocuments(harness.pool, {
      scopeId: harness.projectId,
      subject: 'user-1',
      kbIds: [kbId],
    });
    expect(beforeWithdraw.map((entry) => entry.knowledge_id)).toContain(
      document.knowledgeRef,
    );

    await withdraw(document.knowledgeRef, document.version);

    const afterWithdraw = await knowledgeAuthorization.listAuthorizedDocuments(harness.pool, {
      scopeId: harness.projectId,
      subject: 'user-1',
      kbIds: [kbId],
    });
    expect(afterWithdraw).toEqual([]);
  });

  it('授权集合里同时存在未撤回知识时，已撤回文档不进入上游白名单', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M20 混合授权');
    const withdrawn = await prepareApprovedDocument(harness, token, kbId, {
      marker: 'M20-WITHDRAWN',
      version: '1.0.0',
    });
    const kept = await prepareApprovedDocument(harness, token, kbId, {
      marker: 'M20-KEPT',
      version: '2.0.0',
    });
    seedRetrievalChunk(harness, {
      documentId: withdrawn.documentId,
      datasetId: withdrawn.datasetId,
      content: 'M20-WITHDRAWN',
    });
    seedRetrievalChunk(harness, {
      documentId: kept.documentId,
      datasetId: kept.datasetId,
      content: 'M20-KEPT',
    });

    await withdraw(withdrawn.knowledgeRef, withdrawn.version);

    const before = harness.ragflow.calls.length;
    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M20', kb_ids: [kbId] },
    });

    expect(response.status).toBe(200);
    const evidence = response.body.data.evidence as any[];
    expect(evidence).toHaveLength(1);
    expect(evidence[0].knowledge_ref).toBe(kept.knowledgeRef);

    // 上游检索只能收到未撤回文档的 id。
    const upstreamCalls = harness.ragflow.calls.slice(before);
    const retrievalCalls = upstreamCalls.filter((call) => call.path === '/api/v1/retrieval');
    expect(retrievalCalls).toHaveLength(1);
    const body = JSON.parse(retrievalCalls[0]!.body || '{}') as {
      document_ids?: string[];
    };
    expect(body.document_ids).toEqual([kept.documentId]);
  });
});
