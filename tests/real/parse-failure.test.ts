import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createRealHarness,
  isRealEnabled,
  loadRealEnv,
  missingRealEnv,
  readUpstreamDocumentStatus,
  waitForKnowledgeReady,
  type RealEnv,
  type RealHarness,
} from './helpers.js';

/**
 * M27 判据二：真实解析失败时，文档状态保持 failed。
 *
 * 取证方式：**真实上游解析失败**，不是替身。
 * 上传一个「有 PDF 魔数但结构损坏」的文件：
 * 它能通过平台的类型校验（扩展名 + MIME + 魔数），
 * 真正走到上游解析器，由上游解析器判失败。
 *
 * 断言口径：
 * - 上游文档状态确实是 FAIL（直接问上游，不是问平台自己）；
 * - 平台侧知识版本状态保持 failed，不伪装成 ready；
 * - 操作终态是 failed；
 * - 不产生任何可检索的证据。
 */

/**
 * 损坏的 PDF：有合法魔数，但没有对象、没有交叉引用表、没有 trailer。
 * 平台的上传校验只检查魔数与加密标记，因此它会到达上游解析器。
 */
const CORRUPT_PDF = Buffer.from(
  '%PDF-1.4\nthis is not a real pdf at all\n%%EOF\n',
  'latin1',
);

const PERMISSIONS = [
  'knowledge:read',
  'knowledge:write',
  'knowledge:review',
  'source:read',
  'operations:read',
] as const;

describe('M27 真实解析失败', () => {
  let env: RealEnv;
  let harness: RealHarness;
  let token: string;
  let kbId = '';
  let knowledgeRef = '';
  let operationId = '';

  beforeAll(async () => {
    if (!isRealEnabled()) {
      return;
    }
    env = loadRealEnv();
    harness = await createRealHarness(env);
    token = await harness.token({ permissions: PERMISSIONS });

    const kb = await harness.request({
      method: 'POST',
      path: '/knowledge-bases',
      token,
      idempotencyKey: `real-parse-kb-${Date.now()}`,
      json: { name: `real-解析失败-${Date.now()}`, description: '真实解析失败取证' },
    });
    expect(kb.status).toBe(202);
    kbId = kb.body.data.kb_id as string;
    await harness.advanceAll();

    const upload = await harness.request({
      method: 'POST',
      path: `/knowledge-bases/${kbId}/documents`,
      token,
      idempotencyKey: `real-parse-doc-${Date.now()}`,
      fields: { version: '1.0.0', applies_to: JSON.stringify({ mode: 'unconditional' }) },
      file: {
        filename: `zach19-broken-${Date.now()}.pdf`,
        contentType: 'application/pdf',
        content: CORRUPT_PDF,
      },
    });
    expect(upload.status).toBe(202);
    knowledgeRef = upload.body.data.knowledge_ref as string;
    operationId = upload.body.data.operation_id as string;
  });

  afterAll(async () => {
    if (harness) await harness.close();
  });

  it('联调前置检查：未启用时报告 NOT RUN 与缺失配置项', () => {
    const missing = missingRealEnv();
    if (!isRealEnabled()) {
      console.warn(
        `[real] M27 解析失败 NOT RUN：RUN_REAL_RAGFLOW 未设置为 1。缺失配置项：${missing.join(', ')}`,
      );
      expect(process.env.RUN_REAL_RAGFLOW ?? '').not.toBe('1');
      return;
    }
    expect(missing, `缺少配置项：${missing.join(', ')}`).toEqual([]);
  });

  it('上游确实解析失败：文档状态为 FAIL', async (ctx) => {
    if (!isRealEnabled()) {
      ctx.skip();
      return;
    }

    // 先等平台把解析推进到终态。
    const settled = await waitForKnowledgeReady(
      harness,
      token,
      knowledgeRef,
      '1.0.0',
      env.parseTimeoutMs,
    );
    expect(settled.status).toBe('failed');

    // 直接问上游：失败是上游解析器给的结论，不是平台自己判的。
    const progress = await harness.pool.query<{ result: Record<string, unknown> }>(
      'SELECT result FROM operation WHERE scope_id = $1 AND id = $2',
      [env.projectId, operationId],
    );
    const upstream = progress.rows[0]!.result as {
      datasetId?: string;
      documentId?: string;
    };
    expect(upstream.datasetId).toBeTruthy();
    expect(upstream.documentId).toBeTruthy();

    const status = await readUpstreamDocumentStatus(env, {
      datasetId: upstream.datasetId!,
      documentId: upstream.documentId!,
    });
    expect(status.run).toBe('FAIL');
    expect(status.chunk_count).toBe(0);
  });

  it('平台侧保持 failed：解析操作终态是 failed，文档不伪装成功', async (ctx) => {
    if (!isRealEnabled()) {
      ctx.skip();
      return;
    }

    // 上传操作的成功只代表「文件已上传且解析已触发」，
    // 解析结论由 document.parse 操作与知识版本状态承担。
    const upload = await harness.request({
      method: 'GET',
      path: `/operations/${operationId}`,
      token,
    });
    expect(upload.status).toBe(200);
    expect(upload.body.data.state).toBe('succeeded');

    const parseRows = await harness.pool.query<{
      id: string;
      state: string;
      last_error: string | null;
    }>(
      `SELECT id, state, last_error FROM operation
        WHERE scope_id = $1 AND kind = 'document.parse' AND resource_id = $2`,
      [env.projectId, knowledgeRef],
    );
    expect(parseRows.rows).toHaveLength(1);

    const parseOperation = await harness.request({
      method: 'GET',
      path: `/operations/${parseRows.rows[0]!.id}`,
      token,
    });
    expect(parseOperation.status).toBe(200);
    expect(parseOperation.body.data.state).toBe('failed');
    // 上游原文不回显：只保留失败分类，不泄露上游内部细节。
    expect(parseOperation.body.data.last_error).toBe('parse failed upstream');

    const detail = await harness.request({
      method: 'GET',
      path: `/knowledge/${knowledgeRef}/versions/1.0.0`,
      token,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.data.status).toBe('failed');
    // 解析失败的文档不得被当成可用的已审核知识。
    expect(detail.body.data.review_status).toBe('pending');

    const documents = await harness.request({
      method: 'GET',
      path: `/knowledge-bases/${kbId}/documents`,
      token,
    });
    expect(documents.status).toBe(200);
    const items = documents.body.data as Array<Record<string, unknown>>;
    const target = items.find((item) => item.knowledge_id === knowledgeRef);
    expect(target).toBeTruthy();
    expect(target!.status).toBe('failed');
  });

  it('解析失败的文档不产生任何可检索的成功证据', async (ctx) => {
    if (!isRealEnabled()) {
      ctx.skip();
      return;
    }

    const retrieval = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: '损坏的 PDF', kb_ids: [kbId] },
    });
    expect(retrieval.status).toBe(200);
    expect(retrieval.body.data.evidence).toHaveLength(0);
    expect(retrieval.body.data.status).not.toBe('authorized_evidence');

    const evidence = await harness.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM evidence WHERE scope_id = $1 AND knowledge_ref = $2',
      [env.projectId, knowledgeRef],
    );
    expect(evidence.rows[0]!.n).toBe(0);
  });
});
