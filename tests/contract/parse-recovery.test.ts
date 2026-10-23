import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { createReadyKnowledgeBase, uploadSampleDocument } from '../helpers/flow.js';

/**
 * M14：解析超时后的终态处置。
 *
 * 断言口径：超过解析截止时间必须进入终态失败并停止自动轮询；
 * 不得继续对上游发状态查询，知识版本状态必须是 failed 而不是一直「解析中」。
 */
describe('M14 解析超时终态', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    // 截止时间取 1ms，保证一旦进入解析推进就一定超时。
    harness = await createHarness({ label: 'm14', parseDeadlineMs: 1 });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('超过截止时间后进入终态失败并停止轮询', async () => {
    harness.ragflow.reset();
    const { kbId, datasetId } = await createReadyKnowledgeBase(harness, token, 'M14 超时');
    const uploaded = await uploadSampleDocument(harness, token, kbId, { marker: 'M14-DEADLINE' });

    await harness.advanceAll();
    // 解析是独立登记的操作项，超时判定作用在它身上。
    const { rows } = await harness.pool.query<{ id: string }>(
      `SELECT id FROM operation
        WHERE scope_id = $1 AND kind = 'document.parse'
        ORDER BY created_at DESC LIMIT 1`,
      [harness.projectId],
    );
    const parseOperationId = rows[0]!.id;

    // 越过截止时间。
    await new Promise((resolve) => setTimeout(resolve, 30));
    await harness.advanceAll();

    const operation = await harness.request({
      method: 'GET',
      path: `/operations/${parseOperationId}`,
      token,
    });
    expect(operation.body.data.state).toBe('failed');

    const detail = await harness.request({
      method: 'GET',
      path: `/knowledge/${uploaded.knowledgeRef}/versions/${uploaded.version}`,
      token,
    });
    expect(detail.body.data.status).toBe('failed');
    expect(detail.body.data.last_error).toContain('deadline');

    // 超时判定发生在状态查询之前，因此不应有任何解析状态查询。
    const statusQueries = harness.ragflow.calls.filter(
      (call) => call.method === 'GET' && call.path === `/api/v1/datasets/${datasetId}/documents`,
    );
    expect(statusQueries).toHaveLength(0);

    // 终态后不再产生新的上游调用。
    const before = harness.ragflow.calls.length;
    await harness.advanceAll();
    expect(harness.ragflow.calls.length).toBe(before);
  });
});
