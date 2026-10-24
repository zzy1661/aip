import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import {
  createReadyKnowledgeBase,
  prepareApprovedDocument,
  seedRetrievalChunk,
} from '../helpers/flow.js';

/**
 * M15：撤回（withdraw）全链路。
 *
 * 断言口径：
 * - 撤回是 CAS 写：必须带上当前 state_revision，过期修订号一律拒绝；
 * - 撤回提交后本地立即生效：版本状态变 withdrawn、不再召回、证据不可回查；
 * - 撤回登记 knowledge.withdraw 操作，推进到终态并删除远端文档；
 * - 撤回必须推进授权修订号，撤回之后开始的读不再读到旧授权。
 */
describe('M15 撤回全链路', () => {
  let harness: Harness;
  let token: string;
  let kbId: string;
  let knowledgeRef: string;
  let version: string;
  let sourceRef: string;
  let documentId: string;
  let datasetId: string;
  let evidenceId: string;
  let authzRevisionBefore = 0;

  beforeAll(async () => {
    harness = await createHarness({ label: 'withdraw' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
    const kb = await createReadyKnowledgeBase(harness, token, 'M15 撤回知识库');
    kbId = kb.kbId;
    const document = await prepareApprovedDocument(harness, token, kbId, {
      marker: 'M15-WITHDRAW',
    });
    knowledgeRef = document.knowledgeRef;
    version = document.version;
    sourceRef = document.sourceRef;
    documentId = document.documentId;
    datasetId = document.datasetId;
    seedRetrievalChunk(harness, { documentId, datasetId, content: 'M15-WITHDRAW' });
  });

  afterAll(async () => {
    await harness.close();
  });

  async function detail() {
    const response = await harness.request({
      method: 'GET',
      path: `/knowledge/${knowledgeRef}/versions/${version}`,
      token,
    });
    return response.body.data as { status: string; state_revision: number };
  }

  async function authzRevision(): Promise<number> {
    const { rows } = await harness.pool.query(
      `SELECT revision FROM authz_state WHERE scope_id = $1`,
      [harness.projectId],
    );
    return Number(rows[0]?.revision ?? 0);
  }

  it('撤回前可以检索到证据', async () => {
    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M15-WITHDRAW', kb_ids: [kbId] },
    });
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('authorized_evidence');
    expect(response.body.data.evidence).toHaveLength(1);
    evidenceId = response.body.data.evidence[0].evidence_id as string;
  });

  it('使用过期修订号撤回被拒绝', async () => {
    const response = await harness.request({
      method: 'POST',
      path: `/knowledge/${knowledgeRef}/versions/${version}/withdraw`,
      token,
      json: { expected_state_revision: 0, reason: '来源已过期' },
    });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('STATE_CONFLICT');
  });

  it('撤回成功后不再召回，版本状态变为 withdrawn', async () => {
    const before = await detail();
    expect(before.status).toBe('ready');
    authzRevisionBefore = await authzRevision();

    const response = await harness.request({
      method: 'POST',
      path: `/knowledge/${knowledgeRef}/versions/${version}/withdraw`,
      token,
      json: { expected_state_revision: before.state_revision, reason: '来源已过期' },
    });
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('withdrawn');
    expect(response.body.data.state_revision).toBe(before.state_revision + 1);

    const after = await detail();
    expect(after.status).toBe('withdrawn');

    const retrieval = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M15-WITHDRAW', kb_ids: [kbId] },
    });
    expect(retrieval.status).toBe(200);
    expect(retrieval.body.data.status).toBe('no_match');
    expect(retrieval.body.data.evidence).toEqual([]);
  });

  it('撤回后证据详情不可回查', async () => {
    const response = await harness.request({
      method: 'GET',
      path: `/evidence/${evidenceId}`,
      token,
    });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('撤回登记 knowledge.withdraw 操作，推进到终态并删除远端文档', async () => {
    const { rows } = await harness.pool.query(
      `SELECT id, state FROM operation
        WHERE scope_id = $1 AND kind = 'knowledge.withdraw' AND resource_id = $2::uuid`,
      [harness.projectId, knowledgeRef],
    );
    expect(rows).toHaveLength(1);
    const operationId = rows[0].id as string;

    await harness.advanceAll();

    const operation = await harness.request({
      method: 'GET',
      path: `/operations/${operationId}`,
      token,
    });
    expect(operation.status).toBe(200);
    expect(operation.body.data.state).toBe('succeeded');

    const deletes = harness.ragflow.calls.filter(
      (call) =>
        call.method === 'DELETE' &&
        call.path === `/api/v1/datasets/${datasetId}/documents/${documentId}`,
    );
    expect(deletes).toHaveLength(1);
  });

  it('撤回推进授权修订号', async () => {
    expect(await authzRevision()).toBeGreaterThan(authzRevisionBefore);
  });

  it('缺少 knowledge:manage 权限的主体不能撤回', async () => {
    const readerToken = await harness.token({
      subject: 'reader-1',
      permissions: ['knowledge:read', 'source:read'],
    });
    const response = await harness.request({
      method: 'POST',
      path: `/knowledge/${knowledgeRef}/versions/${version}/withdraw`,
      token: readerToken,
      json: { expected_state_revision: 0, reason: '无权限' },
    });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('撤回请求缺少理由时按契约拒绝', async () => {
    const response = await harness.request({
      method: 'POST',
      path: `/knowledge/${knowledgeRef}/versions/${version}/withdraw`,
      token,
      json: { expected_state_revision: 0 },
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('CONTRACT_INVALID');
  });

  it('撤回后来源下载立即被拒，不等上游删索引完成', async () => {
    // 撤回是本地终态：即使文档级授权还在、远端索引尚未删除，
    // 来源文件也必须立刻不可下载。
    const response = await harness.request({
      method: 'GET',
      path: `/sources/${sourceRef}/versions/${version}/download`,
      token,
    });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });
});
