import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { operationsRepository, withTransaction } from '@aip/api';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { createReadyKnowledgeBase, uploadSampleDocument } from '../helpers/flow.js';

/**
 * M-1 / M-2：epoch 栅栏与租约边界。
 *
 * 断言口径：
 * - 同一操作同一时刻只能被一个 worker 领取；
 * - 领取即开启新的 epoch，迟到的旧 epoch 写入一律被数据库拒绝；
 * - 旧 epoch 不能释放新 worker 的租约；
 * - 终态失败必须同步回落资源状态；
 * - 写请求响应丢失进入 unknown_outcome，不重发，重启后仍可核对恢复。
 */
describe('M-1/M-2 操作栅栏与租约', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'fencing' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  /**
   * 栅栏用例使用独立 scope：
   * 这些操作不参与 worker 的待处理列表，不会干扰同一文件里的端到端用例。
   */
  const fenceScope = 'fence-scope';

  async function insertOperation(kind: string, idempotencyKey: string): Promise<string> {
    const id = randomUUID();
    await withTransaction(harness.pool, (client) =>
      operationsRepository.insertOperation(client, {
        scopeId: fenceScope,
        id,
        subject: 'user-1',
        kind,
        idempotencyKey,
        requestHash: 'hash',
        state: 'pending',
        resourceId: null,
      }),
    );
    return id;
  }

  it('同一操作同一时刻只有一个 worker 能拿到租约', async () => {
    const id = await insertOperation('knowledge_base.create', 'fence-claim');

    const first = await withTransaction(harness.pool, (client) =>
      operationsRepository.claimOperationLease(client, fenceScope, id, 40_000),
    );
    expect(first).not.toBeNull();

    const second = await withTransaction(harness.pool, (client) =>
      operationsRepository.claimOperationLease(client, fenceScope, id, 40_000),
    );
    expect(second).toBeNull();
  });

  it('领取后 epoch 递增，旧 epoch 的迟到写入被拒绝', async () => {
    const id = await insertOperation('knowledge_base.create', 'fence-epoch');

    const first = await withTransaction(harness.pool, (client) =>
      operationsRepository.claimOperationLease(client, fenceScope, id, 40_000),
    );
    const staleEpoch = first!.epoch;

    // 模拟租约过期后被新 worker 接管。
    await harness.pool.query(
      `UPDATE operation SET lease_until = now() - interval '1 second'
        WHERE scope_id = $1 AND id = $2`,
      [fenceScope, id],
    );
    const second = await withTransaction(harness.pool, (client) =>
      operationsRepository.claimOperationLease(client, fenceScope, id, 40_000),
    );
    expect(second).not.toBeNull();
    expect(Number(second!.epoch)).toBeGreaterThan(Number(staleEpoch));

    // 迟到的旧 worker 想把状态改成成功：必须被拒绝。
    const staleWrite = await withTransaction(harness.pool, (client) =>
      operationsRepository.setOperationState(
        client,
        fenceScope,
        id,
        'succeeded',
        null,
        staleEpoch,
      ),
    );
    expect(staleWrite).toBe(false);

    const row = await withTransaction(harness.pool, (client) =>
      operationsRepository.findOperation(client, fenceScope, id),
    );
    expect(row!.state).not.toBe('succeeded');

    // 新 epoch 的写入必须成功。
    const freshWrite = await withTransaction(harness.pool, (client) =>
      operationsRepository.setOperationState(
        client,
        fenceScope,
        id,
        'succeeded',
        null,
        second!.epoch,
      ),
    );
    expect(freshWrite).toBe(true);
  });

  it('旧 epoch 不能释放新 worker 的租约', async () => {
    const id = await insertOperation('knowledge_base.create', 'fence-release');

    const first = await withTransaction(harness.pool, (client) =>
      operationsRepository.claimOperationLease(client, fenceScope, id, 40_000),
    );
    await harness.pool.query(
      `UPDATE operation SET lease_until = now() - interval '1 second'
        WHERE scope_id = $1 AND id = $2`,
      [fenceScope, id],
    );
    const second = await withTransaction(harness.pool, (client) =>
      operationsRepository.claimOperationLease(client, fenceScope, id, 40_000),
    );
    expect(second).not.toBeNull();

    await withTransaction(harness.pool, (client) =>
      operationsRepository.releaseOperationLease(
        client,
        fenceScope,
        id,
        first!.epoch,
      ),
    );
    const stillLeased = await withTransaction(harness.pool, (client) =>
      operationsRepository.findOperation(client, fenceScope, id),
    );
    expect(stillLeased!.lease_until).not.toBeNull();

    await withTransaction(harness.pool, (client) =>
      operationsRepository.releaseOperationLease(
        client,
        fenceScope,
        id,
        second!.epoch,
      ),
    );
    const released = await withTransaction(harness.pool, (client) =>
      operationsRepository.findOperation(client, fenceScope, id),
    );
    expect(released!.lease_until).toBeNull();
  });

  it('终态失败时知识库状态同步回落为 failed', async () => {
    harness.ragflow.reset();
    harness.ragflow.enqueue(
      (call) => call.method === 'POST' && call.path === '/api/v1/datasets',
      { status: 200, body: { code: 500, data: null, message: 'upstream internal error' } },
    );

    const created = await harness.request({
      method: 'POST',
      path: '/knowledge-bases',
      token,
      idempotencyKey: 'fence-biz-fail',
      json: { name: '栅栏业务失败', description: '' },
    });
    expect(created.status).toBe(202);
    const kbId = created.body.data.kb_id as string;
    const operationId = created.body.data.operation_id as string;

    await harness.advanceAll();

    const operation = await withTransaction(harness.pool, (client) =>
      operationsRepository.findOperation(client, harness.projectId, operationId),
    );
    expect(operation!.state).toBe('failed');

    const kb = await harness.pool.query<{ status: string }>(
      'SELECT status FROM knowledge_base WHERE scope_id = $1 AND id = $2',
      [harness.projectId, kbId],
    );
    expect(kb.rows[0]!.status).toBe('failed');
  });

  it('写请求响应丢失后进入 unknown_outcome，资源状态不留在 creating，且不重发', async () => {
    harness.ragflow.reset();
    harness.ragflow.dropNext(
      (call) => call.method === 'POST' && call.path === '/api/v1/datasets',
    );

    const created = await harness.request({
      method: 'POST',
      path: '/knowledge-bases',
      token,
      idempotencyKey: 'fence-lost-response',
      json: { name: '栅栏响应丢失', description: '' },
    });
    expect(created.status).toBe(202);
    const kbId = created.body.data.kb_id as string;
    const operationId = created.body.data.operation_id as string;

    await harness.advanceAll();

    const operation = await withTransaction(harness.pool, (client) =>
      operationsRepository.findOperation(client, harness.projectId, operationId),
    );
    expect(operation!.state).toBe('unknown_outcome');

    const kb = await harness.pool.query<{ status: string }>(
      'SELECT status FROM knowledge_base WHERE scope_id = $1 AND id = $2',
      [harness.projectId, kbId],
    );
    expect(kb.rows[0]!.status).toBe('unknown_outcome');

    const datasetPosts = harness.ragflow.calls.filter(
      (call) => call.method === 'POST' && call.path === '/api/v1/datasets',
    );
    expect(datasetPosts).toHaveLength(1);
  });

  it('重启后未推进的操作仍可被接管并推进到终态', async () => {
    const datasetPosts = () =>
      harness.ragflow.calls.filter(
        (call) => call.method === 'POST' && call.path === '/api/v1/datasets',
      ).length;
    const before = datasetPosts();

    const created = await harness.request({
      method: 'POST',
      path: '/knowledge-bases',
      token,
      idempotencyKey: 'fence-restart',
      json: { name: '栅栏重启恢复', description: '' },
    });
    expect(created.status).toBe(202);
    const kbId = created.body.data.kb_id as string;

    // 进程重启：数据库里的待处理操作必须还在。
    await harness.restart();

    await harness.advanceAll();

    const kb = await harness.pool.query<{ status: string }>(
      'SELECT status FROM knowledge_base WHERE scope_id = $1 AND id = $2',
      [harness.projectId, kbId],
    );
    expect(kb.rows[0]!.status).toBe('ready');

    // 重启后接管的是同一个操作：不会重新建一次上游数据集。
    expect(datasetPosts() - before).toBe(1);
  });

  it('文档解析中重启后接着查同一个上游文档，不会重新上传', async () => {
    const kb = await createReadyKnowledgeBase(harness, token, '栅栏文档重启');
    const uploaded = await uploadSampleDocument(harness, token, kb.kbId, {
      marker: 'M14-RESTART',
    });
    await harness.advanceAll();

    const upstreamDocument = [...harness.ragflow.documents.values()].at(-1)!;
    const uploadsBefore = harness.ragflow.calls.filter(
      (call) => call.method === 'POST' && call.path.endsWith('/documents'),
    );

    await harness.restart();
    await harness.advanceAll();

    const uploadsAfter = harness.ragflow.calls.filter(
      (call) => call.method === 'POST' && call.path.endsWith('/documents'),
    );
    // 重启不产生第二次上传：继续使用同一个上游文档。
    expect(uploadsAfter).toHaveLength(uploadsBefore.length);

    // 解析推进仍然作用在同一个上游文档上。
    const parseCalls = harness.ragflow.calls.filter(
      (call) => call.method === 'POST' && call.path.endsWith('/chunks'),
    );
    for (const call of parseCalls) {
      expect(JSON.parse(call.body).document_ids).toEqual([upstreamDocument.id]);
    }

    const row = await harness.pool.query<{ status: string }>(
      'SELECT status FROM knowledge_revision WHERE scope_id = $1 AND knowledge_id = $2',
      [harness.projectId, uploaded.knowledgeRef],
    );
    expect(row.rows[0]!.status).toBe('parsing');
  });
});
