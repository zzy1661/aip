import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SkillPayload } from '@aip/contracts';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { registerSkillRequest, skillPayload, uniqueSlug } from '../helpers/fixtures.js';

/**
 * M28：审计主体取自可信身份，且日志不承载敏感信息。
 *
 * 断言口径：
 * - 审计事件的 subject 必须来自令牌主体，请求体不能自带 actor / created_by；
 * - 未预期异常必须留痕，但日志里不得出现上游密钥、数据库连接串等敏感内容。
 */
describe('M28 审计主体与日志卫生', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm28audit' });
    token = await harness.token({ subject: 'audit-user', permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('审计事件的主体来自令牌，而不是请求体', async () => {
    const registered = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm28-audit-subject',
      json: registerSkillRequest({ slug: uniqueSlug('m28audit') }),
    });
    expect(registered.status).toBe(201);
    const assetId = registered.body.data.asset_id as string;

    const { rows } = await harness.pool.query<{
      subject: string;
      actor_source: string;
      operation: string;
      resource_ref: string;
    }>(
      `SELECT subject, actor_source, operation, resource_ref
         FROM audit_event
        WHERE scope_id = $1 AND operation = 'assets.register'
        ORDER BY created_at DESC LIMIT 1`,
      [harness.projectId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subject).toBe('audit-user');
    expect(rows[0]!.actor_source).toBe('principal');
    expect(rows[0]!.resource_ref).toContain(assetId);
  });

  it('请求体自带 actor 字段被拒绝', async () => {
    const auditsBefore = await countAudits(harness);
    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm28-audit-actor',
      json: { ...registerSkillRequest({ slug: uniqueSlug('m28actor') }), actor: 'someone-else' },
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('CONTRACT_INVALID');
    // Ajv 的 additionalProperties 错误不携带字段名，定位粒度只到请求体一级。
    const paths = (response.body.details as Array<{ field_path: string }>).map(
      (detail) => detail.field_path,
    );
    expect(paths).toContain('body');
    // 被拒的请求不得留下资产或审计记录，伪造的主体也就无从生效。
    expect(await countAudits(harness)).toBe(auditsBefore);
  });

  it('payload 自带 created_by 字段被拒绝', async () => {
    const auditsBefore = await countAudits(harness);
    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm28-audit-created-by',
      json: registerSkillRequest({
        slug: uniqueSlug('m28createdby'),
        payload: skillPayload({
          created_by: 'someone-else',
        } as unknown as Partial<SkillPayload>),
      }),
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('CONTRACT_INVALID');
    const paths = (response.body.details as Array<{ field_path: string }>).map(
      (detail) => detail.field_path,
    );
    expect(paths).toContain('payload');
    expect(await countAudits(harness)).toBe(auditsBefore);
  });

  it('未预期异常留痕，且日志不含敏感内容', async () => {
    // 单独建一个 harness：这里要让真实查询失败，制造未预期的内部错误路径。
    const broken = await createHarness({ label: 'm28log' });
    const brokenToken = await broken.token({ permissions: ALL_PERMISSIONS });
    try {
      // 把资产表改名，让列表查询在数据库层失败（错误码不在平台映射表内，落成 500）。
      await broken.pool.query('ALTER TABLE asset RENAME TO asset_hidden');

      const response = await broken.request({
        method: 'GET',
        path: '/assets',
        token: brokenToken,
      });
      expect(response.status).toBe(500);
      expect(response.body.code).toBe('INTERNAL_ERROR');

      // 内部错误必须留痕，否则 500 无法定位。
      expect(broken.logs.length).toBeGreaterThan(0);
      const dump = JSON.stringify(broken.logs);
      expect(dump).not.toContain('aip-test-only-hs256-secret');
      expect(dump).not.toContain('postgres://');
      expect(dump).not.toContain('test-api-key');
      // 响应体不回显内部信息。
      expect(response.text).not.toContain('asset_hidden');

      await broken.pool.query('ALTER TABLE asset_hidden RENAME TO asset');
    } finally {
      await broken.close();
    }
  });
});

async function countAudits(harness: Harness): Promise<number> {
  const { rows } = await harness.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit_event WHERE scope_id = $1`,
    [harness.projectId],
  );
  return Number(rows[0]?.count ?? '0');
}
