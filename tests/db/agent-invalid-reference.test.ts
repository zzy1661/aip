import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SkillRef } from '@aip/contracts';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { agentPayload, registerAgentRequest, registerSkillRequest } from '../helpers/fixtures.js';

/**
 * M07：无效引用。
 *
 * 断言口径：所有非法引用都在入库前被拒，错误码可区分，字段定位准确；
 * 失败的 Agent 注册不留下资产行或绑定半行；隐藏资产与不存在资源返回同样的错误。
 */
describe('M07 Agent 无效引用', () => {
  let harness: Harness;
  let token: string;
  let skillId: string;
  let agentId: string;
  let revokedSkillId: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm07' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });

    const skill = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm07-skill',
      json: registerSkillRequest({ slug: 'm07-skill' }),
    });
    skillId = skill.body.data.asset_id;

    const agent = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm07-agent',
      json: registerAgentRequest({
        slug: 'm07-agent',
        payload: agentPayload({ skill_refs: [{ asset_id: skillId, version: '1.0.0' }] }),
      }),
    });
    agentId = agent.body.data.asset_id;

    const revocable = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm07-revocable',
      json: registerSkillRequest({ slug: 'm07-revocable' }),
    });
    revokedSkillId = revocable.body.data.asset_id;
    const revoked = await harness.request({
      method: 'POST',
      path: `/assets/${revokedSkillId}/versions/1.0.0/status`,
      token,
      json: { status: 'revoked', expected_state_revision: 1, reason: 'M07 撤回' },
    });
    expect(revoked.status).toBe(200);
  });

  afterAll(async () => {
    await harness.close();
  });

  async function registerWithRefs(refs: unknown[], key: string) {
    return harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: key,
      json: registerAgentRequest({
        slug: `m07fail-${key}`,
        // 这里故意构造非法引用，类型上无法收敛，因此显式断言为 SkillRef[]。
        payload: agentPayload({ skill_refs: refs as SkillRef[] }),
      }),
    });
  }

  it('缺少版本字段被拒，定位到具体字段', async () => {
    const response = await registerWithRefs([{ asset_id: skillId }], 'm07-missing-version');
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('CONTRACT_INVALID');
    expect(response.body.details[0].field_path).toContain('payload.skill_refs[0]');
  });

  it('latest / 1.0 / v1.0.0 都不是合法版本号', async () => {
    for (const version of ['latest', '1.0', 'v1.0.0', '^1.0.0']) {
      const response = await registerWithRefs(
        [{ asset_id: skillId, version }],
        `m07-bad-version-${version.replace(/\W/g, '')}`,
      );
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('CONTRACT_INVALID');
      expect(response.body.details[0].field_path).toContain('payload.skill_refs[0].version');
    }
  });

  it('不存在的版本返回 REF_NOT_AVAILABLE', async () => {
    const response = await registerWithRefs(
      [{ asset_id: skillId, version: '9.9.9' }],
      'm07-missing-version-target',
    );
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('REF_NOT_AVAILABLE');
  });

  it('Agent 不能当作 Skill 绑定', async () => {
    const response = await registerWithRefs(
      [{ asset_id: agentId, version: '1.0.0' }],
      'm07-agent-as-skill',
    );
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('REF_NOT_AVAILABLE');
  });

  it('已撤回的版本不能被绑定', async () => {
    const response = await registerWithRefs(
      [{ asset_id: revokedSkillId, version: '1.0.0' }],
      'm07-revoked-target',
    );
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('REF_NOT_AVAILABLE');
  });

  it('重复引用被拒', async () => {
    const response = await registerWithRefs(
      [
        { asset_id: skillId, version: '1.0.0' },
        { asset_id: skillId, version: '1.0.0' },
      ],
      'm07-duplicate',
    );
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('CONTRACT_INVALID');
    expect(response.body.details[0].field_path).toContain('payload.skill_refs[1]');
  });

  it('另一个项目的版本不可见，返回与不存在一致的错误', async () => {
    const other = await createHarness({ label: 'm07other', projectId: 'm07-other-project' });
    try {
      const otherToken = await other.token({ permissions: ALL_PERMISSIONS });
      const otherSkill = await other.request({
        method: 'POST',
        path: '/assets',
        token: otherToken,
        idempotencyKey: 'm07-other-skill',
        json: registerSkillRequest({ slug: 'm07-other-skill' }),
      });
      const crossScope = await registerWithRefs(
        [{ asset_id: otherSkill.body.data.asset_id, version: '1.0.0' }],
        'm07-cross-scope',
      );
      const missing = await registerWithRefs(
        [{ asset_id: '00000000-0000-4000-8000-000000000000', version: '1.0.0' }],
        'm07-nonexistent',
      );
      expect(crossScope.status).toBe(422);
      expect(crossScope.body.code).toBe(missing.body.code);
      expect(crossScope.body.message).toBe(missing.body.message);
    } finally {
      await other.close();
    }
  });

  it('失败的注册不留下资产行或绑定半行', async () => {
    const agents = await harness.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM asset
        WHERE scope_id = $1 AND type = 'Agent' AND slug LIKE 'm07fail-%'`,
      [harness.projectId],
    );
    expect(agents.rows[0]!.count).toBe('0');

    const bindings = await harness.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM agent_skill_binding WHERE scope_id = $1',
      [harness.projectId],
    );
    expect(bindings.rows[0]!.count).toBe('1');

    const revisions = await harness.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM asset_revision r
         JOIN asset a ON a.scope_id = r.scope_id AND a.id = r.asset_id
        WHERE r.scope_id = $1 AND a.slug LIKE 'm07fail-%'`,
      [harness.projectId],
    );
    expect(revisions.rows[0]!.count).toBe('0');
  });
});
