import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { createReadyKnowledgeBase } from '../helpers/flow.js';

/**
 * M22：可授权文档数量上限按真实阈值在边界拒绝。
 *
 * 断言口径：
 * - 生产默认阈值是 200（见 tests/unit/config-defaults.test.ts）；
 * - 客户端一次提交 201 个知识引用时，在边界就被拒绝，且不产生任何上游请求。
 */
describe('M22 可授权文档数量上限', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm22count' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('一次提交 201 个知识引用时按契约拒绝，且不产生上游请求', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M22 文档数量');
    const refs = Array.from({ length: 201 }, () => randomUUID());

    const before = harness.ragflow.calls.length;
    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M22', kb_ids: [kbId], knowledge_refs: refs },
    });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('CONTRACT_INVALID');
    const upstreamCalls = harness.ragflow.calls.slice(before);
    expect(upstreamCalls.filter((call) => call.path === '/api/v1/retrieval')).toHaveLength(0);
  });

  it('正好 200 个知识引用时通过边界校验', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M22 文档数量边界');
    const refs = Array.from({ length: 200 }, () => randomUUID());

    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M22', kb_ids: [kbId], knowledge_refs: refs },
    });

    // 200 个引用可以进入授权判定；这些引用都不存在，因此按资源缺失处理。
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });
});
