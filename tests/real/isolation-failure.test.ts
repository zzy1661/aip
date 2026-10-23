import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createRealHarness,
  isRealEnabled,
  loadRealEnv,
  missingRealEnv,
  waitForKnowledgeReady,
  type RealEnv,
  type RealHarness,
} from './helpers.js';

/**
 * M27：真实 RAGFlow 隔离失败。
 *
 * 断言口径：
 * - 无权文档不出现在真实检索结果中；
 * - 授权为空时，一次上游请求都不允许发生（用真实传输计数断言）。
 *
 * 「上游返回白名单之外文档时整体失败」这一分支由替身层
 * （tests/contract/ragflow-authorization.test.ts）验证，真实上游无法构造该响应。
 */
describe('M27 真实 RAGFlow 隔离失败', () => {
  let harness: RealHarness;
  let env: RealEnv;
  let token: string;

  beforeAll(async () => {
    if (!isRealEnabled()) {
      return;
    }
    env = loadRealEnv();
    harness = await createRealHarness(env);
    token = await harness.token({
      permissions: [
        'knowledge:read',
        'knowledge:write',
        'knowledge:review',
        'source:read',
        'operations:read',
      ],
    });
  });

  afterAll(async () => {
    if (harness) await harness.close();
  });

  it('联调前置检查：未启用时报告 NOT RUN 与缺失配置项', () => {
    const missing = missingRealEnv();
    if (!isRealEnabled()) {
      console.warn(
        `[real] M27 NOT RUN：RUN_REAL_RAGFLOW 未设置为 1。缺失配置项：${missing.join(', ')}`,
      );
      expect(process.env.RUN_REAL_RAGFLOW ?? '').not.toBe('1');
      return;
    }
    expect(missing, `缺少配置项：${missing.join(', ')}`).toEqual([]);
  });

  it('授权为空时真实上游请求数为 0', async (ctx) => {
    if (!isRealEnabled()) {
      ctx.skip();
      return;
    }

    const kb = await harness.request({
      method: 'POST',
      path: '/knowledge-bases',
      token,
      idempotencyKey: `real-iso-kb-${Date.now()}`,
      json: { name: `real-隔离-${Date.now()}`, description: '真实联调' },
    });
    expect(kb.status).toBe(202);
    const kbId = kb.body.data.kb_id as string;
    await harness.advanceAll();

    // 另一个主体对这份知识库没有任何授权。
    const otherToken = await harness.token({ subject: 'user-no-grant', permissions: ['knowledge:read'] });
    const before = harness.realCallCount();
    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token: otherToken,
      json: { query: '隔离验证', kb_ids: [kbId] },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('no_match');
    expect(response.body.data.evidence).toHaveLength(0);
    expect(harness.realCallCount() - before).toBe(0);
  });

  it('无权文档不出现在真实检索结果中', async (ctx) => {
    if (!isRealEnabled()) {
      ctx.skip();
      return;
    }

    const kb = await harness.request({
      method: 'POST',
      path: '/knowledge-bases',
      token,
      idempotencyKey: `real-iso-kb2-${Date.now()}`,
      json: { name: `real-隔离2-${Date.now()}`, description: '真实联调' },
    });
    const kbId = kb.body.data.kb_id as string;
    await harness.advanceAll();

    const marker = `REAL-ISO-${Date.now()}`;
    const upload = await harness.request({
      method: 'POST',
      path: `/knowledge-bases/${kbId}/documents`,
      token,
      idempotencyKey: `real-iso-doc-${Date.now()}`,
      fields: { version: '1.0.0', applies_to: JSON.stringify({ mode: 'unconditional' }) },
      file: {
        filename: `${marker}.md`,
        contentType: 'text/markdown',
        content: `# 隔离样本\n\n唯一标记：${marker}\n`,
      },
    });
    expect(upload.status).toBe(202);
    const knowledgeRef = upload.body.data.knowledge_ref as string;

    const settled = await waitForKnowledgeReady(
      harness,
      token,
      knowledgeRef,
      '1.0.0',
      env.parseTimeoutMs,
    );
    expect(settled.status).toBe('ready');

    const detail = await harness.request({
      method: 'GET',
      path: `/knowledge/${knowledgeRef}/versions/1.0.0`,
      token,
    });
    const review = await harness.request({
      method: 'POST',
      path: `/knowledge/${knowledgeRef}/versions/1.0.0/review`,
      token,
      json: {
        decision: 'approved',
        expected_hash: detail.body.data.content_hash,
        reason: '真实联调审核',
      },
    });
    expect(review.status).toBe(200);

    // 上传者本人可以检索到。
    const allowed = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: marker, kb_ids: [kbId] },
    });
    expect(allowed.status).toBe(200);
    const evidence = allowed.body.data.evidence as Array<Record<string, any>>;
    expect(evidence.length).toBeGreaterThan(0);

    // 另一个主体即使显式引用该知识版本，也拿不到内容。
    const otherToken = await harness.token({ subject: 'user-no-grant', permissions: ['knowledge:read'] });
    const denied = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token: otherToken,
      json: { query: marker, kb_ids: [kbId], knowledge_refs: [knowledgeRef] },
    });
    expect(denied.status).toBe(404);
    expect(denied.body.code).toBe('NOT_FOUND');
  });
});
