import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { createReadyKnowledgeBase, uploadSampleDocument } from '../helpers/flow.js';

/**
 * M14：用户可见的 stale 标记。
 *
 * 写请求的响应丢失后，用户的 GET 必须给出明确状态，
 * 不能用「没有匹配」或「还在解析」掩盖「上游结果未知」。
 */
describe('M14 用户可见的 stale 标记', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'stale' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('上游写响应丢失后 GET 返回 stale=true 与明确的未知状态', async () => {
    const kb = await createReadyKnowledgeBase(harness, token, 'stale 知识库');
    harness.ragflow.reset();
    harness.ragflow.dropNext(
      (call) => call.method === 'POST' && call.path.includes('/documents'),
    );

    const uploaded = await uploadSampleDocument(harness, token, kb.kbId, {
      marker: 'M14-STALE',
    });
    await harness.advanceAll();

    const detail = await harness.request({
      method: 'GET',
      path: `/knowledge/${uploaded.knowledgeRef}/versions/${uploaded.version}`,
      token,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.data.stale).toBe(true);
    expect(detail.body.data.status).toBe('unknown_outcome');
    expect(detail.body.data.index_revision).toBeNull();
    expect(detail.body.data.chunk_count).toBeNull();
  });

  it('正常解析完成的知识版本 stale=false', async () => {
    const kb = await createReadyKnowledgeBase(harness, token, 'stale 正常知识库');
    const uploaded = await uploadSampleDocument(harness, token, kb.kbId, {
      marker: 'M14-NOT-STALE',
    });
    await harness.advanceAll();

    const detail = await harness.request({
      method: 'GET',
      path: `/knowledge/${uploaded.knowledgeRef}/versions/${uploaded.version}`,
      token,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.data.stale).toBe(false);
  });
});
