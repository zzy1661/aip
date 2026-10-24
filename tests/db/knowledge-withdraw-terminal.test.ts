import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import {
  completeUpstreamParse,
  createReadyKnowledgeBase,
  uploadSampleDocument,
} from '../helpers/flow.js';

/**
 * 撤回是终态：已撤回的知识版本不能再被迟到的 worker 复活。
 *
 * epoch 栅栏挡不住这种情况——迟到的是另一个操作（解析 / 重建），
 * 它持有的是自己的 epoch。因此这里同时验证三层保护：
 * - 应用层：推进前先看数据库里的撤回事实；
 * - 条件更新：撤回过的版本写不进 ready / failed；
 * - 数据库触发器：任何把 withdrawn 改成别的状态的写入直接失败。
 */
describe('撤回终态：迟到的完成与失败都不能复活已撤回的版本', () => {
  let harness: Harness;
  let token: string;

  beforeEach(async () => {
    harness = await createHarness({ label: 'withdraw_terminal' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterEach(async () => {
    await harness.close();
  });

  async function detail(knowledgeRef: string, version: string) {
    const response = await harness.request({
      method: 'GET',
      path: `/knowledge/${knowledgeRef}/versions/${version}`,
      token,
    });
    return response.body.data as { status: string; state_revision: number };
  }

  async function withdraw(knowledgeRef: string, version: string, stateRevision: number) {
    return harness.request({
      method: 'POST',
      path: `/knowledge/${knowledgeRef}/versions/${version}/withdraw`,
      token,
      json: { expected_state_revision: stateRevision, reason: '来源已过期' },
    });
  }

  async function downloadStatus(sourceRef: string, version: string): Promise<number> {
    const response = await harness.request({
      method: 'GET',
      path: `/sources/${sourceRef}/versions/${version}/download`,
      token,
    });
    return response.status;
  }

  /** 把在途操作改回「worker 还在跑」的旧状态，模拟撤回之前就已开始的推进。 */
  async function reviveInFlightOperation(operationId: string): Promise<void> {
    await harness.pool.query(
      `UPDATE operation
          SET state = 'in_progress', epoch = 1, lease_until = now() - interval '1 second',
              next_attempt_at = NULL
        WHERE id = $1`,
      [operationId],
    );
  }

  it('迟到的解析完成不能把已撤回的版本改回 ready', async () => {
    const kb = await createReadyKnowledgeBase(harness, token);
    const doc = await uploadSampleDocument(harness, token, kb.kbId);
    await harness.advanceAll();
    expect((await detail(doc.knowledgeRef, doc.version)).status).toBe('parsing');

    const before = await detail(doc.knowledgeRef, doc.version);
    expect((await withdraw(doc.knowledgeRef, doc.version, before.state_revision)).status).toBe(200);
    expect(await downloadStatus(doc.sourceRef, doc.version)).toBe(404);

    // 上游解析在撤回之后才完成：把解析操作改回在途状态，模拟迟到的 worker。
    const { rows } = await harness.pool.query(
      `SELECT id FROM operation WHERE scope_id = $1 AND kind = 'document.parse'`,
      [harness.projectId],
    );
    expect(rows).toHaveLength(1);
    await reviveInFlightOperation(rows[0]!.id as string);

    completeUpstreamParse(harness);
    await harness.advanceAll();

    const after = await detail(doc.knowledgeRef, doc.version);
    expect(after.status).toBe('withdrawn');
    expect(await downloadStatus(doc.sourceRef, doc.version)).toBe(404);

    const { rows: opRows } = await harness.pool.query(
      `SELECT state FROM operation WHERE id = $1`,
      [rows[0]!.id],
    );
    expect(opRows[0]!.state).toBe('cancelled');
  });

  it('迟到的失败分支不能把已撤回的版本改回 failed', async () => {
    const kb = await createReadyKnowledgeBase(harness, token);
    const doc = await uploadSampleDocument(harness, token, kb.kbId);
    await harness.advanceAll();

    const before = await detail(doc.knowledgeRef, doc.version);
    expect((await withdraw(doc.knowledgeRef, doc.version, before.state_revision)).status).toBe(200);

    const { rows } = await harness.pool.query(
      `SELECT id FROM operation WHERE scope_id = $1 AND kind = 'document.parse'`,
      [harness.projectId],
    );
    await reviveInFlightOperation(rows[0]!.id as string);

    // 上游解析在撤回之后失败。
    const upstreamDocument = [...harness.ragflow.documents.values()].at(-1);
    expect(upstreamDocument).toBeDefined();
    upstreamDocument!.run = 'FAIL';
    upstreamDocument!.progress = 0;

    await harness.advanceAll();

    expect((await detail(doc.knowledgeRef, doc.version)).status).toBe('withdrawn');
    const { rows: opRows } = await harness.pool.query(
      `SELECT state FROM operation WHERE id = $1`,
      [rows[0]!.id],
    );
    expect(opRows[0]!.state).toBe('cancelled');
  });

  it('撤回会取消在途的上传操作，之后不再上传', async () => {
    const kb = await createReadyKnowledgeBase(harness, token);
    const doc = await uploadSampleDocument(harness, token, kb.kbId);

    const before = await detail(doc.knowledgeRef, doc.version);
    expect((await withdraw(doc.knowledgeRef, doc.version, before.state_revision)).status).toBe(200);

    const { rows } = await harness.pool.query(
      `SELECT state FROM operation WHERE id = $1`,
      [doc.operationId],
    );
    expect(rows[0]!.state).toBe('cancelled');

    await harness.advanceAll();

    const uploads = harness.ragflow.calls.filter(
      (call) => call.method === 'POST' && /\/api\/v1\/datasets\/[^/]+\/documents$/.test(call.path),
    );
    expect(uploads).toHaveLength(0);
    expect(harness.ragflow.documents.size).toBe(0);
    expect((await detail(doc.knowledgeRef, doc.version)).status).toBe('withdrawn');
  });

  it('撤回时索引尚未登记，上游文档仍然被删除', async () => {
    const kb = await createReadyKnowledgeBase(harness, token);
    const doc = await uploadSampleDocument(harness, token, kb.kbId);
    await harness.advanceAll();

    const upstreamDocument = [...harness.ragflow.documents.values()].at(-1);
    expect(upstreamDocument).toBeDefined();
    const documentId = upstreamDocument!.id;
    const datasetId = upstreamDocument!.datasetId;

    const before = await detail(doc.knowledgeRef, doc.version);
    expect((await withdraw(doc.knowledgeRef, doc.version, before.state_revision)).status).toBe(200);
    await harness.advanceAll();

    const deletes = harness.ragflow.calls.filter(
      (call) =>
        call.method === 'DELETE' &&
        call.path === `/api/v1/datasets/${datasetId}/documents/${documentId}`,
    );
    expect(deletes).toHaveLength(1);
  });

  it('数据库层拒绝把已撤回的版本改回 ready', async () => {
    const kb = await createReadyKnowledgeBase(harness, token);
    const doc = await uploadSampleDocument(harness, token, kb.kbId);
    await harness.advanceAll();

    const before = await detail(doc.knowledgeRef, doc.version);
    expect((await withdraw(doc.knowledgeRef, doc.version, before.state_revision)).status).toBe(200);

    await expect(
      harness.pool.query(
        `UPDATE knowledge_revision SET status = 'ready'
          WHERE scope_id = $1 AND knowledge_id = $2 AND version = $3`,
        [harness.projectId, doc.knowledgeRef, doc.version],
      ),
    ).rejects.toThrow(/withdrawn is a terminal state/);

    expect((await detail(doc.knowledgeRef, doc.version)).status).toBe('withdrawn');
  });

  it.each(['DONE', 'FAIL'])('已领取 worker 等待上游 %s 时撤回，迟到回包不能复活版本', async (run) => {
    const kb = await createReadyKnowledgeBase(harness, token);
    const doc = await uploadSampleDocument(harness, token, kb.kbId);
    await harness.advanceAll();
    const upstream = [...harness.ragflow.documents.values()].at(-1)!;
    const { rows: [op] } = await harness.pool.query(
      "SELECT id FROM operation WHERE kind='document.parse' AND resource_id=$1", [doc.knowledgeRef]);
    let received!: () => void;
    const barrier = new Promise<void>((resolve) => { received = resolve; });
    harness.ragflow.enqueue((call) => {
      if (call.method !== 'GET' || call.query.id !== upstream.id) return false;
      received();
      return true;
    }, { status: 200, delayMs: 300, body: { code: 0, data: { docs: [{
      id: upstream.id, run, progress: 1, chunk_count: 1,
    }] } } });
    const advancing = harness.operations.advance(op.id, harness.projectId);
    try {
      await barrier;
      const before = await detail(doc.knowledgeRef, doc.version);
      expect((await withdraw(doc.knowledgeRef, doc.version, before.state_revision)).status).toBe(200);
    } finally {
      await advancing;
    }
    expect((await detail(doc.knowledgeRef, doc.version)).status).toBe('withdrawn');
    expect(await downloadStatus(doc.sourceRef, doc.version)).toBe(404);
    const { rows: [after] } = await harness.pool.query('SELECT state FROM operation WHERE id=$1', [op.id]);
    expect(after.state).toBe('cancelled');
  });
});
