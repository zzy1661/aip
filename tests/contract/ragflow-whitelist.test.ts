import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { createReadyKnowledgeBase, prepareApprovedDocument } from '../helpers/flow.js';

/**
 * M18：检索白名单规模上限。
 *
 * 断言口径：授权文档数超过上限时整单拒绝，并且不允许发出任何上游请求。
 * 上限由 AIP_RETRIEVAL_MAX_DOCUMENTS 控制（生产默认 200，见 docs/runbook.md），
 * 这里用更小的上限跑同一条代码路径。
 */
describe('M18 检索白名单上限', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm18', retrievalMaxDocuments: 1 });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('授权文档数超过上限时返回 422 且不产生上游请求', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M18 知识库');
    await prepareApprovedDocument(harness, token, kbId, { marker: 'M18-DOC-1', version: '1.0.0' });
    await prepareApprovedDocument(harness, token, kbId, { marker: 'M18-DOC-2', version: '2.0.0' });

    const before = harness.ragflow.calls.length;
    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M18', kb_ids: [kbId] },
    });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('AUTHORIZED_SCOPE_TOO_LARGE');
    expect(response.body.details[0].field_path).toBe('kb_ids');
    expect(harness.ragflow.calls.slice(before)).toHaveLength(0);
  });
});
