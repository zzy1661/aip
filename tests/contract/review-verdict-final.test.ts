import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import {
  createReadyKnowledgeBase,
  prepareApprovedDocument,
  seedRetrievalChunk,
  uploadAndParse,
} from '../helpers/flow.js';

/**
 * ZACH-17 裁决 (a)：已批准的版本是审核终态，不能再被改判为拒绝。
 *
 * 断言口径：
 * - `approved → rejected` 返回稳定错误码 409 `REVIEW_ALREADY_APPROVED`；
 * - 被拒的改判不写审核记录、不改 `review_status`、不推进 `state_revision`；
 * - `approved → approved` 幂等：返回当前已生效的审核事实，不写审核记录；
 * - `pending → approved` / `pending → rejected` 两条路径不受影响；
 * - 改判被拒后检索仍能命中该版本（检索与下载对同一版本的结论一致）。
 */
describe('审核终态：已批准的版本不能被改判', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'review_final' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  async function approvedVersion(marker: string) {
    const { kbId } = await createReadyKnowledgeBase(harness, token, `终态 ${marker}`);
    const document = await prepareApprovedDocument(harness, token, kbId, { marker });
    const detail = await harness.request({
      method: 'GET',
      path: `/knowledge/${document.knowledgeRef}/versions/${document.version}`,
      token,
    });
    return {
      kbId,
      document,
      contentHash: detail.body.data.content_hash as string,
      stateRevision: detail.body.data.state_revision as number,
    };
  }

  async function reviewCount(knowledgeRef: string, version: string): Promise<number> {
    const { rows } = await harness.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM knowledge_review
        WHERE scope_id = $1 AND knowledge_id = $2 AND version = $3`,
      [harness.projectId, knowledgeRef, version],
    );
    return Number(rows[0]!.count);
  }

  it('已批准的版本再次审核为 rejected 返回 409 REVIEW_ALREADY_APPROVED', async () => {
    const { document, contentHash } = await approvedVersion('终态-改判');
    const response = await harness.request({
      method: 'POST',
      path: `/knowledge/${document.knowledgeRef}/versions/${document.version}/review`,
      token,
      json: {
        decision: 'rejected',
        expected_hash: contentHash,
        reason: '试图把已批准的版本改判为拒绝',
      },
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('REVIEW_ALREADY_APPROVED');
    expect(response.body.details[0].field_path).toBe('decision');
  });

  it('被拒的改判不写审核记录、不改结论、不推进修订号', async () => {
    const { document, contentHash, stateRevision } = await approvedVersion('终态-无副作用');
    const reviewsBefore = await reviewCount(document.knowledgeRef, document.version);

    const response = await harness.request({
      method: 'POST',
      path: `/knowledge/${document.knowledgeRef}/versions/${document.version}/review`,
      token,
      json: {
        decision: 'rejected',
        expected_hash: contentHash,
        reason: '试图把已批准的版本改判为拒绝',
      },
    });
    expect(response.status).toBe(409);

    const detail = await harness.request({
      method: 'GET',
      path: `/knowledge/${document.knowledgeRef}/versions/${document.version}`,
      token,
    });
    expect(detail.body.data.review_status).toBe('approved');
    expect(detail.body.data.state_revision).toBe(stateRevision);
    expect(await reviewCount(document.knowledgeRef, document.version)).toBe(reviewsBefore);
  });

  it('已批准的版本同结论重复审核按幂等返回当前状态，不写审核记录', async () => {
    const { document, contentHash, stateRevision } = await approvedVersion('终态-幂等');
    const reviewsBefore = await reviewCount(document.knowledgeRef, document.version);

    const response = await harness.request({
      method: 'POST',
      path: `/knowledge/${document.knowledgeRef}/versions/${document.version}/review`,
      token,
      json: {
        decision: 'approved',
        expected_hash: contentHash,
        reason: '再次确认通过',
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.review_status).toBe('approved');
    expect(response.body.data.state_revision).toBe(stateRevision);
    // 幂等重放不产生新的审核记录。
    expect(await reviewCount(document.knowledgeRef, document.version)).toBe(reviewsBefore);
  });

  it('pending 的两条审核路径不受影响', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, '终态-pending');

    const toApprove = await uploadAndParse(harness, token, kbId, { marker: '终态-pending-通过' });
    const approveDetail = await harness.request({
      method: 'GET',
      path: `/knowledge/${toApprove.knowledgeRef}/versions/${toApprove.version}`,
      token,
    });
    const approved = await harness.request({
      method: 'POST',
      path: `/knowledge/${toApprove.knowledgeRef}/versions/${toApprove.version}/review`,
      token,
      json: {
        decision: 'approved',
        expected_hash: approveDetail.body.data.content_hash as string,
        reason: '通过',
      },
    });
    expect(approved.status).toBe(200);
    expect(approved.body.data.review_status).toBe('approved');

    const toReject = await uploadAndParse(harness, token, kbId, { marker: '终态-pending-拒绝' });
    const rejectDetail = await harness.request({
      method: 'GET',
      path: `/knowledge/${toReject.knowledgeRef}/versions/${toReject.version}`,
      token,
    });
    const rejected = await harness.request({
      method: 'POST',
      path: `/knowledge/${toReject.knowledgeRef}/versions/${toReject.version}/review`,
      token,
      json: {
        decision: 'rejected',
        expected_hash: rejectDetail.body.data.content_hash as string,
        reason: '拒绝',
      },
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.review_status).toBe('rejected');
  });

  it('已批准的版本即使哈希不匹配也仍然落在同一个稳定错误码上', async () => {
    const { document } = await approvedVersion('终态-错误码稳定');

    const response = await harness.request({
      method: 'POST',
      path: `/knowledge/${document.knowledgeRef}/versions/${document.version}/review`,
      token,
      json: {
        decision: 'rejected',
        expected_hash: 'not-the-real-hash',
        reason: '哈希不匹配的改判也必须落到稳定错误码',
      },
    });

    // 终态判定优先于哈希前置条件：错误码必须是 REVIEW_ALREADY_APPROVED，
    // 不能被改写成 STATE_CONFLICT。
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('REVIEW_ALREADY_APPROVED');
  });

  it('同一版本并发两次审核只有一次成功，另一方得到明确冲突且不产生双写', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, '终态-并发');
    const document = await uploadAndParse(harness, token, kbId, { marker: '终态-并发' });
    const detail = await harness.request({
      method: 'GET',
      path: `/knowledge/${document.knowledgeRef}/versions/${document.version}`,
      token,
    });
    const contentHash = detail.body.data.content_hash as string;
    const path = `/knowledge/${document.knowledgeRef}/versions/${document.version}/review`;

    const [approve, reject] = await Promise.all([
      harness.request({
        method: 'POST',
        path,
        token,
        json: { decision: 'approved', expected_hash: contentHash, reason: '并发通过' },
      }),
      harness.request({
        method: 'POST',
        path,
        token,
        json: { decision: 'rejected', expected_hash: contentHash, reason: '并发拒绝' },
      }),
    ]);

    // 只有一方成功，另一方拿到明确的冲突错误码。
    expect([approve.status, reject.status].sort()).toEqual([200, 409]);
    const loser = approve.status === 409 ? approve : reject;
    expect(['STATE_CONFLICT', 'REVIEW_ALREADY_APPROVED']).toContain(loser.body.code);

    // 不产生双写：审核记录只有一条。
    const { rows } = await harness.pool.query<{ decision: string }>(
      `SELECT decision FROM knowledge_review
        WHERE scope_id = $1 AND knowledge_id = $2 AND version = $3`,
      [harness.projectId, document.knowledgeRef, document.version],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decision).toBe(approve.status === 200 ? 'approved' : 'rejected');
  });

  it('已批准的版本并发改判为 rejected：两次都被拒，状态与审核记录都不变', async () => {
    const { document, contentHash } = await approvedVersion('终态-并发改判');
    const reviewsBefore = await reviewCount(document.knowledgeRef, document.version);
    const path = `/knowledge/${document.knowledgeRef}/versions/${document.version}/review`;

    const responses = await Promise.all([
      harness.request({
        method: 'POST',
        path,
        token,
        json: { decision: 'rejected', expected_hash: contentHash, reason: '并发改判 1' },
      }),
      harness.request({
        method: 'POST',
        path,
        token,
        json: { decision: 'rejected', expected_hash: contentHash, reason: '并发改判 2' },
      }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('REVIEW_ALREADY_APPROVED');
    }
    expect(await reviewCount(document.knowledgeRef, document.version)).toBe(reviewsBefore);
  });

  it('改判被拒后检索仍命中该版本：检索与下载对同一版本的结论一致', async () => {
    const { kbId, document, contentHash } = await approvedVersion('终态-一致性');
    seedRetrievalChunk(harness, {
      documentId: document.documentId,
      datasetId: document.datasetId,
      content: '终态-一致性',
    });

    const before = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: '终态-一致性', kb_ids: [kbId] },
    });
    expect(before.body.data.status).toBe('authorized_evidence');
    expect(before.body.data.evidence).toHaveLength(1);

    const rejected = await harness.request({
      method: 'POST',
      path: `/knowledge/${document.knowledgeRef}/versions/${document.version}/review`,
      token,
      json: { decision: 'rejected', expected_hash: contentHash, reason: '试图改判' },
    });
    expect(rejected.status).toBe(409);
    expect(rejected.body.code).toBe('REVIEW_ALREADY_APPROVED');

    const after = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: '终态-一致性', kb_ids: [kbId] },
    });
    expect(after.body.data.status).toBe('authorized_evidence');
    expect(after.body.data.evidence).toHaveLength(1);

    // 下载路径同样放行：两条路径对同一版本的结论一致（仍是被批准、可下载）。
    const download = await harness.request({
      method: 'GET',
      path: `/sources/${document.sourceRef}/versions/${document.version}/download`,
      token,
    });
    expect(download.status).toBe(200);
    expect(download.text).toContain('终态-一致性');
  });
});
