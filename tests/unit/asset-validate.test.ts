import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { registerSkillRequest, skillPayload } from '../helpers/fixtures.js';

/**
 * M25 / 契约一致性：只校验端点的语义。
 *
 * 断言口径：这个端点的语义是「把所有问题一次性列出来」，所以
 * - 信封层错误也进问题列表，仍然返回 200；
 * - `passed` 只有在问题列表为空时才是 true；
 * - 它不写任何注册记录。
 */
describe('M25 只校验端点 /assets/validate', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm25-validate' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('合法请求返回 passed=true 且不写入任何注册记录', async () => {
    const response = await harness.request({
      method: 'POST',
      path: '/assets/validate',
      token,
      json: registerSkillRequest({ slug: 'm25-validate-ok' }),
    });
    expect(response.status).toBe(200);
    expect(response.body.data.passed).toBe(true);
    expect(response.body.data.issues).toEqual([]);

    const { rows } = await harness.pool.query(
      'SELECT count(*)::int AS count FROM asset_revision WHERE scope_id = $1',
      [harness.projectId],
    );
    expect(rows[0].count).toBe(0);
  });

  it('非法版本号进问题列表而不是变成错误响应', async () => {
    const response = await harness.request({
      method: 'POST',
      path: '/assets/validate',
      token,
      json: registerSkillRequest({ slug: 'm25-validate-version', version: 'latest' }),
    });
    expect(response.status).toBe(200);
    expect(response.body.data.passed).toBe(false);
    expect(response.body.data.issues.length).toBeGreaterThan(0);
    expect(response.body.data.issues[0].field_path).toBe('version');
  });

  it('非法 slug 进问题列表', async () => {
    const response = await harness.request({
      method: 'POST',
      path: '/assets/validate',
      token,
      json: registerSkillRequest({ slug: 'Not A Slug' }),
    });
    expect(response.status).toBe(200);
    expect(response.body.data.passed).toBe(false);
    expect(response.body.data.issues[0].field_path).toBe('slug');
  });

  it('载荷级错误也进问题列表', async () => {
    const response = await harness.request({
      method: 'POST',
      path: '/assets/validate',
      token,
      json: registerSkillRequest({
        slug: 'm25-validate-payload',
        payload: skillPayload({ concept_validation: 'not_requested', tags: ['a'.repeat(64)] }),
      }),
    });
    expect(response.status).toBe(200);
    expect(response.body.data.passed).toBe(false);
    expect(response.body.data.issues.length).toBeGreaterThan(0);
  });

  it('缺少鉴权时返回 401', async () => {
    const response = await harness.request({
      method: 'POST',
      path: '/assets/validate',
      json: registerSkillRequest({ slug: 'm25-validate-anonymous' }),
    });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });
});
