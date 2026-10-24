import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { createReadyKnowledgeBase, uploadSampleDocument } from '../helpers/flow.js';

/**
 * M13：上游 run 状态的全部取值分支。
 *
 * 该 tag 的列表实现把 0..4 映射为枚举名，平台同时接受枚举名与数字字符串；
 * 缺失、null 与未知取值都不是合法状态，必须按协议错误处理。
 *
 * 断言口径：
 * - 数字字符串 "0".."4" 与枚举名 UNSTART/RUNNING/CANCEL/DONE/FAIL 落到同一语义；
 * - 非法取值（缺失 run、run=null、未知字符串）落成协议错误，不得当成「还在解析」。
 */
describe('M13 上游 run 状态分支', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm13run' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  interface ParseOutcome {
    operationState: string;
    operationLastError: string | null;
    versionStatus: string;
    versionLastError: string | null;
    chunkCount: number | null;
    indexRevision: string | null;
  }

  /**
   * 跑一次「上传 -> 解析轮询」，把上游回包替换成指定的 run 取值。
   *
   * runValue 为 undefined 表示上游回包里根本没有 run 字段。
   */
  async function runParseWithRun(
    name: string,
    runValue: unknown,
    options: { progress?: number; chunkCount?: number } = {},
  ): Promise<ParseOutcome> {
    harness.ragflow.reset();
    const { kbId } = await createReadyKnowledgeBase(harness, token, name);
    const uploaded = await uploadSampleDocument(harness, token, kbId, { marker: name });
    await harness.advanceAll();

    const documentId = [...harness.ragflow.documents.keys()].at(-1);
    if (!documentId) throw new Error('upstream document was not created');

    const doc: Record<string, unknown> = {
      id: documentId,
      progress: options.progress ?? 0,
      chunk_count: options.chunkCount ?? null,
      progress_msg: '',
    };
    if (runValue !== undefined) doc.run = runValue;

    harness.ragflow.enqueue(
      (call) =>
        call.method === 'GET' &&
        call.path.endsWith('/documents') &&
        call.query.id !== undefined,
      { status: 200, body: { code: 0, data: { docs: [doc] }, message: 'success' } },
      10,
    );
    await harness.advanceAll();

    const { rows } = await harness.pool.query<{ id: string }>(
      `SELECT id FROM operation
        WHERE kind = 'document.parse' AND resource_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [uploaded.knowledgeRef],
    );
    const operationId = rows[0]?.id;
    if (!operationId) throw new Error('parse operation was not created');

    const operation = await harness.request({
      method: 'GET',
      path: `/operations/${operationId}`,
      token,
    });
    const detail = await harness.request({
      method: 'GET',
      path: `/knowledge/${uploaded.knowledgeRef}/versions/${uploaded.version}`,
      token,
    });

    return {
      operationState: operation.body.data.state,
      operationLastError: operation.body.data.last_error,
      versionStatus: detail.body.data.status,
      versionLastError: detail.body.data.last_error,
      chunkCount: detail.body.data.chunk_count,
      indexRevision: detail.body.data.index_revision,
    };
  }

  it('run 为数字字符串 "0" 时按未开始处理，保持解析中', async () => {
    const outcome = await runParseWithRun('M13 run-0', '0');

    expect(outcome.operationState).toBe('in_progress');
    expect(outcome.operationLastError).toBeNull();
    expect(outcome.versionStatus).toBe('parsing');
    expect(outcome.versionStatus).not.toBe('ready');
  });

  it('run 为数字字符串 "1" 时按解析中处理，不进入 ready', async () => {
    const outcome = await runParseWithRun('M13 run-1', '1');

    expect(outcome.operationState).toBe('in_progress');
    expect(outcome.operationLastError).toBeNull();
    expect(outcome.versionStatus).toBe('parsing');
    expect(outcome.versionStatus).not.toBe('ready');
  });

  it('run 为数字字符串 "2" 时按取消处理，落成失败终态', async () => {
    const outcome = await runParseWithRun('M13 run-2', '2');

    expect(outcome.operationState).toBe('failed');
    expect(outcome.operationLastError).toBe('parse cancelled');
    expect(outcome.versionStatus).toBe('failed');
  });

  it('run 为数字字符串 "3" 且进度完成、分块数大于 0 时进入 ready', async () => {
    const outcome = await runParseWithRun('M13 run-3', '3', {
      progress: 1,
      chunkCount: 2,
    });

    expect(outcome.operationState).toBe('succeeded');
    expect(outcome.operationLastError).toBeNull();
    expect(outcome.versionStatus).toBe('ready');
    expect(outcome.chunkCount).toBe(2);
    expect(outcome.indexRevision).toBeTruthy();
  });

  it('run 为数字字符串 "4" 时按解析失败处理，落成失败终态', async () => {
    const outcome = await runParseWithRun('M13 run-4', '4');

    expect(outcome.operationState).toBe('failed');
    expect(outcome.operationLastError).toBe('parse failed upstream');
    expect(outcome.versionStatus).toBe('failed');
  });

  it('run 为枚举名 UNSTART 时保持解析中，不当成失败', async () => {
    const outcome = await runParseWithRun('M13 run-unstart', 'UNSTART');

    expect(outcome.operationState).toBe('in_progress');
    expect(outcome.operationLastError).toBeNull();
    expect(outcome.versionStatus).toBe('parsing');
  });

  it('上游回包缺少 run 字段时按协议错误处理', async () => {
    const outcome = await runParseWithRun('M13 run-missing', undefined);

    expect(outcome.operationState).toBe('failed');
    expect(outcome.operationLastError).toBe(
      'upstream response did not match the fixed contract',
    );
    expect(outcome.versionStatus).toBe('failed');
  });

  it('上游 run 为 null 时按协议错误处理', async () => {
    const outcome = await runParseWithRun('M13 run-null', null);

    expect(outcome.operationState).toBe('failed');
    expect(outcome.operationLastError).toBe(
      'upstream response did not match the fixed contract',
    );
    expect(outcome.versionStatus).toBe('failed');
  });

  it('上游 run 为未知字符串时按协议错误处理', async () => {
    const outcome = await runParseWithRun('M13 run-unknown', 'SOMETHING_ELSE');

    expect(outcome.operationState).toBe('failed');
    expect(outcome.operationLastError).toBe(
      'upstream response did not match the fixed contract',
    );
    expect(outcome.versionStatus).toBe('failed');
  });
});
