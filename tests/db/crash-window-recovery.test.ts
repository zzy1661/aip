import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { createReadyKnowledgeBase, uploadSampleDocument } from '../helpers/flow.js';

/**
 * 崩溃窗口恢复：上游写成功、本地提交之前进程退出。
 *
 * 这类故障的特征是「本地没有远端 ID，但上游可能已经有了」。
 * 平台不能靠猜：恢复时先只读核对上游，
 * 只有确认上游没有这次写入的痕迹，才允许重发同一个写请求。
 */
describe('崩溃窗口恢复：不重复写入上游', () => {
  let harness: Harness;
  let token: string;

  beforeEach(async () => {
    harness = await createHarness({ label: 'crash_window' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterEach(async () => {
    await harness.close();
  });

  function datasetCreates(): number {
    return harness.ragflow.calls.filter(
      (call) => call.method === 'POST' && call.path === '/api/v1/datasets',
    ).length;
  }

  function documentUploads(): number {
    return harness.ragflow.calls.filter(
      (call) =>
        call.method === 'POST' && /\/api\/v1\/datasets\/[^/]+\/documents$/.test(call.path),
    ).length;
  }

  function parseTriggers(): number {
    return harness.ragflow.calls.filter(
      (call) =>
        call.method === 'POST' && /\/api\/v1\/datasets\/[^/]+\/chunks$/.test(call.path),
    ).length;
  }

  /** 把操作改回「发送意图已落库、本地还没有远端 ID」的崩溃窗口状态。 */
  async function setCrashWindow(
    operationId: string,
    patch: Record<string, unknown>,
    options: { clearRemoteId?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const { rows } = await harness.pool.query(
      `SELECT result FROM operation WHERE id = $1`,
      [operationId],
    );
    const result = rows[0]!.result as Record<string, unknown>;
    const next = { ...result, ...patch };
    await harness.pool.query(
      `UPDATE operation
          SET result = $2::jsonb, state = 'in_progress', epoch = 1,
              lease_until = now() - interval '1 second', next_attempt_at = NULL,
              remote_id = CASE WHEN $3::boolean THEN NULL ELSE remote_id END
        WHERE id = $1`,
      [operationId, JSON.stringify(next), options.clearRemoteId ?? false],
    );
    return next;
  }

  it('数据集创建崩溃窗口：上游已有同名数据集时认领，不重复创建', async () => {
    const created = await harness.request({
      method: 'POST',
      path: '/knowledge-bases',
      token,
      idempotencyKey: 'crash-dataset',
      json: { name: '崩溃窗口知识库', description: '' },
    });
    expect(created.status).toBe(202);
    const operationId = created.body.data.operation_id as string;
    const kbId = created.body.data.kb_id as string;

    const { rows } = await harness.pool.query(
      `SELECT result FROM operation WHERE id = $1`,
      [operationId],
    );
    const datasetName = (rows[0]!.result as { datasetName: string }).datasetName;
    await setCrashWindow(operationId, { stage: 'dataset_create_attempted' });

    // 上游已经建好同名数据集，但本地还没记住远端 ID。
    harness.ragflow.datasets.set('already-created', {
      id: 'already-created',
      name: datasetName,
      description: '',
    });

    await harness.operations.advance(operationId, harness.projectId);

    expect(datasetCreates()).toBe(0);
    expect(harness.ragflow.datasets.size).toBe(1);

    const detail = await harness.request({ method: 'GET', path: `/knowledge-bases/${kbId}`, token });
    expect(detail.body.data.ragflow_dataset_id).toBe('already-created');
    expect(detail.body.data.status).toBe('ready');
  });

  it('数据集创建崩溃窗口：上游查不到时先只读核对，连续两次未命中才允许重发', async () => {
    const created = await harness.request({
      method: 'POST',
      path: '/knowledge-bases',
      token,
      idempotencyKey: 'crash-dataset-miss',
      json: { name: '崩溃窗口知识库二', description: '' },
    });
    const operationId = created.body.data.operation_id as string;
    await setCrashWindow(operationId, { stage: 'dataset_create_attempted' });

    // 第一次恢复：只读核对没有命中，但一次未命中不足以证明没送达，不重发。
    await harness.operations.advance(operationId, harness.projectId);
    expect(datasetCreates()).toBe(0);
    expect(harness.ragflow.datasets.size).toBe(0);

    // 退避时间到点后再次恢复：连续两次核对未命中，才判定上一次写入没有生效。
    await harness.pool.query(
      `UPDATE operation SET next_attempt_at = NULL WHERE id = $1`,
      [operationId],
    );
    await harness.operations.advance(operationId, harness.projectId);
    expect(datasetCreates()).toBe(1);
    expect(harness.ragflow.datasets.size).toBe(1);
  });

  it('文档上传崩溃窗口：上游已有同名文档时认领，不重复上传', async () => {
    const kb = await createReadyKnowledgeBase(harness, token);
    const doc = await uploadSampleDocument(harness, token, kb.kbId, {
      fileName: 'crash-window.md',
    });

    // 上游已经收到文件，但本地还没记住远端文档 ID。
    harness.ragflow.documents.set('doc-crash', {
      id: 'doc-crash',
      datasetId: kb.datasetId,
      name: 'crash-window.md',
      run: 'UNSTART',
      progress: 0,
      chunk_count: null,
      progress_msg: '',
      content: '崩溃窗口',
    });
    await setCrashWindow(
      doc.operationId,
      { stage: 'upload_attempted', documentId: undefined },
      { clearRemoteId: true },
    );

    await harness.operations.advance(doc.operationId, harness.projectId);

    expect(documentUploads()).toBe(0);
    const { rows } = await harness.pool.query(
      `SELECT remote_id FROM operation WHERE id = $1`,
      [doc.operationId],
    );
    expect(rows[0]!.remote_id).toBe('doc-crash');
  });

  it('解析启动崩溃窗口：上游还没开始解析时补发一次触发', async () => {
    const kb = await createReadyKnowledgeBase(harness, token);
    const doc = await uploadSampleDocument(harness, token, kb.kbId);
    await harness.advanceAll();

    const { rows } = await harness.pool.query(
      `SELECT result, remote_id FROM operation WHERE id = $1`,
      [doc.operationId],
    );
    const documentId = rows[0]!.remote_id as string;
    expect(documentId).toBeTruthy();

    // 崩溃发生在触发解析之前：上游文档还没开始解析。
    const upstreamDocument = [...harness.ragflow.documents.values()].at(-1);
    expect(upstreamDocument).toBeDefined();
    upstreamDocument!.run = 'UNSTART';

    // 清掉上一次推进建好的解析操作，模拟「触发解析之前」退出。
    await harness.pool.query(
      `DELETE FROM operation WHERE scope_id = $1 AND kind = 'document.parse'`,
      [harness.projectId],
    );
    await setCrashWindow(doc.operationId, { stage: 'parse_attempted', documentId });

    const before = parseTriggers();
    const uploadsBefore = documentUploads();
    await harness.operations.advance(doc.operationId, harness.projectId);

    expect(documentUploads()).toBe(uploadsBefore);
    expect(parseTriggers()).toBe(before + 1);
    const { rows: parseRows } = await harness.pool.query(
      `SELECT id FROM operation WHERE scope_id = $1 AND kind = 'document.parse'`,
      [harness.projectId],
    );
    expect(parseRows).toHaveLength(1);
  });

  it('解析启动崩溃窗口：上游已经在解析时不重复触发', async () => {
    const kb = await createReadyKnowledgeBase(harness, token);
    const doc = await uploadSampleDocument(harness, token, kb.kbId);
    await harness.advanceAll();

    const { rows } = await harness.pool.query(
      `SELECT remote_id FROM operation WHERE id = $1`,
      [doc.operationId],
    );
    const documentId = rows[0]!.remote_id as string;
    const upstreamDocument = [...harness.ragflow.documents.values()].at(-1);
    expect(upstreamDocument).toBeDefined();
    // 上游已经在解析：触发请求送达过，不能再补发。
    upstreamDocument!.run = 'RUNNING';

    await harness.pool.query(
      `DELETE FROM operation WHERE scope_id = $1 AND kind = 'document.parse'`,
      [harness.projectId],
    );
    await setCrashWindow(doc.operationId, { stage: 'parse_attempted', documentId });

    const before = parseTriggers();
    const uploadsBefore = documentUploads();
    await harness.operations.advance(doc.operationId, harness.projectId);

    expect(documentUploads()).toBe(uploadsBefore);
    expect(parseTriggers()).toBe(before);
  });
});
