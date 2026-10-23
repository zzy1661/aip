import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import {
  createReadyKnowledgeBase,
  prepareApprovedDocument,
  seedRetrievalChunk,
} from '../helpers/flow.js';

/**
 * M19：上游故障处理与只读重试预算。
 *
 * 断言口径：
 * - 上游 5xx 是可重试的上游故障，重试次数有上限，错误落成 503 而不是 500；
 * - 单次超时不得超过剩余预算，「多次尝试 + 退避」的总耗时不得超过总预算。
 */
describe('M19 上游故障与重试预算', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({
      label: 'm19',
      readTimeoutMs: 10_000,
      readBudgetMs: 3_000,
      maxReadAttempts: 3,
    });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  async function prepareDocument(): Promise<{ kbId: string }> {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M19 知识库');
    const document = await prepareApprovedDocument(harness, token, kbId, { marker: 'M19-DOC' });
    seedRetrievalChunk(harness, {
      documentId: document.documentId,
      datasetId: document.datasetId,
      content: 'M19-DOC',
    });
    return { kbId };
  }

  it('上游 5xx 时重试次数有上限，并返回 503 而不是 500', async () => {
    const { kbId } = await prepareDocument();
    harness.ragflow.enqueue(
      (call) => call.method === 'POST' && call.path === '/api/v1/retrieval',
      { status: 503, body: { code: 503, data: null, message: 'upstream busy' } },
      5,
    );

    const before = harness.ragflow.calls.length;
    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M19-DOC', kb_ids: [kbId] },
    });

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('RAGFLOW_UNAVAILABLE');

    const attempts = harness.ragflow.calls
      .slice(before)
      .filter((call) => call.path === '/api/v1/retrieval').length;
    expect(attempts).toBeGreaterThan(0);
    expect(attempts).toBeLessThanOrEqual(3);
  });

  it('单次超时被限制在剩余预算内，总耗时不超过只读预算', async () => {
    const { kbId } = await prepareDocument();
    harness.ragflow.enqueue(
      (call) => call.method === 'POST' && call.path === '/api/v1/retrieval',
      { status: 200, body: { code: 0, data: { chunks: [] }, message: 'success' }, delayMs: 60_000 },
      5,
    );

    const startedAt = Date.now();
    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M19-DOC', kb_ids: [kbId] },
    });
    const elapsed = Date.now() - startedAt;

    expect(response.status).toBe(504);
    expect(response.body.code).toBe('RAGFLOW_TIMEOUT');
    // 单次超时是 10s、预算只有 3s：如果不按剩余预算切分，耗时会到 10s 以上。
    expect(elapsed).toBeLessThan(3_500);
    expect(elapsed).toBeGreaterThan(2_000);
  });
});
