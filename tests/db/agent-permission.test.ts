import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { agentPayload, registerAgentRequest, registerSkillRequest } from '../helpers/fixtures.js';

/**
 * M08：Agent 权限与配置安全。
 *
 * 断言口径：请求超出持有权限被拒；配置里的密钥/URL 被拒；
 * execution_enabled 只接受 false；失败时秘密不落库；注册不产生执行任务；
 * 运行端点不存在。
 */
describe('M08 Agent 权限与配置', () => {
  let harness: Harness;
  let adminToken: string;
  let writerToken: string;
  let skillId: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm08' });
    adminToken = await harness.token({ permissions: ALL_PERMISSIONS });
    writerToken = await harness.token({ permissions: ['asset:write'] });

    const skill = await harness.request({
      method: 'POST',
      path: '/assets',
      token: adminToken,
      idempotencyKey: 'm08-skill',
      json: registerSkillRequest({ slug: 'm08-skill' }),
    });
    skillId = skill.body.data.asset_id;
  });

  afterAll(async () => {
    await harness.close();
  });

  it('只有 asset:write 的主体不能注册带绑定的 Agent', async () => {
    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token: writerToken,
      idempotencyKey: 'm08-bind-permission',
      json: registerAgentRequest({
        slug: 'm08-agent-no-bind',
        payload: agentPayload({ skill_refs: [{ asset_id: skillId, version: '1.0.0' }] }),
      }),
    });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
    expect(response.body.details[0].reason).toContain('asset:bind');
  });

  it('有 asset:bind 但没有 asset:read 同样不能绑定', async () => {
    const token = await harness.token({ permissions: ['asset:write', 'asset:bind'] });
    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm08-bind-permission-2',
      json: registerAgentRequest({
        slug: 'm08-agent-no-read',
        payload: agentPayload({ skill_refs: [{ asset_id: skillId, version: '1.0.0' }] }),
      }),
    });
    expect(response.status).toBe(403);
    expect(response.body.details[0].reason).toContain('asset:read');
  });

  it('请求不可下放的权限被拒', async () => {
    const token = await harness.token({ permissions: ['asset:write', 'asset:bind', 'asset:read'] });
    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm08-escalation',
      json: registerAgentRequest({
        slug: 'm08-agent-escalation',
        payload: agentPayload({
          skill_refs: [{ asset_id: skillId, version: '1.0.0' }],
          requested_permissions: ['asset:manage'],
        }),
      }),
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('CONTRACT_INVALID');
    expect(response.body.details[0].field_path).toContain('requested_permissions');
  });

  it('请求自己并未持有的可下放权限被拒', async () => {
    const token = await harness.token({ permissions: ['asset:write', 'asset:bind', 'asset:read'] });
    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm08-escalation-2',
      json: registerAgentRequest({
        slug: 'm08-agent-escalation-2',
        payload: agentPayload({
          skill_refs: [{ asset_id: skillId, version: '1.0.0' }],
          requested_permissions: ['source:read'],
        }),
      }),
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('PERMISSION_ESCALATION');
    expect(response.body.details[0].field_path).toContain('requested_permissions');
  });

  it('配置里的密钥与 URL 被拒', async () => {
    const secret = 'super-secret-value-should-never-persist';

    const withKey = await harness.request({
      method: 'POST',
      path: '/assets',
      token: adminToken,
      idempotencyKey: 'm08-config-key',
      json: registerAgentRequest({
        slug: 'm08-agent-config-key',
        payload: agentPayload({
          skill_refs: [{ asset_id: skillId, version: '1.0.0' }],
          config: { api_key: secret },
        }),
      }),
    });
    expect(withKey.status).toBe(422);
    expect(withKey.body.code).toBe('CONTRACT_INVALID');
    expect(withKey.body.details[0].field_path).toContain('config.api_key');

    const withUrl = await harness.request({
      method: 'POST',
      path: '/assets',
      token: adminToken,
      idempotencyKey: 'm08-config-url',
      json: registerAgentRequest({
        slug: 'm08-agent-config-url',
        payload: agentPayload({
          skill_refs: [{ asset_id: skillId, version: '1.0.0' }],
          config: { upstream: 'https://example.invalid/hook' },
        }),
      }),
    });
    expect(withUrl.status).toBe(422);
    expect(withUrl.body.code).toBe('CONTRACT_INVALID');

    const nested = await harness.request({
      method: 'POST',
      path: '/assets',
      token: adminToken,
      idempotencyKey: 'm08-config-nested',
      json: registerAgentRequest({
        slug: 'm08-agent-config-nested',
        payload: agentPayload({
          skill_refs: [{ asset_id: skillId, version: '1.0.0' }],
          config: { nested: { password: secret } },
        }),
      }),
    });
    expect(nested.status).toBe(422);
    expect(nested.body.code).toBe('CONTRACT_INVALID');

    // 秘密没有落库。
    const stored = await harness.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM asset_revision
        WHERE scope_id = $1 AND payload::text LIKE $2`,
      [harness.projectId, `%${secret}%`],
    );
    expect(stored.rows[0]!.count).toBe('0');
  });

  it('execution_enabled 必须为 false', async () => {
    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token: adminToken,
      idempotencyKey: 'm08-execution-enabled',
      json: registerAgentRequest({
        slug: 'm08-agent-exec',
        payload: agentPayload({
          skill_refs: [{ asset_id: skillId, version: '1.0.0' }],
          execution_enabled: true,
        }),
      }),
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('CONTRACT_INVALID');
    expect(response.body.details[0].field_path).toContain('execution_enabled');
  });

  it('注册 Agent 不产生任何执行任务', async () => {
    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token: adminToken,
      idempotencyKey: 'm08-register-clean',
      json: registerAgentRequest({
        slug: 'm08-agent-clean',
        payload: agentPayload({ skill_refs: [{ asset_id: skillId, version: '1.0.0' }] }),
      }),
    });
    expect(response.status).toBe(201);

    const operations = await harness.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM operation WHERE scope_id = $1',
      [harness.projectId],
    );
    expect(operations.rows[0]!.count).toBe('0');
  });

  it('不存在 Agent 运行端点', async () => {
    const response = await harness.request({
      method: 'POST',
      path: `/assets/${skillId}/run`,
      token: adminToken,
      json: { input: 'hello' },
    });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });
});
