import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createRealHarness,
  isRealEnabled,
  loadRealEnv,
  missingRealEnv,
  probeConnection,
  reserveClosedPort,
  waitForKnowledgeReady,
  type RealEnv,
  type RealHarness,
} from './helpers.js';

/**
 * M27 判据一：真实不可达 → 503 / 504。
 *
 * 取证方式：**真实网络失败**，不用替身。
 * 把这一轮的上游地址指向一个确实没有监听的本地端口，
 * 客户端的 TCP 连接会被内核直接拒绝（ECONNREFUSED），
 * 失败发生在「连接上游」这一层，与替身返回的伪造响应有本质区别：
 * - 替身层是「上游回了什么」，本层是「上游根本没连上」；
 * - 错误分类也不同：连接阶段失败属于 not_delivered（请求确定没有送达），
 *   对只读调用可以安全重试，对写调用可以安全重发。
 *
 * 断言口径：
 * - 检索（同步读路径）返回 503 RAGFLOW_UNAVAILABLE，不落成 500 / 内部错误；
 * - 不产生任何可检索的证据（没有半条成功状态）；
 * - 写路径不会把操作或资源判成成功。
 */

const PERMISSIONS = [
  'knowledge:read',
  'knowledge:write',
  'knowledge:review',
  'source:read',
  'operations:read',
] as const;

describe('M27 真实上游不可达', () => {
  let env: RealEnv;
  /** 指向真实 RAGFlow 的 harness：用来准备一份已授权的文档。 */
  let real: RealHarness;
  /** 指向确实没有监听的端口，且与 real 共享本地状态（读路径）。 */
  let offline: RealHarness;
  /** 指向确实没有监听的端口，独立 schema（写路径）。 */
  let offlineWrite: RealHarness;
  let token: string;
  let offlineToken: string;
  let closedPort = 0;
  let kbId = '';

  beforeAll(async () => {
    if (!isRealEnabled()) {
      return;
    }
    env = loadRealEnv();
    real = await createRealHarness(env);
    token = await real.token({ permissions: PERMISSIONS });

    // 1. 先在真实上游准备一份「已解析 + 已审核 + 已授权」的文档。
    //    没有这份状态，检索会在授权过滤阶段就短路返回 no_match，
    //    根本走不到网络，失败取证就变成空转。
    const kb = await real.request({
      method: 'POST',
      path: '/knowledge-bases',
      token,
      idempotencyKey: `real-unreach-kb-${Date.now()}`,
      json: { name: `real-不可达-${Date.now()}`, description: '真实不可达取证' },
    });
    expect(kb.status).toBe(202);
    kbId = kb.body.data.kb_id as string;
    await real.advanceAll();

    const marker = `REAL-UNREACHABLE-${Date.now()}`;
    const upload = await real.request({
      method: 'POST',
      path: `/knowledge-bases/${kbId}/documents`,
      token,
      idempotencyKey: `real-unreach-doc-${Date.now()}`,
      fields: { version: '1.0.0', applies_to: JSON.stringify({ mode: 'unconditional' }) },
      file: {
        filename: `${marker}.md`,
        contentType: 'text/markdown',
        content: `# 不可达取证\n\n唯一标记：${marker}\n`,
      },
    });
    expect(upload.status).toBe(202);
    const knowledgeRef = upload.body.data.knowledge_ref as string;

    const settled = await waitForKnowledgeReady(
      real,
      token,
      knowledgeRef,
      '1.0.0',
      env.parseTimeoutMs,
    );
    expect(settled.status).toBe('ready');

    const detail = await real.request({
      method: 'GET',
      path: `/knowledge/${knowledgeRef}/versions/1.0.0`,
      token,
    });
    const review = await real.request({
      method: 'POST',
      path: `/knowledge/${knowledgeRef}/versions/1.0.0/review`,
      token,
      json: {
        decision: 'approved',
        expected_hash: detail.body.data.content_hash,
        reason: '真实不可达取证',
      },
    });
    expect(review.status).toBe(200);

    // 2. 换到一个确实没有监听的端口。
    closedPort = await reserveClosedPort();
    const offlineBase = `http://127.0.0.1:${closedPort}`;
    // 读路径与 real 共享 schema：授权、索引映射、审核状态都在同一份本地状态里。
    offline = await createRealHarness(env, {
      upstreamBaseUrl: offlineBase,
      databaseSchema: real.db.schema,
    });
    offlineToken = await offline.token({ permissions: PERMISSIONS });
    // 写路径独立 schema：写操作的终态不被读路径的用例污染。
    offlineWrite = await createRealHarness(env, { upstreamBaseUrl: offlineBase });
  });

  afterAll(async () => {
    // 先关共享 schema 的 harness：它不负责删除 schema，
    // 真正的 schema 归 real 的 close() 删除。
    if (offline) await offline.close();
    if (offlineWrite) await offlineWrite.close();
    if (real) await real.close();
  });

  it('联调前置检查：未启用时报告 NOT RUN 与缺失配置项', () => {
    const missing = missingRealEnv();
    if (!isRealEnabled()) {
      console.warn(
        `[real] M27 不可达 NOT RUN：RUN_REAL_RAGFLOW 未设置为 1。缺失配置项：${missing.join(', ')}`,
      );
      expect(process.env.RUN_REAL_RAGFLOW ?? '').not.toBe('1');
      return;
    }
    expect(missing, `缺少配置项：${missing.join(', ')}`).toEqual([]);
  });

  it('目标端口确实没有监听：连接被内核拒绝（真实网络失败，不是替身）', async (ctx) => {
    if (!isRealEnabled()) {
      ctx.skip();
      return;
    }
    const probe = await probeConnection(closedPort);
    expect(probe.code).toBe('ECONNREFUSED');
  });

  it('检索遇到真实不可达：返回 503 RAGFLOW_UNAVAILABLE，不落成 500，也不产生证据', async (ctx) => {
    if (!isRealEnabled()) {
      ctx.skip();
      return;
    }

    const before = offline.realCallCount();
    const response = await offline.request({
      method: 'POST',
      path: '/retrieval',
      token: offlineToken,
      json: { query: '不可达取证', kb_ids: [kbId] },
    });

    // 503 而不是 500：上游不可达是可判定的瞬时故障，不是平台内部错误。
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('RAGFLOW_UNAVAILABLE');
    expect(response.body.code).not.toBe('INTERNAL_ERROR');
    // 错误体不泄露操作系统内部错误码：失败分类由平台归一。
    expect(String(response.body.message)).toBe('ragflow is unreachable');
    expect(String(response.body.message)).not.toContain('ECONNREFUSED');

    // 请求确实发出去过：连接被内核拒绝，不是本地短路。
    expect(offline.realCallCount() - before).toBeGreaterThan(0);

    // 没有半条成功状态：没有落任何证据。
    const evidence = await offline.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM evidence WHERE scope_id = $1',
      [env.projectId],
    );
    expect(evidence.rows[0]!.n).toBe(0);
  });

  it('写路径遇到真实不可达：操作与知识库都不落成成功状态', async (ctx) => {
    if (!isRealEnabled()) {
      ctx.skip();
      return;
    }

    const writeToken = await offlineWrite.token({ permissions: PERMISSIONS });
    const created = await offlineWrite.request({
      method: 'POST',
      path: '/knowledge-bases',
      token: writeToken,
      idempotencyKey: `real-unreach-write-${Date.now()}`,
      json: { name: `real-不可达写入-${Date.now()}`, description: '真实不可达写入取证' },
    });
    expect(created.status).toBe(202);
    const operationId = created.body.data.operation_id as string;

    // 推进 worker：它会去真实上游建数据集，连接被内核拒绝。
    await offlineWrite.advanceAll();

    const operation = await offlineWrite.request({
      method: 'GET',
      path: `/operations/${operationId}`,
      token: writeToken,
    });
    expect(operation.status).toBe(200);
    // 连接阶段失败（not_delivered）：请求确定没有送达上游，操作保持可重试，
    // 但绝不判成成功。
    expect(operation.body.data.state).not.toBe('succeeded');
    expect(String(operation.body.data.last_error ?? '')).toContain('upstream');

    const kb = await offlineWrite.request({
      method: 'GET',
      path: `/knowledge-bases/${created.body.data.kb_id}`,
      token: writeToken,
    });
    expect(kb.status).toBe(200);
    expect(kb.body.data.status).not.toBe('ready');
    // 上游没建出数据集，本地也不能记下数据集 id。
    expect(kb.body.data.ragflow_dataset_id).toBeNull();
  });
});
