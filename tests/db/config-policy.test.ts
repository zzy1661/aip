import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { agentPayload, registerAgentRequest, registerSkillRequest } from '../helpers/fixtures.js';

/**
 * M-4 与 S-高-1 / S-中-2 / S-低-2：Agent config 的准入策略。
 *
 * 断言口径（双向）：
 * - 合法配置不能被误杀：`max_tokens`、`redirect`、`command_timeout` 必须放行；
 * - 承载密钥的键名、密钥形似值、地址形似值必须被拒且不落库；
 * - 详情接口不回显密钥。
 */
describe('M-4 Agent config 准入策略', () => {
  let harness: Harness;
  let token: string;
  let skillId: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'cfgpolicy' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
    const skill = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'cfg-skill',
      json: registerSkillRequest({ slug: 'cfg-skill' }),
    });
    skillId = skill.body.data.asset_id as string;
  });

  afterAll(async () => {
    await harness.close();
  });

  async function registerWithConfig(
    slug: string,
    config: Record<string, unknown>,
  ): Promise<{ status: number; body: any }> {
    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: `cfg-${slug}`,
      json: registerAgentRequest({
        slug,
        payload: agentPayload({
          skill_refs: [{ asset_id: skillId, version: '1.0.0' }],
          config,
        }),
      }),
    });
    return { status: response.status, body: response.body };
  }

  it.each([
    ['maxtokens', { max_tokens: 4096 }],
    ['redirect', { redirect: 'x' }],
    ['commandtimeout', { command_timeout: 30 }],
    ['executionpolicy', { execution_policy: 'strict' }],
    ['monkey', { monkey: 'banana' }],
    ['sortkey', { sort_key: 'created_at' }],
  ])('合法配置 %s 被接受', async (slug, config) => {
    const result = await registerWithConfig(`cfg-ok-${slug}`, config);
    expect(result.status).toBe(201);
  });

  it.each([
    ['privatekey', { private_key: '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----' }],
    ['sessionkey', { session_key: 'session-value' }],
    ['authorization', { authorization: 'Bearer abc.def.ghi' }],
    ['clientsecret', { clientSecret: 'value' }],
    ['signingkey', { signing_key: 'value' }],
    ['apikey', { api_key: 'value' }],
    ['nestedpassword', { nested: { password: 'value' } }],
  ])('承载密钥的键 %s 被拒', async (slug, config) => {
    const result = await registerWithConfig(`cfg-bad-${slug}`, config);
    expect(result.status).toBe(422);
    expect(result.body.code).toBe('CONTRACT_INVALID');
  });

  it('承载密钥的键不会落库', async () => {
    const secret = 'never-persist-this-secret-value';
    const result = await registerWithConfig('cfg-secret-value', { api_key: secret });
    expect(result.status).toBe(422);

    const stored = await harness.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM asset_revision
        WHERE scope_id = $1 AND payload::text LIKE $2`,
      [harness.projectId, `%${secret}%`],
    );
    expect(stored.rows[0]!.count).toBe('0');
  });

  it.each([
    ['leading-space-url', ' https://evil.example/hook'],
    ['protocol-relative', '//evil.example/hook'],
    ['bare-host', 'example.com/x'],
    ['data-url', 'data:text/html,<script>alert(1)</script>'],
    ['mailto', 'mailto:a@b.example'],
    ['https-url', 'https://example.invalid/hook'],
  ])('地址形似值 %s 被拒', async (slug, value) => {
    const result = await registerWithConfig(`cfg-url-${slug}`, { target: value });
    expect(result.status).toBe(422);
    expect(result.body.code).toBe('CONTRACT_INVALID');
  });

  it.each([
    ['pem', '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----'],
    ['sk-prefix', 'sk-abcdefghijklmnopqrstuvwx'],
    ['ghp-prefix', 'ghp_abcdefghijklmnopqrstuvwxyz0123'],
    ['bearer', 'Bearer abcdefghijklmnop'],
  ])('密钥形似值 %s 被拒', async (slug, value) => {
    const result = await registerWithConfig(`cfg-secretlike-${slug}`, { note: value });
    expect(result.status).toBe(422);
  });

  it('model_profile_ref 不得承载地址', async () => {
    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'cfg-model-profile-ref',
      json: registerAgentRequest({
        slug: 'cfg-model-profile-ref',
        payload: agentPayload({
          skill_refs: [{ asset_id: skillId, version: '1.0.0' }],
          model_profile_ref: 'https://models.example.invalid/v1',
        }),
      }),
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('CONTRACT_INVALID');
  });

  it('详情接口不回显密钥', async () => {
    // 版本事实本身不可改写（见 revision-immutability 用例），
    // 因此这里直接插入一行绕过写入路径的记录，验证详情接口的兜底脱敏。
    const assetId = randomUUID();
    await harness.pool.query(
      `INSERT INTO asset (scope_id, id, type, slug, owner)
       VALUES ($1, $2, 'Agent', 'cfg-redaction-direct', 'user-1')`,
      [harness.projectId, assetId],
    );
    await harness.pool.query(
      `INSERT INTO asset_revision
         (scope_id, asset_id, version, title, description, payload, content_hash,
          schema_version, registration_status, created_by)
       VALUES ($1, $2, '1.0.0', '直写标题', '', $3::jsonb, 'hash-direct', 1,
               'registered', 'user-1')`,
      [
        harness.projectId,
        assetId,
        JSON.stringify({
          instructions: '直写记录的指令。',
          skill_refs: [{ asset_id: skillId, version: '1.0.0' }],
          model_profile_ref: 'default-model-profile',
          requested_permissions: [],
          config: { max_tokens: 4096, api_key: 'leaked-secret-value' },
          execution_enabled: false,
        }),
      ],
    );

    const detail = await harness.request({
      method: 'GET',
      path: `/assets/${assetId}/versions/1.0.0`,
      token,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.data.payload.config.api_key).toBe('[REDACTED]');
    expect(detail.body.data.payload.config.max_tokens).toBe(4096);
    expect(detail.text).not.toContain('leaked-secret-value');
  });
});
