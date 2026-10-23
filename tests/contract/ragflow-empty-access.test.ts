import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import {
  createReadyKnowledgeBase,
  prepareApprovedDocument,
  seedRetrievalChunk,
} from '../helpers/flow.js';
import { conditionalAppliesTo } from '../helpers/fixtures.js';

/**
 * M17：空授权与上下文不足时的零上游请求。
 *
 * 断言口径：授权集合为空或适用条件不满足时，一次上游请求都不允许发生。
 */
describe('M17 空授权零上游请求', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm17' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('没有文档授权的主体检索时不产生任何上游请求', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M17 空授权');
    const otherToken = await harness.token({ subject: 'user-empty', permissions: ALL_PERMISSIONS });

    const before = harness.ragflow.calls.length;
    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token: otherToken,
      json: { query: '任意查询', kb_ids: [kbId] },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('no_match');
    expect(response.body.data.evidence).toHaveLength(0);
    expect(harness.ragflow.calls.slice(before)).toHaveLength(0);
  });

  it('条件适用但上下文缺失时返回 needs_context 且不产生上游请求', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M17 条件知识');
    const document = await prepareApprovedDocument(harness, token, kbId, {
      marker: 'M17-COND',
      appliesTo: conditionalAppliesTo('cn'),
    });
    seedRetrievalChunk(harness, {
      documentId: document.documentId,
      datasetId: document.datasetId,
      content: 'M17-COND',
    });

    const before = harness.ragflow.calls.length;
    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M17-COND', kb_ids: [kbId], context: { region: 'us' } },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('needs_context');
    expect(response.body.data.evidence).toHaveLength(0);
    expect(harness.ragflow.calls.slice(before)).toHaveLength(0);
  });

  it('条件命中时才检索，且白名单只包含命中的文档', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M17 条件命中');
    const document = await prepareApprovedDocument(harness, token, kbId, {
      marker: 'M17-HIT',
      appliesTo: conditionalAppliesTo('cn'),
    });
    seedRetrievalChunk(harness, {
      documentId: document.documentId,
      datasetId: document.datasetId,
      content: 'M17-HIT',
    });

    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M17-HIT', kb_ids: [kbId], context: { region: 'cn' } },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('authorized_evidence');
    expect(response.body.data.evidence).toHaveLength(1);
  });
});
