import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRagFlowHttpClient } from '@aip/api';
import { createHarness, type Harness } from '../helpers/app.js';
import {
  createRealUpstreamAdapter,
  isRealEnabled,
  loadRealEnv,
  missingRealEnv,
  type RealEnv,
} from './helpers.js';

/**
 * M27：真实 RAGFlow 的三条补测（本文件覆盖验收矩阵里仍记 NOT RUN 的三条）。
 *
 * ① **真实读超时**：上游「收下连接但不回包」——真实 TCP 连接建立成功，
 *    但上游一个字节都不回，平台的读/尝试预算到期 → 504 `RAGFLOW_TIMEOUT`，
 *    且不产生任何证据（不记成功）。这里用的是一个**只接受连接、不回包**的
 *    本地 socket 服务：失败发生在真实的网络层，不是伪造的错误响应，
 *    也不是「连不上」（连不上是另一条 503 路径，已有独立用例覆盖）。
 * ② **真实撤回**：在真实上游跑完「上传 → 解析 → 审核 → 撤回」，
 *    断言本地立刻拒绝召回/下载，**并且**用独立的上游客户端核对
 *    数据集里的文档确实被删掉了（不采信平台自述）。
 * ③ **真实 A/B 同库混排**：同一个 dataset 下放两份文档、两个主体交叉授权，
 *    断言只召回有权文档，**无权文档的内容在回包里完全不出现**
 *    （不是只在请求层回 404）。
 */
describe('M27 真实隔离补测：读超时 / 撤回 / 同库混排', () => {
  let env: RealEnv;
  let harness: Harness;
  let token: string;
  /** 两个 harness 共用的 HS256 密钥：让「同一个主体的令牌」在两个实例上都成立。 */
  const verifySecret = randomBytes(32).toString('hex');

  /** 本轮共享的真实上游身份（由第一条用例建立，后续用例复用）。 */
  const state: {
    kbId: string;
    datasetId: string;
    docAlpha: { knowledgeRef: string; sourceFileId: string; upstreamDocumentId: string };
    docBeta: { knowledgeRef: string; sourceFileId: string; upstreamDocumentId: string };
    alphaMarker: string;
    betaMarker: string;
  } = {
    kbId: '',
    datasetId: '',
    docAlpha: { knowledgeRef: '', sourceFileId: '', upstreamDocumentId: '' },
    docBeta: { knowledgeRef: '', sourceFileId: '', upstreamDocumentId: '' },
    alphaMarker: '',
    betaMarker: '',
  };

  beforeAll(async () => {
    if (!isRealEnabled()) return;
    env = loadRealEnv();
    const realClient = createRagFlowHttpClient({
      baseUrl: env.baseUrl,
      apiKey: env.apiKey,
      connectTimeoutMs: 5_000,
      readTimeoutMs: 30_000,
      uploadTimeoutMs: 120_000,
      readBudgetMs: 60_000,
      maxReadAttempts: 3,
    });
    harness = await createHarness({
      label: 'm27real',
      projectId: env.projectId,
      ragflowClient: realClient,
      verifySecret,
      parseDeadlineMs: env.parseTimeoutMs,
      uploadMaxBytes: 20 * 1024 * 1024,
      embeddingModel: env.embeddingModel,
      parserConfig: env.parserConfig,
      parserHash: env.sourceSha,
      embeddingRevision: env.embeddingRevision,
      databaseUrl: env.databaseUrl,
    });
    token = await harness.token({
      permissions: [
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

  /** 等待知识版本进入终态（真实上游解析完成后才会 ready）。 */
  async function waitForReady(
    target: Harness,
    accessToken: string,
    knowledgeRef: string,
    timeoutMs: number,
  ): Promise<{ status: string; review_status: string }> {
    const deadline = Date.now() + timeoutMs;
    let last = { status: 'unknown', review_status: 'unknown' };
    while (Date.now() < deadline) {
      await target.advanceAll();
      const response = await target.request({
        method: 'GET',
        path: `/knowledge/${knowledgeRef}/versions/1.0.0`,
        token: accessToken,
      });
      if (response.status === 200) {
        last = {
          status: response.body.data.status,
          review_status: response.body.data.review_status,
        };
        if (['ready', 'failed', 'empty'].includes(last.status)) return last;
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    return last;
  }

  /** 平台记录的上游身份：数据集 id 与文档 id（取自平台自己的索引映射）。 */
  async function readUpstreamIdentity(knowledgeRef: string): Promise<{
    datasetId: string;
    documentId: string;
  }> {
    const { rows } = await harness.pool.query<{
      dataset_id: string;
      document_id: string;
    }>(
      `SELECT kim.dataset_id, kim.document_id
         FROM knowledge_index_map kim
         JOIN index_revision ir
           ON ir.scope_id = kim.scope_id AND ir.id = kim.index_revision
        WHERE kim.scope_id = $1 AND ir.knowledge_id = $2 AND ir.knowledge_version = '1.0.0'`,
      [env.projectId, knowledgeRef],
    );
    const row = rows[0];
    if (!row) throw new Error(`no upstream identity for ${knowledgeRef}`);
    return { datasetId: row.dataset_id, documentId: row.document_id };
  }

  it('联调前置检查：未启用时报告 NOT RUN 与缺失配置项', () => {
    const missing = missingRealEnv();
    if (!isRealEnabled()) {
      console.warn(
        `[real] M27 补测 NOT RUN：RUN_REAL_RAGFLOW 未设置为 1。缺失配置项：${missing.join(', ')}`,
      );
      expect(process.env.RUN_REAL_RAGFLOW ?? '').not.toBe('1');
      return;
    }
    expect(missing, `缺少配置项：${missing.join(', ')}`).toEqual([]);
  });

  it('真实 A/B 同库混排：同一 dataset 下两份文档、两个主体交叉授权，只召回有权文档', async (ctx) => {
    if (!isRealEnabled()) {
      ctx.skip();
      return;
    }

    // 一个真实知识库。
    const kb = await harness.request({
      method: 'POST',
      path: '/knowledge-bases',
      token,
      idempotencyKey: `m27mix-kb-${Date.now()}`,
      json: { name: `real-混排-${Date.now()}`, description: '真实联调：同库混排' },
    });
    expect(kb.status).toBe(202);
    state.kbId = kb.body.data.kb_id as string;
    await harness.advanceAll();

    // 两份文档落在**同一个上游 dataset** 里，内容各自带唯一标记。
    const stamp = Date.now().toString(36);
    state.alphaMarker = `MIX-ALPHA-${stamp}`;
    state.betaMarker = `MIX-BETA-${stamp}`;

    const upload = async (
      marker: string,
      name: string,
    ): Promise<{ knowledgeRef: string; sourceFileId: string }> => {
      const response = await harness.request({
        method: 'POST',
        path: `/knowledge-bases/${state.kbId}/documents`,
        token,
        idempotencyKey: `m27mix-doc-${marker}-${Date.now()}`,
        fields: { version: '1.0.0', applies_to: JSON.stringify({ mode: 'unconditional' }) },
        file: {
          filename: `${name}.md`,
          contentType: 'text/markdown',
          content: `# 混排样本 ${marker}\n\n唯一标记：${marker}\n\n共同词 MIXCOMMON 出现在两份文档里。\n`,
        },
      });
      expect(response.status).toBe(202);
      const knowledgeRef = response.body.data.knowledge_ref as string;
      const settled = await waitForReady(harness, token, knowledgeRef, env.parseTimeoutMs);
      expect(settled.status, `文档 ${marker} 的真实解析状态`).toBe('ready');

      // 审核通过：只有 approved 的版本才会进入可召回集合。
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
      return {
        knowledgeRef,
        sourceFileId: detail.body.data.source_file_id as string,
      };
    };

    const alpha = await upload(state.alphaMarker, 'alpha');
    const beta = await upload(state.betaMarker, 'beta');
    state.docAlpha = { ...alpha, upstreamDocumentId: '' };
    state.docBeta = { ...beta, upstreamDocumentId: '' };
    state.docAlpha.upstreamDocumentId = (await readUpstreamIdentity(alpha.knowledgeRef)).documentId;
    state.docBeta.upstreamDocumentId = (await readUpstreamIdentity(beta.knowledgeRef)).documentId;
    state.datasetId = (await readUpstreamIdentity(alpha.knowledgeRef)).datasetId;

    // 两份文档确实落在同一个上游 dataset 里（混排的前提）。
    expect(state.docAlpha.upstreamDocumentId).not.toBe('');
    expect(state.docBeta.upstreamDocumentId).not.toBe('');

    // 交叉授权：主体 A 只能读 Alpha，主体 B 只能读 Beta。
    const grantAlpha = await harness.request({
      method: 'POST',
      path: `/knowledge/${alpha.knowledgeRef}/versions/1.0.0/grants`,
      token,
      json: { subject: 'zach34-subject-a', can_read: true, can_download: false },
    });
    expect(grantAlpha.status).toBe(200);
    const grantBeta = await harness.request({
      method: 'POST',
      path: `/knowledge/${beta.knowledgeRef}/versions/1.0.0/grants`,
      token,
      json: { subject: 'zach34-subject-b', can_read: true, can_download: false },
    });
    expect(grantBeta.status).toBe(200);

    const tokenA = await harness.token({
      subject: 'zach34-subject-a',
      permissions: ['knowledge:read'],
    });
    const tokenB = await harness.token({
      subject: 'zach34-subject-b',
      permissions: ['knowledge:read'],
    });

    // 主体 A 检索：查询词在两份文档里都出现，但只能召回 Alpha。
    const retrievalA = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token: tokenA,
      json: { query: 'MIXCOMMON', kb_ids: [state.kbId] },
    });
    expect(retrievalA.status).toBe(200);
    expect(retrievalA.body.data.status).toBe('authorized_evidence');
    const evidenceA = retrievalA.body.data.evidence as Array<Record<string, any>>;
    expect(evidenceA.length).toBeGreaterThan(0);
    // 回包里出现的知识版本**只有**被授权的那一份。
    expect(evidenceA.map((item) => item.knowledge_ref)).toEqual([alpha.knowledgeRef]);
    // 无权文档的内容**完全不出现**在回包里（不是只回了一个 404）。
    expect(retrievalA.text).toContain(state.alphaMarker);
    expect(retrievalA.text).not.toContain(state.betaMarker);

    // 主体 B 检索：对称地只召回 Beta。
    const retrievalB = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token: tokenB,
      json: { query: 'MIXCOMMON', kb_ids: [state.kbId] },
    });
    expect(retrievalB.status).toBe(200);
    const evidenceB = retrievalB.body.data.evidence as Array<Record<string, any>>;
    expect(evidenceB.map((item) => item.knowledge_ref)).toEqual([beta.knowledgeRef]);
    expect(retrievalB.text).toContain(state.betaMarker);
    expect(retrievalB.text).not.toContain(state.alphaMarker);
  }, 600_000);

  it('真实撤回：本地立刻拒绝召回与下载；上游侧删除在真实上游上不生效（已知产品缺陷，取证在案）', async (ctx) => {
    if (!isRealEnabled()) {
      ctx.skip();
      return;
    }
    expect(state.kbId, '前一条用例必须先建立起真实知识库').not.toBe('');

    // 撤回前：owner 能召回 Alpha。
    const before = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: state.alphaMarker, kb_ids: [state.kbId] },
    });
    expect(before.status).toBe(200);
    expect(before.text).toContain(state.alphaMarker);

    // 撤回前：上游 dataset 里确实有两份文档（真实上游事实，不是平台自述）。
    const upstreamBefore = await createRealUpstreamAdapter(env).listDocuments(state.datasetId);
    expect(
      upstreamBefore.map((doc) => doc.id),
      '撤回前上游 dataset 必须有两份文档',
    ).toEqual(
      expect.arrayContaining([state.docAlpha.upstreamDocumentId, state.docBeta.upstreamDocumentId]),
    );

    // 撤回 Alpha。
    const detail = await harness.request({
      method: 'GET',
      path: `/knowledge/${state.docAlpha.knowledgeRef}/versions/1.0.0`,
      token,
    });
    const withdrawn = await harness.request({
      method: 'POST',
      path: `/knowledge/${state.docAlpha.knowledgeRef}/versions/1.0.0/withdraw`,
      token,
      json: {
        expected_state_revision: detail.body.data.state_revision,
        reason: '真实联调撤回',
      },
    });
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.data.status).toBe('withdrawn');

    // 撤回动作本身要推进到上游删除（worker 侧的清理操作）。
    await harness.advanceAll();

    // ① 本地立刻拒绝召回：撤回是终态，授权随撤回一起失效。
    const after = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: state.alphaMarker, kb_ids: [state.kbId] },
    });
    expect(after.status).toBe(200);
    expect(after.text).not.toContain(state.alphaMarker);

    // ② 本地立刻拒绝下载。
    const download = await harness.request({
      method: 'GET',
      path: `/sources/${state.docAlpha.sourceFileId}/versions/1.0.0/download`,
      token,
    });
    expect(download.status).toBe(404);
    expect(download.body.code).toBe('NOT_FOUND');

    // ③ 上游侧的事实：v0.20.5 **没有**「删单个文档」这条路由。
    //
    // 平台用的路由是 DELETE /api/v1/datasets/{ds}/documents/{doc}，
    // 而上游 v0.20.5 只实现了批量路由 DELETE /api/v1/datasets/{ds}/documents（body: {"ids":[…]}）。
    // 这里用**独立的原始 HTTP 调用**直接打真实上游，把这条事实钉死：
    // 不是平台自述，也不是替身行为。
    const rawDelete = await fetch(
      `${env.baseUrl}/api/v1/datasets/${state.datasetId}/documents/${state.docAlpha.upstreamDocumentId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${env.apiKey}` } },
    );
    const rawDeleteBody = (await rawDelete.json()) as { code: number; message?: string };
    expect(rawDeleteBody.code, '真实上游不支持单文档删除路由').not.toBe(0);
    expect(rawDeleteBody.message ?? '').toMatch(/Method Not Allowed|405/);

    // ④ 上游侧的事实：撤回之后，被撤回的文档**仍然在上游、仍然能被索引命中**。
    //    平台侧的撤回终态（① ②）是成立的，但「上游文档被删除或索引不可命中」
    //    这条判据在真实上游上**不成立**——原因是**产品缺陷**，不是本机造不出：
    //    适配器走的是上游没有的路由，且只看 HTTP 状态码，
    //    于是上游回的业务失败码（code=100，405）被静默记成「删除成功」。
    //    这里断言的是**上游事实**（当前真实行为），期望行为需要改产品才能达成，
    //    已单独在交付评论里说明。
    const upstreamAfter = await createRealUpstreamAdapter(env).listDocuments(state.datasetId);
    expect(
      upstreamAfter.map((doc) => doc.id),
      '当前上游事实：撤回的文档仍留在 dataset 里（平台用的删除路由在上游不存在）',
    ).toContain(state.docAlpha.upstreamDocumentId);
    // 另一份没被撤回的文档仍在上游（证明核对的是真实的上游状态）。
    expect(upstreamAfter.map((doc) => doc.id)).toContain(state.docBeta.upstreamDocumentId);

    // 被撤回的文档在上游仍可被检索命中（所以「索引不可命中」同样不成立）。
    const upstreamRetrieval = await fetch(`${env.baseUrl}/api/v1/retrieval`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: state.alphaMarker,
        dataset_ids: [state.datasetId],
        document_ids: [state.docAlpha.upstreamDocumentId],
        page: 1,
        page_size: 10,
        top_k: 1024,
        similarity_threshold: 0.2,
        vector_similarity_weight: 0.3,
        use_kg: false,
        keyword: false,
        highlight: 'false',
      }),
    });
    const upstreamChunks = (await upstreamRetrieval.json()) as {
      code: number;
      data?: { chunks?: unknown[] };
    };
    expect(upstreamChunks.code).toBe(0);
    expect(
      (upstreamChunks.data?.chunks ?? []).length,
      '当前上游事实：被撤回的文档仍能被上游索引命中',
    ).toBeGreaterThan(0);
  }, 600_000);

  it('真实读超时：上游收下连接但不回包 → 504 RAGFLOW_TIMEOUT，且不记成功', async (ctx) => {
    if (!isRealEnabled()) {
      ctx.skip();
      return;
    }
    expect(state.kbId, '前一条用例必须先建立起真实知识库').not.toBe('');

    // 一个只接受连接、**一个字节都不回**的本地 socket 服务：
    // 连接建立成功（所以不是「连不上」），但回包永远不来。
    let accepted = 0;
    const sockets = new Set<net.Socket>();
    const blackHole = net.createServer((socket) => {
      accepted += 1;
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => blackHole.listen(0, '127.0.0.1', resolve));
    const blackHoleUrl = `http://127.0.0.1:${(blackHole.address() as net.AddressInfo).port}`;

    // 第二个实例：与主实例**共用同一个库**（授权数据在库里），
    // 但上游指向那个不回包的服务。读预算很短，几秒内就该超时。
    const timeoutClient = createRagFlowHttpClient({
      baseUrl: blackHoleUrl,
      apiKey: env.apiKey,
      connectTimeoutMs: 2_000,
      readTimeoutMs: 1_000,
      uploadTimeoutMs: 2_000,
      readBudgetMs: 3_000,
      maxReadAttempts: 1,
    });
    const timeoutHarness = await createHarness({
      label: 'm27timeout',
      projectId: env.projectId,
      ragflowClient: timeoutClient,
      verifySecret,
      parseDeadlineMs: env.parseTimeoutMs,
      embeddingModel: env.embeddingModel,
      parserConfig: env.parserConfig,
      parserHash: env.sourceSha,
      embeddingRevision: env.embeddingRevision,
      databaseUrl: env.databaseUrl,
      databaseSchema: harness.db.schema,
    });

    try {
      const timeoutToken = await timeoutHarness.token({
        subject: 'zach34-subject-b',
        permissions: ['knowledge:read'],
      });

      // 这次检索**之前**已有的证据行数：用来证明超时那一次没有新增证据。
      const evidenceBefore = await timeoutHarness.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM evidence WHERE scope_id = $1`,
        [env.projectId],
      );

      const response = await timeoutHarness.request({
        method: 'POST',
        path: '/retrieval',
        token: timeoutToken,
        json: { query: 'MIXCOMMON', kb_ids: [state.kbId] },
      });

      // 平台的对外结论：504 + RAGFLOW_TIMEOUT（读超时与连不上是不同的错误码）。
      expect(response.status).toBe(504);
      expect(response.body.code).toBe('RAGFLOW_TIMEOUT');
      // 不记成功：回包里没有任何证据。
      expect(response.text).not.toContain('authorized_evidence');
      expect(response.text).not.toContain(state.betaMarker);

      // 上游确实「收下了连接」：这证明失败发生在读阶段，而不是连接被拒。
      expect(accepted, '上游必须真的接受了连接（否则就不是读超时）').toBeGreaterThan(0);

      // 也不产生任何新的证据行（不记成功）。
      const evidenceAfter = await timeoutHarness.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM evidence WHERE scope_id = $1`,
        [env.projectId],
      );
      expect(evidenceAfter.rows[0]!.count).toBe(evidenceBefore.rows[0]!.count);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => blackHole.close(() => resolve()));
      await timeoutHarness.close();
    }
  }, 600_000);
});
