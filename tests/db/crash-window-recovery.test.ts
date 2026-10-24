import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { remoteDocumentName } from '@aip/api';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { createReadyKnowledgeBase, uploadSampleDocument, prepareApprovedDocument } from '../helpers/flow.js';

/**
 * 崩溃窗口恢复：上游写成功、本地提交之前进程退出。
 *
 * 这类故障的特征是「本地没有远端 ID，但上游可能已经有了」。
 * 平台不能靠猜：恢复时先只读核对上游，
 * 无法确认时保持 unknown_outcome，不依据查询未命中重发。
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

  it('数据集创建崩溃窗口：重复核对未命中仍不重发，迟到对象可被认领', async () => {
    const created = await harness.request({
      method: 'POST',
      path: '/knowledge-bases',
      token,
      idempotencyKey: 'crash-dataset-miss',
      json: { name: '崩溃窗口知识库二', description: '' },
    });
    const operationId = created.body.data.operation_id as string;
    await setCrashWindow(operationId, { stage: 'dataset_create_attempted' });

    for (let attempt = 0; attempt < 9; attempt++) {
      await harness.pool.query('UPDATE operation SET next_attempt_at=NULL WHERE id=$1', [operationId]);
      const result = await harness.operations.advance(operationId, harness.projectId);
      expect(result.state).toBe('unknown_outcome');
      expect(datasetCreates()).toBe(0);
    }
    const { rows: [parked] } = await harness.pool.query('SELECT next_attempt_at, result FROM operation WHERE id=$1', [operationId]);
    expect(parked.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 365 * 86400000);
    harness.ragflow.datasets.set('delayed', { id: 'delayed', name: parked.result.datasetName, description: '' });
    await harness.pool.query('UPDATE operation SET next_attempt_at=NULL WHERE id=$1', [operationId]);
    expect((await harness.operations.advance(operationId, harness.projectId)).state).toBe('succeeded');
    expect(datasetCreates()).toBe(0);
  });

  it('文档上传崩溃窗口：已持久化远端身份时认领上游文档，不重复上传', async () => {
    const kb = await createReadyKnowledgeBase(harness, token);
    const doc = await uploadSampleDocument(harness, token, kb.kbId, {
      fileName: 'crash-window.md',
    });
    const remoteName = remoteDocumentName('crash-window.md', doc.sourceRef, doc.version);

    // 上游已经收到文件，但本地还没记住远端文档 ID。
    // 远端文档名带来源标识：用户文件名可能重复，不能只按用户文件名认领。
    harness.ragflow.documents.set('doc-crash', {
      id: 'doc-crash',
      datasetId: kb.datasetId,
      name: remoteName,
      run: 'UNSTART',
      progress: 0,
      chunk_count: null,
      progress_msg: '',
      content: '崩溃窗口',
    });
    // 崩溃发生在「身份已经落库、远端 ID 还没记下来」之后：身份可靠，可以认领。
    await setCrashWindow(
      doc.operationId,
      { stage: 'upload_attempted', documentId: undefined, remoteName },
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

  it('文档上传崩溃窗口：没有持久化远端身份的历史操作不认领同名候选', async () => {
    const kb = await createReadyKnowledgeBase(harness, token);
    const doc = await uploadSampleDocument(harness, token, kb.kbId, {
      fileName: 'crash-window-legacy.md',
    });

    // 历史形态：发送意图已落库，但没有持久化远端身份。
    // 上游恰好存在一个与新算法推算名相同的文档，但没有任何证据证明
    // 旧实现曾经发送过这个名字：不能据此认领。
    harness.ragflow.documents.set('doc-legacy-candidate', {
      id: 'doc-legacy-candidate',
      datasetId: kb.datasetId,
      name: remoteDocumentName('crash-window-legacy.md', doc.sourceRef, doc.version),
      run: 'UNSTART',
      progress: 0,
      chunk_count: null,
      progress_msg: '',
      content: '历史候选',
    });
    await setCrashWindow(
      doc.operationId,
      { stage: 'upload_attempted', documentId: undefined, remoteName: undefined },
      { clearRemoteId: true },
    );

    await harness.operations.advance(doc.operationId, harness.projectId);

    expect(documentUploads()).toBe(0);
    const { rows } = await harness.pool.query(
      `SELECT state, remote_id FROM operation WHERE id = $1`,
      [doc.operationId],
    );
    expect(rows[0]!.remote_id).toBeNull();
    expect(rows[0]!.state).toBe('unknown_outcome');
  });

  it('上传查询持续未命中也不重新上传', async () => {
    const kb = await createReadyKnowledgeBase(harness, token);
    const doc = await uploadSampleDocument(harness, token, kb.kbId);
    await setCrashWindow(doc.operationId, { stage: 'upload_attempted' });
    for (let i = 0; i < 3; i++) {
      await harness.pool.query('UPDATE operation SET next_attempt_at=NULL WHERE id=$1', [doc.operationId]);
      expect((await harness.operations.advance(doc.operationId, harness.projectId)).state).toBe('unknown_outcome');
    }
    expect(documentUploads()).toBe(0);
    expect(parseTriggers()).toBe(0);
  });

  it('重建崩溃窗口：旧 DONE 不证明本次重建未送达，也不冒充完成', async () => {
    const kb = await createReadyKnowledgeBase(harness, token);
    const doc = await prepareApprovedDocument(harness, token, kb.kbId);
    const response = await harness.request({ method: 'POST',
      path: `/knowledge/${doc.knowledgeRef}/versions/${doc.version}/reindex`,
      token, idempotencyKey: 'reindex-crash-done' });
    expect(response.status).toBe(202);
    const id = response.body.data.operation_id as string;
    await setCrashWindow(id, { stage: 'reindex_attempted' });
    const before = parseTriggers();
    for (let i = 0; i < 3; i++) {
      await harness.pool.query('UPDATE operation SET next_attempt_at=NULL WHERE id=$1', [id]);
      expect((await harness.operations.advance(id, harness.projectId)).state).toBe('unknown_outcome');
    }
    expect(parseTriggers()).toBe(before);
    const { rows } = await harness.pool.query('SELECT id FROM index_revision WHERE knowledge_id=$1', [doc.knowledgeRef]);
    expect(rows).toHaveLength(1);
  });

  it('解析启动崩溃窗口：UNSTART 不证明未送达，不重复触发', async () => {
    const kb = await createReadyKnowledgeBase(harness, token);
    const doc = await uploadSampleDocument(harness, token, kb.kbId);
    await harness.advanceAll();

    const { rows } = await harness.pool.query(
      `SELECT result, remote_id FROM operation WHERE id = $1`,
      [doc.operationId],
    );
    const documentId = rows[0]!.remote_id as string;
    expect(documentId).toBeTruthy();

    // 上游仍显示 UNSTART：不能据此排除已接受但尚未调度的请求。
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
    expect(parseTriggers()).toBe(before);
    const { rows: parseRows } = await harness.pool.query(
      `SELECT id FROM operation WHERE scope_id = $1 AND kind = 'document.parse'`,
      [harness.projectId],
    );
    expect(parseRows).toHaveLength(0);
    const { rows: [pending] } = await harness.pool.query("SELECT state FROM operation WHERE id=$1", [doc.operationId]);
    expect(pending.state).toBe('unknown_outcome');
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
