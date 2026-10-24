import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import {
  agentPayload,
  registerAgentRequest,
  registerSkillRequest,
  skillPayload,
} from '../helpers/fixtures.js';

/**
 * M06：Agent 绑定精确版本。
 *
 * 断言口径：绑定的是 asset_id@version 的具体版本；上游出现新版本不改变既有绑定；
 * 绑定两端在库里都有外键；详情展示准确的版本与哈希，不追随最新。
 */
describe('M06 Agent 绑定版本', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm06' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('Agent 精确绑定 Skill@1.0.0，出现 1.0.1 后绑定不变', async () => {
    const skill = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm06-skill-1',
      json: registerSkillRequest({ slug: 'm06-skill', version: '1.0.0' }),
    });
    expect(skill.status).toBe(201);

    const agent = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm06-agent-1',
      json: registerAgentRequest({
        slug: 'm06-agent',
        version: '1.0.0',
        payload: agentPayload({
          skill_refs: [{ asset_id: skill.body.data.asset_id, version: '1.0.0' }],
        }),
      }),
    });
    expect(agent.status).toBe(201);

    // 上游新增 1.0.1。
    const nextVersion = await harness.request({
      method: 'POST',
      path: `/assets/${skill.body.data.asset_id}/versions`,
      token,
      idempotencyKey: 'm06-skill-2',
      json: {
        version: '1.0.1',
        title: 'M06 技能 1.0.1',
        description: '',
        payload: skillPayload(),
      },
    });
    expect(nextVersion.status).toBe(201);

    const detail = await harness.request({
      method: 'GET',
      path: `/assets/${agent.body.data.asset_id}/versions/1.0.0`,
      token,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.data.bindings).toHaveLength(1);
    expect(detail.body.data.bindings[0].skill_id).toBe(skill.body.data.asset_id);
    expect(detail.body.data.bindings[0].skill_version).toBe('1.0.0');
    expect(detail.body.data.bindings[0].binding_valid).toBe(true);
    expect(detail.body.data.payload.skill_refs).toEqual([
      { asset_id: skill.body.data.asset_id, version: '1.0.0' },
    ]);
  });

  it('依赖详情显示准确版本与哈希，且不追随最新版本', async () => {
    const skill = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm06-hash-skill-1',
      json: registerSkillRequest({ slug: 'm06-hash-skill', version: '1.0.0' }),
    });
    expect(skill.status).toBe(201);

    const agent = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm06-hash-agent-1',
      json: registerAgentRequest({
        slug: 'm06-hash-agent',
        version: '1.0.0',
        payload: agentPayload({
          skill_refs: [{ asset_id: skill.body.data.asset_id, version: '1.0.0' }],
        }),
      }),
    });
    expect(agent.status).toBe(201);

    const next = await harness.request({
      method: 'POST',
      path: `/assets/${skill.body.data.asset_id}/versions`,
      token,
      idempotencyKey: 'm06-hash-skill-2',
      json: {
        version: '1.0.1',
        title: 'M06 哈希技能 1.0.1',
        description: '',
        payload: skillPayload(),
      },
    });
    expect(next.status).toBe(201);

    const detail = await harness.request({
      method: 'GET',
      path: `/assets/${agent.body.data.asset_id}/versions/1.0.0`,
      token,
    });
    expect(detail.status).toBe(200);
    const binding = detail.body.data.bindings[0];
    expect(binding.skill_version).toBe('1.0.0');
    // 哈希必须是 1.0.0 这一版本的事实，而不是最新版本的哈希。
    expect(binding.skill_content_hash).toBe(skill.body.data.content_hash);
    expect(binding.skill_content_hash).not.toBe(next.body.data.content_hash);
  });

  it('绑定两端在库里都有外键约束', async () => {
    const foreignKeys = await harness.pool.query<{ conname: string; pg_get_constraintdef: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS pg_get_constraintdef
         FROM pg_constraint
        WHERE conrelid = 'agent_skill_binding'::regclass AND contype = 'f'`,
    );
    expect(foreignKeys.rows.length).toBeGreaterThanOrEqual(2);
    for (const row of foreignKeys.rows) {
      expect(row.pg_get_constraintdef).toContain('FOREIGN KEY');
    }
  });

  it('绑定行只记录被绑定的那个版本', async () => {
    const rows = await harness.pool.query<{ skill_version: string; count: string }>(
      `SELECT skill_version, count(*)::text AS count FROM agent_skill_binding
        WHERE scope_id = $1 GROUP BY skill_version`,
      [harness.projectId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.skill_version).toBe('1.0.0');
  });
});
