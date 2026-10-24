import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkRealUpstreamUsed,
  createRealHarness,
  isRealEnabled,
  loadRealEnv,
  missingRealEnv,
  readRecordedUpstreamIdentity,
  type RealEnv,
  type RealHarness,
} from './helpers.js';

/**
 * M26 抗替身断言的**反向对照**。
 *
 * 背景：`createHarness` 无论如何都会起一个记录式替身。
 * 如果上游接线退化成替身，M26 的用例会照样绿——
 * 「用例通过」就不再等价于「打到了真实 RAGFlow」。
 *
 * 本文件把这件事变成可复现的证据：
 * 把这一轮的上游换成 harness **自带**的记录式替身（`useSubstituteUpstream`，
 * 这就是接线退化时的真实形态），跑同一条建库路径，然后断言：
 *
 * 1. 替身确实接住了全部流量（说明「接线退化成替身」这个场景真的能跑绿）；
 * 2. 平台侧依然把知识库判成 `ready`（说明旧断言发现不了这个问题）；
 * 3. **抗替身断言必须报告违规**——这才是防退化的那条护栏。
 *
 * 反向对照不写真实上游（上游是替身），因此不会在共享栈里留下数据集。
 */

const PERMISSIONS = [
  'knowledge:read',
  'knowledge:write',
  'knowledge:review',
  'source:read',
  'operations:read',
] as const;

describe('M26 抗替身反向对照', () => {
  let env: RealEnv;
  let harness: RealHarness;

  beforeAll(async () => {
    if (!isRealEnabled()) {
      return;
    }
    env = loadRealEnv();
    harness = await createRealHarness(env, { useSubstituteUpstream: true });
  });

  afterAll(async () => {
    if (harness) await harness.close();
  });

  it('联调前置检查：未启用时报告 NOT RUN 与缺失配置项', () => {
    const missing = missingRealEnv();
    if (!isRealEnabled()) {
      console.warn(
        `[real] M26 抗替身反向对照 NOT RUN：RUN_REAL_RAGFLOW 未设置为 1。缺失配置项：${missing.join(', ')}`,
      );
      expect(process.env.RUN_REAL_RAGFLOW ?? '').not.toBe('1');
      return;
    }
    expect(missing, `缺少配置项：${missing.join(', ')}`).toEqual([]);
  });

  it('上游退化成替身时：流程照样跑绿，但抗替身断言必须报告违规', async (ctx) => {
    if (!isRealEnabled()) {
      ctx.skip();
      return;
    }

    const token = await harness.token({ permissions: PERMISSIONS });
    const kb = await harness.request({
      method: 'POST',
      path: '/knowledge-bases',
      token,
      idempotencyKey: `real-substitute-kb-${Date.now()}`,
      json: { name: `real-替身对照-${Date.now()}`, description: '抗替身反向对照' },
    });
    expect(kb.status).toBe(202);
    const operationId = kb.body.data.operation_id as string;
    await harness.advanceAll();

    // 1. 替身接住了全部流量：退化场景确实能跑。
    expect(harness.ragflow.calls.length).toBeGreaterThan(0);

    // 2. 平台侧照样把知识库判成 ready：旧断言发现不了这个问题。
    const detail = await harness.request({
      method: 'GET',
      path: `/knowledge-bases/${kb.body.data.kb_id}`,
      token,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.data.status).toBe('ready');

    // 3. 抗替身断言必须报告违规：这是防退化的护栏。
    const identity = await readRecordedUpstreamIdentity(harness, env, operationId);
    const violations = await checkRealUpstreamUsed(harness, env, identity);
    // 把违规项打进运行日志：反向对照的证据要能从测试输出里直接看到。
    console.warn(`[real] 抗替身反向对照：检出 ${violations.length} 条违规 → ${violations.join(' | ')}`);
    expect(violations.length).toBeGreaterThan(0);
    // 两条必须报出来的违规：替身接了请求、真实上游没有这份写入。
    expect(violations.join(' | ')).toContain('记录式替身');
    expect(violations.join(' | ')).toContain('真实上游');
  });
});
