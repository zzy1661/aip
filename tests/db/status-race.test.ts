import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { agentPayload, registerAgentRequest, registerSkillRequest } from '../helpers/fixtures.js';

/**
 * M09：注册与撤回的竞态。
 *
 * 断言口径：注册与撤回在同一个版本行上线性化；
 * 撤回后既有 Agent 的绑定被标记为失效，但精确旧配置仍可读；
 * 新的绑定被拒；用旧 state_revision 改状态返回 409。
 */
describe('M09 注册与撤回竞态', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm09' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('并发注册与撤回的结果保持一致，不会同时出现「有效引用已撤回版本」', async () => {
    const skill = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm09-skill',
      json: registerSkillRequest({ slug: 'm09-race-skill' }),
    });
    expect(skill.status).toBe(201);
    const skillId = skill.body.data.asset_id;

    const [registerResponse, revokeResponse] = await Promise.all([
      harness.request({
        method: 'POST',
        path: '/assets',
        token,
        idempotencyKey: 'm09-race-agent',
        json: registerAgentRequest({
          slug: 'm09-race-agent',
          payload: agentPayload({ skill_refs: [{ asset_id: skillId, version: '1.0.0' }] }),
        }),
      }),
      harness.request({
        method: 'POST',
        path: `/assets/${skillId}/versions/1.0.0/status`,
        token,
        json: { status: 'revoked', expected_state_revision: 1, reason: 'M09 竞态撤回' },
      }),
    ]);

    expect([201, 422]).toContain(registerResponse.status);
    expect(revokeResponse.status).toBe(200);

    if (registerResponse.status === 201) {
      // 注册先提交：撤回后绑定必须被标记为失效。
      const detail = await harness.request({
        method: 'GET',
        path: `/assets/${registerResponse.body.data.asset_id}/versions/1.0.0`,
        token,
      });
      expect(detail.body.data.bindings[0].binding_valid).toBe(false);
      // 精确旧配置仍可读。
      expect(detail.body.data.payload.skill_refs).toEqual([
        { asset_id: skillId, version: '1.0.0' },
      ]);
    } else {
      // 撤回先提交：引用失败，且不留半行。
      expect(registerResponse.body.code).toBe('REF_NOT_AVAILABLE');
      const agents = await harness.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM asset
          WHERE scope_id = $1 AND slug = 'm09-race-agent'`,
        [harness.projectId],
      );
      expect(agents.rows[0]!.count).toBe('0');
    }
  });

  it('撤回后新的绑定被拒', async () => {
    const skill = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm09-skill-2',
      json: registerSkillRequest({ slug: 'm09-revoked-skill' }),
    });
    const skillId = skill.body.data.asset_id;
    await harness.request({
      method: 'POST',
      path: `/assets/${skillId}/versions/1.0.0/status`,
      token,
      json: { status: 'revoked', expected_state_revision: 1, reason: 'M09 撤回' },
    });

    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm09-agent-after-revoke',
      json: registerAgentRequest({
        slug: 'm09-agent-after-revoke',
        payload: agentPayload({ skill_refs: [{ asset_id: skillId, version: '1.0.0' }] }),
      }),
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('REF_NOT_AVAILABLE');
  });

  it('用旧的 state_revision 改状态返回 409', async () => {
    const skill = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm09-skill-3',
      json: registerSkillRequest({ slug: 'm09-revision-skill' }),
    });
    const skillId = skill.body.data.asset_id;

    const first = await harness.request({
      method: 'POST',
      path: `/assets/${skillId}/versions/1.0.0/status`,
      token,
      json: { status: 'deprecated', expected_state_revision: 1, reason: 'M09 第一次' },
    });
    expect(first.status).toBe(200);
    expect(first.body.data.state_revision).toBe(2);

    const stale = await harness.request({
      method: 'POST',
      path: `/assets/${skillId}/versions/1.0.0/status`,
      token,
      json: { status: 'revoked', expected_state_revision: 1, reason: 'M09 旧版本号' },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STATE_CONFLICT');
  });

  it('revoked 是终态，不能恢复为 registered', async () => {
    const skill = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm09-skill-4',
      json: registerSkillRequest({ slug: 'm09-terminal-skill' }),
    });
    const skillId = skill.body.data.asset_id;
    const revoked = await harness.request({
      method: 'POST',
      path: `/assets/${skillId}/versions/1.0.0/status`,
      token,
      json: { status: 'revoked', expected_state_revision: 1, reason: 'M09 终态' },
    });
    expect(revoked.status).toBe(200);

    // 接口只允许 deprecated / revoked，且触发器禁止 registered 恢复。
    const restore = await harness.request({
      method: 'POST',
      path: `/assets/${skillId}/versions/1.0.0/status`,
      token,
      json: { status: 'deprecated', expected_state_revision: 2, reason: 'M09 试图恢复' },
    });
    expect(restore.status).toBe(409);

    const rows = await harness.pool.query<{ registration_status: string }>(
      `SELECT registration_status FROM asset_revision
        WHERE scope_id = $1 AND asset_id = $2`,
      [harness.projectId, skillId],
    );
    expect(rows.rows[0]!.registration_status).toBe('revoked');
  });
});
