import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { TEST_DATABASE_URL } from '../helpers/db.js';
import { agentPayload, registerAgentRequest, registerSkillRequest } from '../helpers/fixtures.js';

const { Pool: PgPool } = pg;

/**
 * M09：注册与撤回的**确定性提交顺序**。
 *
 * 既有用例（`tests/db/status-race.test.ts`）用 `Promise.all` 并发发起，
 * 证明的是「并发提交后旧修订号被拒」，**没有**证明「两种提交顺序各自成立」。
 * 本文件用**数据库层的确定性门闩**把提交顺序钉死，两种顺序各构造一次：
 *
 * - 门闩不是靠调度运气：它由测试自己持有的数据库连接施加，
 *   并用 `pg_stat_activity` **确认**被测请求真的卡在了预期的那一步
 *   （卡住这件事本身就是断言，机制失效时用例立刻变红）。
 * - 门闩选在「只有一方需要的那张表」上，因此另一方要么被挡、要么不受影响，
 *   顺序由门闩决定，而不是由谁先跑到��决定。
 *
 * 两种顺序的断言口径一致：
 * 最终状态是 `revoked`、`state_revision` 单调递增到 2、
 * 撤回之后新的绑定被拒（`REF_NOT_AVAILABLE`）、
 * 被拒的那一侧**不留半截状态**。
 */
describe('M09 注册与撤回的确定性提交顺序', () => {
  let harness: Harness;
  let token: string;
  /** 门闩专用连接：与应用角色分开，application_name 也分开，便于在 `pg_stat_activity` 里认人。 */
  let gatePool: pg.Pool;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm09lin' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
    gatePool = new PgPool({
      connectionString: TEST_DATABASE_URL,
      application_name: `${harness.db.schema}_gate`,
      max: 2,
      options: `-c search_path=${harness.db.schema}`,
    });
  });

  afterAll(async () => {
    await gatePool?.end();
    await harness?.close();
  });

  interface BlockedBackend {
    pid: number;
    wait_event: string | null;
    query: string;
  }

  /**
   * 等一个真的卡在锁上的后端出现。
   *
   * 只看 `wait_event_type = 'Lock'` 的活跃后端：卡住这件事本身就是证据，
   * 因此门闩失效（请求没卡住）时这里会超时返回 null，断言随即变红。
   */
  async function waitForBlockedBackend(
    fragments: string[],
    timeoutMs = 20_000,
  ): Promise<BlockedBackend | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { rows } = await harness.pool.query<BlockedBackend>(
        `SELECT pid, wait_event, query
           FROM pg_stat_activity
          WHERE application_name = $1
            AND state = 'active'
            AND wait_event_type = 'Lock'`,
        [harness.db.schema],
      );
      const hit = rows.find((row) => fragments.every((part) => row.query.includes(part)));
      if (hit) return hit;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return null;
  }

  /** 取 Skill 版本行的最终状态。 */
  async function readSkillRow(skillId: string): Promise<{
    registration_status: string;
    state_revision: number;
  }> {
    const { rows } = await harness.pool.query<{
      registration_status: string;
      state_revision: number;
    }>(
      `SELECT registration_status, state_revision
         FROM asset_revision
        WHERE scope_id = $1 AND asset_id = $2 AND version = '1.0.0'`,
      [harness.projectId, skillId],
    );
    return rows[0]!;
  }

  it('注册提交在前、撤回提交在后：撤回成功，注册留下的绑定按语义失效', async () => {
    const suffix = Date.now().toString(36);
    const skill = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: `m09lin-skill-a-${suffix}`,
      json: registerSkillRequest({ slug: `m09lin-skill-a-${suffix}` }),
    });
    expect(skill.status).toBe(201);
    const skillId = skill.body.data.asset_id as string;
    const agentSlug = `m09lin-agent-a-${suffix}`;

    const gate = await gatePool.connect();
    try {
      await gate.query('BEGIN');
      // 门闩：只锁「写绑定」那一张表。注册在解析引用（已经拿到 Skill 版本行的行锁）
      // 之后才写绑定，因此它会卡在这一步——**同时它已经持有了那把行锁**。
      // 撤回不碰这张表：它接下来会卡在 Skill 版本行的行锁上，等注册先提交。
      await gate.query('LOCK TABLE agent_skill_binding IN ACCESS EXCLUSIVE MODE');

      const registerPromise = harness.request({
        method: 'POST',
        path: '/assets',
        token,
        idempotencyKey: `m09lin-agent-a-${suffix}`,
        json: registerAgentRequest({
          slug: agentSlug,
          payload: agentPayload({ skill_refs: [{ asset_id: skillId, version: '1.0.0' }] }),
        }),
      });

      // 注册真的卡住了（卡在写绑定这一步）。
      const blockedRegister = await waitForBlockedBackend(['agent_skill_binding']);
      expect(
        blockedRegister,
        '注册必须被门闩挡在写绑定这一步（卡住是门闩生效的证据）',
      ).not.toBeNull();

      const revokePromise = harness.request({
        method: 'POST',
        path: `/assets/${skillId}/versions/1.0.0/status`,
        token,
        json: { status: 'revoked', expected_state_revision: 1, reason: 'M09 线性化：撤回在后' },
      });

      // 撤回真的卡住了（卡在 Skill 版本行的行锁上，锁由注册持有着）。
      const blockedRevoke = await waitForBlockedBackend(['asset_revision', 'UPDATE']);
      expect(blockedRevoke, '撤回必须等注册的提交（卡住是顺序成立的证据）').not.toBeNull();

      // 放行：注册先提交，撤回后提交。
      await gate.query('COMMIT');

      const [registerResponse, revokeResponse] = await Promise.all([
        registerPromise,
        revokePromise,
      ]);

      expect(registerResponse.status).toBe(201);
      expect(revokeResponse.status).toBe(200);
      expect(revokeResponse.body.data.registration_status).toBe('revoked');
      expect(revokeResponse.body.data.state_revision).toBe(2);

      // 最终状态与 state_revision 单调。
      const skillRow = await readSkillRow(skillId);
      expect(skillRow.registration_status).toBe('revoked');
      expect(skillRow.state_revision).toBe(2);

      // 注册可见性符合语义：绑定被标记为失效，但精确旧配置仍可读。
      const detail = await harness.request({
        method: 'GET',
        path: `/assets/${registerResponse.body.data.asset_id}/versions/1.0.0`,
        token,
      });
      expect(detail.body.data.bindings).toHaveLength(1);
      expect(detail.body.data.bindings[0].binding_valid).toBe(false);
      expect(detail.body.data.payload.skill_refs).toEqual([
        { asset_id: skillId, version: '1.0.0' },
      ]);

      // 撤回之后的新绑定被拒。
      const afterRevoke = await harness.request({
        method: 'POST',
        path: '/assets',
        token,
        idempotencyKey: `m09lin-agent-after-a-${suffix}`,
        json: registerAgentRequest({
          slug: `m09lin-agent-after-a-${suffix}`,
          payload: agentPayload({ skill_refs: [{ asset_id: skillId, version: '1.0.0' }] }),
        }),
      });
      expect(afterRevoke.status).toBe(422);
      expect(afterRevoke.body.code).toBe('REF_NOT_AVAILABLE');
    } finally {
      await gate.query('ROLLBACK').catch(() => undefined);
      gate.release();
    }
  });

  it('撤回提交在前、注册提交在后：后提交被拒，且不留半截状态', async () => {
    const suffix = Date.now().toString(36);
    const skill = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: `m09lin-skill-b-${suffix}`,
      json: registerSkillRequest({ slug: `m09lin-skill-b-${suffix}` }),
    });
    expect(skill.status).toBe(201);
    const skillId = skill.body.data.asset_id as string;
    const agentSlug = `m09lin-agent-b-${suffix}`;

    const gate = await gatePool.connect();
    try {
      await gate.query('BEGIN');
      // 门闩：只锁「写 asset 表」这一张表。注册第一步就是 INSERT INTO asset，
      // 因此它在这里被挡住——**还没走到解析引用**，也就还没碰过 Skill 版本行。
      // 撤回只读 asset（ACCESS SHARE，与 SHARE 兼容）并只写 asset_revision，
      // 因此它完全不受门闩影响，可以一路走完并先提交。
      await gate.query('LOCK TABLE asset IN SHARE MODE');

      const registerPromise = harness.request({
        method: 'POST',
        path: '/assets',
        token,
        idempotencyKey: `m09lin-agent-b-${suffix}`,
        json: registerAgentRequest({
          slug: agentSlug,
          payload: agentPayload({ skill_refs: [{ asset_id: skillId, version: '1.0.0' }] }),
        }),
      });

      // 注册真的卡住了（卡在写 asset 这一步）。
      const blockedRegister = await waitForBlockedBackend(['INSERT INTO asset']);
      expect(
        blockedRegister,
        '注册必须被门闩挡在写 asset 这一步（卡住是门闩生效的证据）',
      ).not.toBeNull();

      // 撤回此刻不受门闩影响：它先提交。
      const revokeResponse = await harness.request({
        method: 'POST',
        path: `/assets/${skillId}/versions/1.0.0/status`,
        token,
        json: { status: 'revoked', expected_state_revision: 1, reason: 'M09 线性化：撤回在前' },
      });
      expect(revokeResponse.status).toBe(200);
      expect(revokeResponse.body.data.registration_status).toBe('revoked');
      expect(revokeResponse.body.data.state_revision).toBe(2);

      // 放行：注册随后才拿到锁，此时它看到的已经是 revoked。
      await gate.query('COMMIT');

      const registerResponse = await registerPromise;
      expect(registerResponse.status).toBe(422);
      expect(registerResponse.body.code).toBe('REF_NOT_AVAILABLE');

      // 不产生半截状态：被拒的注册连一行都不该留下。
      const assets = await harness.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM asset WHERE scope_id = $1 AND slug = $2`,
        [harness.projectId, agentSlug],
      );
      expect(assets.rows[0]!.count).toBe('0');
      const revisions = await harness.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM asset_revision r
           JOIN asset a ON a.scope_id = r.scope_id AND a.id = r.asset_id
          WHERE r.scope_id = $1 AND a.slug = $2`,
        [harness.projectId, agentSlug],
      );
      expect(revisions.rows[0]!.count).toBe('0');

      // 最终状态与 state_revision 单调。
      const skillRow = await readSkillRow(skillId);
      expect(skillRow.registration_status).toBe('revoked');
      expect(skillRow.state_revision).toBe(2);

      // 撤回之后的新绑定被拒。
      const afterRevoke = await harness.request({
        method: 'POST',
        path: '/assets',
        token,
        idempotencyKey: `m09lin-agent-after-b-${suffix}`,
        json: registerAgentRequest({
          slug: `m09lin-agent-after-b-${suffix}`,
          payload: agentPayload({ skill_refs: [{ asset_id: skillId, version: '1.0.0' }] }),
        }),
      });
      expect(afterRevoke.status).toBe(422);
      expect(afterRevoke.body.code).toBe('REF_NOT_AVAILABLE');
    } finally {
      await gate.query('ROLLBACK').catch(() => undefined);
      gate.release();
    }
  });
});
