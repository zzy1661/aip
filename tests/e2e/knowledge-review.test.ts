import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS, REVIEWER_PERMISSIONS } from '../helpers/auth.js';
import { createReadyKnowledgeBase, uploadAndParse } from '../helpers/flow.js';

/**
 * M15：审核闭环。
 *
 * 断言口径：
 * - 审核记录必须落库（审核人、expected_hash、理由、时间、有效期）；
 * - 状态变更使用 CAS（state_revision），过期哈希与并发覆盖都要被拒绝；
 * - 缺少 knowledge:review 权限的主体不能审核。
 */
describe('M15 审核闭环', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm15' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  async function prepare(version = '1.0.0') {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M15 知识库');
    const document = await uploadAndParse(harness, token, kbId, {
      marker: `M15-${Math.random().toString(36).slice(2, 8)}`,
      version,
    });
    const detail = await harness.request({
      method: 'GET',
      path: `/knowledge/${document.knowledgeRef}/versions/${version}`,
      token,
    });
    return { kbId, document, contentHash: detail.body.data.content_hash as string };
  }

  it('审核通过后落库审核记录并推进状态修订号', async () => {
    const { document, contentHash } = await prepare();
    const response = await harness.request({
      method: 'POST',
      path: `/knowledge/${document.knowledgeRef}/versions/${document.version}/review`,
      token,
      json: {
        decision: 'approved',
        expected_hash: contentHash,
        reason: '内容与来源一致',
        valid_from: '2026-01-01T00:00:00.000Z',
        valid_until: '2026-12-31T00:00:00.000Z',
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.review_status).toBe('approved');
    expect(response.body.data.reviewer).toBe('user-1');
    expect(response.body.data.expected_hash).toBe(contentHash);
    expect(response.body.data.state_revision).toBeGreaterThan(0);

    const { rows } = await harness.pool.query(
      `SELECT decision, reviewer, expected_hash, reason, reviewed_at, valid_from, valid_until
         FROM knowledge_review
        WHERE scope_id = $1 AND knowledge_id = $2 AND version = $3`,
      [harness.projectId, document.knowledgeRef, document.version],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe('approved');
    expect(rows[0].reviewer).toBe('user-1');
    expect(rows[0].expected_hash).toBe(contentHash);
    expect(rows[0].reason).toBe('内容与来源一致');
    expect(rows[0].reviewed_at).toBeInstanceOf(Date);
    expect(rows[0].valid_from).toBeInstanceOf(Date);
    expect(rows[0].valid_until).toBeInstanceOf(Date);

    // 有效期同时写在当前知识版本上，供检索路径直接过滤。
    const revision = await harness.pool.query(
      `SELECT review_status, valid_from, valid_until
         FROM knowledge_revision
        WHERE scope_id = $1 AND knowledge_id = $2 AND version = $3`,
      [harness.projectId, document.knowledgeRef, document.version],
    );
    expect(revision.rows[0].review_status).toBe('approved');
    expect(revision.rows[0].valid_from).toBeInstanceOf(Date);
    expect(revision.rows[0].valid_until).toBeInstanceOf(Date);
  });

  it('expected_hash 与当前内容不符时拒绝审核', async () => {
    const { document } = await prepare();
    const response = await harness.request({
      method: 'POST',
      path: `/knowledge/${document.knowledgeRef}/versions/${document.version}/review`,
      token,
      json: { decision: 'approved', expected_hash: 'not-the-real-hash', reason: '哈希不匹配' },
    });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('STATE_CONFLICT');

    const { rows } = await harness.pool.query(
      `SELECT count(*)::int AS count FROM knowledge_review
        WHERE scope_id = $1 AND knowledge_id = $2`,
      [harness.projectId, document.knowledgeRef],
    );
    expect(rows[0].count).toBe(0);
  });

  it('并发审核不会相互覆盖：状态修订号过期的一方被拒绝', async () => {
    const { document, contentHash } = await prepare();
    const path = `/knowledge/${document.knowledgeRef}/versions/${document.version}/review`;

    // 用另一个连接持有行锁，强制请求在 UPDATE 上等待，
    // 从而让「另一个审核人先提交」这件事必然与本次请求重叠。
    const blocker = await harness.pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        `SELECT 1 FROM knowledge_revision
          WHERE scope_id = $1 AND knowledge_id = $2 AND version = $3 FOR UPDATE`,
        [harness.projectId, document.knowledgeRef, document.version],
      );

      const pending = harness.request({
        method: 'POST',
        path,
        token,
        json: { decision: 'approved', expected_hash: contentHash, reason: '并发审核' },
      });

      // 等待请求确实阻塞在行锁上。
      await new Promise((resolve) => setTimeout(resolve, 150));

      // 模拟另一位审核人抢先提交：修订号 +1。
      await blocker.query(
        `UPDATE knowledge_revision SET state_revision = state_revision + 1
          WHERE scope_id = $1 AND knowledge_id = $2 AND version = $3`,
        [harness.projectId, document.knowledgeRef, document.version],
      );
      await blocker.query('COMMIT');

      const response = await pending;
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('STATE_CONFLICT');
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }

    const { rows } = await harness.pool.query(
      `SELECT count(*)::int AS count FROM knowledge_review
        WHERE scope_id = $1 AND knowledge_id = $2 AND version = $3`,
      [harness.projectId, document.knowledgeRef, document.version],
    );
    expect(rows[0].count).toBe(0);
  });

  it('缺少 knowledge:review 权限的主体不能审核', async () => {
    const { document, contentHash } = await prepare();
    const readerToken = await harness.token({ permissions: ['knowledge:read'] });
    const response = await harness.request({
      method: 'POST',
      path: `/knowledge/${document.knowledgeRef}/versions/${document.version}/review`,
      token: readerToken,
      json: { decision: 'approved', expected_hash: contentHash, reason: '越权审核' },
    });
    expect(response.status).toBe(403);
    expect(response.body.message).toContain('knowledge:review');
  });

  it('驳回时不写入有效期区间', async () => {
    const { document, contentHash } = await prepare();
    const response = await harness.request({
      method: 'POST',
      path: `/knowledge/${document.knowledgeRef}/versions/${document.version}/review`,
      token,
      json: {
        decision: 'rejected',
        expected_hash: contentHash,
        reason: '证据不足',
        valid_from: '2026-01-01T00:00:00.000Z',
      },
    });
    expect(response.status).toBe(200);
    expect(response.body.data.review_status).toBe('rejected');
    expect(response.body.data.valid_from).toBeNull();
  });

  it('被驳回的知识不可检索，且不产生上游请求', async () => {
    const { kbId, document, contentHash } = await prepare();
    const review = await harness.request({
      method: 'POST',
      path: `/knowledge/${document.knowledgeRef}/versions/${document.version}/review`,
      token,
      json: {
        decision: 'rejected',
        expected_hash: contentHash,
        reason: '证据不足',
      },
    });
    expect(review.status).toBe(200);

    const before = harness.ragflow.calls.length;
    const retrieval = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M15', kb_ids: [kbId] },
    });
    expect(retrieval.status).toBe(200);
    expect(retrieval.body.data.status).toBe('no_match');
    expect(retrieval.body.data.evidence).toHaveLength(0);
    const upstreamCalls = harness.ragflow.calls.slice(before);
    expect(upstreamCalls.filter((call) => call.path === '/api/v1/retrieval')).toHaveLength(0);
  });

  it('有效期区间非法时拒绝审核', async () => {
    const { document, contentHash } = await prepare();
    const response = await harness.request({
      method: 'POST',
      path: `/knowledge/${document.knowledgeRef}/versions/${document.version}/review`,
      token,
      json: {
        decision: 'approved',
        expected_hash: contentHash,
        reason: '区间颠倒',
        valid_from: '2026-12-31T00:00:00.000Z',
        valid_until: '2026-01-01T00:00:00.000Z',
      },
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('CONTRACT_INVALID');
  });

  it('审核人权限齐备时可以独立于上传者完成审核', async () => {
    const { document, contentHash } = await prepare();
    const reviewerToken = await harness.token({
      subject: 'reviewer-1',
      permissions: REVIEWER_PERMISSIONS,
    });
    const response = await harness.request({
      method: 'POST',
      path: `/knowledge/${document.knowledgeRef}/versions/${document.version}/review`,
      token: reviewerToken,
      json: { decision: 'approved', expected_hash: contentHash, reason: '复核通过' },
    });
    expect(response.status).toBe(200);
    expect(response.body.data.reviewer).toBe('reviewer-1');
  });
});
