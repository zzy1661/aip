import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { createReadyKnowledgeBase, prepareApprovedDocument } from '../helpers/flow.js';
import { registerSkillRequest, skillPayload } from '../helpers/fixtures.js';

/**
 * M22 / M23：检索范围限制与详情语义。
 *
 * 断言口径：
 * - top_n 越界必须在边界被拒（422 CONTRACT_INVALID），错误定位到 top_n 字段；
 * - 授权范围跨越多个数据集时必须整体拒绝，而不是退化成跨库检索；
 * - 资产详情必须原样带出 payload.concept_validation，不允许被脱敏或省略。
 */
describe('M22/M23 检索范围与详情语义', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm22ret' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  function retrievalCalls(): number {
    return harness.ragflow.calls.filter((call) => call.path === '/api/v1/retrieval').length;
  }

  it('top_n 超过上限时返回 422 CONTRACT_INVALID 并定位到 top_n', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M22 top_n 上限');
    const before = retrievalCalls();

    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'top_n 越界', kb_ids: [kbId], top_n: 9999 },
    });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('CONTRACT_INVALID');
    const paths = (response.body.details as Array<{ field_path: string }>).map(
      (detail) => detail.field_path,
    );
    expect(paths).toContain('top_n');
    // 越界请求不得触达上游。
    expect(retrievalCalls()).toBe(before);
  });

  it('top_n 为 0 时同样被拒', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M22 top_n 下限');
    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'top_n 下界', kb_ids: [kbId], top_n: 0 },
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('CONTRACT_INVALID');
    const paths = (response.body.details as Array<{ field_path: string }>).map(
      (detail) => detail.field_path,
    );
    expect(paths).toContain('top_n');
  });

  it('top_n 取上限值时被接受', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M22 top_n 合法');
    const before = retrievalCalls();
    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'top_n 合法', kb_ids: [kbId], top_n: 20 },
    });
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('no_match');
    expect(retrievalCalls()).toBe(before);
  });

  it('授权范围跨越多个数据集时整体拒绝，不产生上游检索', async () => {
    const first = await createReadyKnowledgeBase(harness, token, 'M22 多库一');
    const second = await createReadyKnowledgeBase(harness, token, 'M22 多库二');
    await prepareApprovedDocument(harness, token, first.kbId, { marker: 'M22-MULTI-1' });
    await prepareApprovedDocument(harness, token, second.kbId, { marker: 'M22-MULTI-2' });

    const before = retrievalCalls();
    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M22-MULTI', kb_ids: [first.kbId, second.kbId] },
    });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('AUTHORIZED_SCOPE_TOO_LARGE');
    expect(response.body.message).toContain('more than one dataset');
    expect(retrievalCalls()).toBe(before);
  });

  it('单个数据集内的授权范围可以正常检索', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M22 单库');
    const document = await prepareApprovedDocument(harness, token, kbId, {
      marker: 'M22-SINGLE',
    });
    const before = retrievalCalls();

    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M22-SINGLE', kb_ids: [kbId] },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('no_match');
    // 空检索结果仍然是走完了上游检索协议的证据。
    expect(retrievalCalls()).toBe(before + 1);
    expect(document.knowledgeRef).toBeTruthy();
  });

  it('资产详情带出 payload.concept_validation', async () => {
    const registered = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm23-detail',
      json: registerSkillRequest({
        slug: 'm23-detail-skill',
        payload: skillPayload({ concept_validation: 'not_requested' }),
      }),
    });
    expect(registered.status).toBe(201);
    const assetId = registered.body.data.asset_id as string;

    const detail = await harness.request({
      method: 'GET',
      path: `/assets/${assetId}/versions/1.0.0`,
      token,
    });

    expect(detail.status).toBe(200);
    expect(detail.body.data.version).toBe('1.0.0');
    expect(detail.body.data.payload.concept_validation).toBe('not_requested');
    expect(detail.body.data.payload.content.kind).toBe('inline_markdown');
  });
});
