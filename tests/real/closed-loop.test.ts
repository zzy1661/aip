import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { knowledgeAuthorization, withTransaction } from '@aip/api';
import {
  checkRealUpstreamUsed,
  createRealHarness,
  isRealEnabled,
  loadRealEnv,
  missingRealEnv,
  readRecordedUpstreamIdentity,
  waitForKnowledgeReady,
  type RealEnv,
  type RealHarness,
} from './helpers.js';

/**
 * M26：真实 RAGFlow 闭环。
 *
 * 未设置 RUN_REAL_RAGFLOW=1 时报告 NOT RUN 并跳过；
 * 设置了但配置不齐时必须失败并列出缺失项。
 *
 * **抗替身断言**：harness 无论如何都会起一个记录式替身，
 * 单看「用例通过」无法区分「打到了真实 RAGFlow」与「接线退化成替身」。
 * 因此本文件用三条信号把这件事钉死：
 * 真实传输被调用过、替身一次都没被调用、平台记录的上游数据集确实存在于真实上游。
 * 反向对照见 `tests/real/anti-substitute.test.ts`。
 */
describe('M26 真实 RAGFlow 闭环', () => {
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
        'asset:read',
        'asset:write',
        'asset:manage',
        'asset:bind',
        'knowledge:read',
        'knowledge:write',
        'knowledge:review',
        'knowledge:manage',
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
        `[real] M26 NOT RUN：RUN_REAL_RAGFLOW 未设置为 1。缺失配置项：${missing.join(', ')}`,
      );
      expect(process.env.RUN_REAL_RAGFLOW ?? '').not.toBe('1');
      return;
    }
    // 启用了就必须配置齐全，否则整层以非零退出码结束。
    expect(missing, `缺少配置项：${missing.join(', ')}`).toEqual([]);
  });

  it('建知识库 -> 上传 -> 解析 -> 审核 -> 检索拿到带来源引用的证据', async (ctx) => {
    if (!isRealEnabled()) {
      ctx.skip();
      return;
    }

    // 1. 建知识库。
    const kb = await harness.request({
      method: 'POST',
      path: '/knowledge-bases',
      token,
      idempotencyKey: `real-kb-${Date.now()}`,
      json: { name: `real-闭环-${Date.now()}`, description: '真实联调' },
    });
    expect(kb.status).toBe(202);
    const kbId = kb.body.data.kb_id as string;
    await harness.advanceAll();

    // 1.1 抗替身断言：建库这一步必须真的落到真实 RAGFlow 上。
    // 平台声称的上游数据集 id 要能在真实上游按名查到，
    // 且记录式替身一次都没被调用——否则「用例通过」只说明接线指向了某个替身。
    const identity = await readRecordedUpstreamIdentity(
      harness,
      env,
      kb.body.data.operation_id as string,
    );
    expect(
      await checkRealUpstreamUsed(harness, env, identity),
      '真实上游没有被真正使用：这一轮不能算真实联调证据',
    ).toEqual([]);

    // 2. 上传文档。
    const marker = `REAL-LOOP-${Date.now()}`;
    const content = `# 真实联调样本\n\n唯一标记：${marker}\n\n用于验证真实 RAGFlow 的解析与检索。\n`;
    const upload = await harness.request({
      method: 'POST',
      path: `/knowledge-bases/${kbId}/documents`,
      token,
      idempotencyKey: `real-doc-${Date.now()}`,
      fields: {
        version: '1.0.0',
        applies_to: JSON.stringify({ mode: 'unconditional' }),
      },
      file: {
        filename: `${marker}.md`,
        contentType: 'text/markdown',
        content,
      },
    });
    expect(upload.status).toBe(202);
    const knowledgeRef = upload.body.data.knowledge_ref as string;

    // 3. 等待解析完成（真实上游可能需要一段时间）。
    const settled = await waitForKnowledgeReady(
      harness,
      token,
      knowledgeRef,
      '1.0.0',
      env.parseTimeoutMs,
    );
    expect(settled.status).toBe('ready');

    // 4. 审核通过。
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

    // 5. 检索并校验来源引用。
    const retrieval = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: marker, kb_ids: [kbId] },
    });
    expect(retrieval.status).toBe(200);
    expect(retrieval.body.data.status).toBe('authorized_evidence');
    const evidence = retrieval.body.data.evidence as Array<Record<string, any>>;
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence[0]!.knowledge_ref).toBe(knowledgeRef);
    expect(evidence[0]!.source_locator.source_file_id).toBe(upload.body.data.source_ref);
    expect(evidence[0]!.source_locator.source_file_version).toBe('1.0.0');
    expect(evidence[0]!.chunk_id).toBeTruthy();
    expect(evidence[0]!.chunk_hash).toBeTruthy();

    // 5.1 引用的来源可核验：下载到的字节与上传原文逐字节相同，哈希一致。
    const download = await harness.request({
      method: 'GET',
      path: `/sources/${upload.body.data.source_ref}/versions/1.0.0/download`,
      token,
    });
    expect(download.status).toBe(200);
    expect(download.text).toBe(content);
    expect(download.headers.get('x-content-sha256')).toBe(
      createHash('sha256').update(content).digest('hex'),
    );

    // 6. 撤销授权后，同一主体不再能拿到该文档的证据。
    await withTransaction(harness.pool, (client) =>
      knowledgeAuthorization.revokeDocument(client, {
        scopeId: env.projectId,
        knowledgeId: knowledgeRef,
        knowledgeVersion: '1.0.0',
        subject: 'user-1',
      }),
    );
    const afterRevoke = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: marker, kb_ids: [kbId] },
    });
    expect(afterRevoke.status).toBe(200);
    expect(afterRevoke.body.data.evidence).toHaveLength(0);
  });
});
