import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { registerSkillRequest, skillPayload } from '../helpers/fixtures.js';

/**
 * M03：Skill 注册与精确版本查询。
 *
 * 断言口径：注册返回 201 与稳定哈希；重启（重新建连）后 GET 精确版本内容一致；
 * 分页正确；注册不产生发布或执行副作用。
 */
describe('M03 Skill 注册与查询', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm03' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('注册返回 201、稳定哈希与 registered 状态，正文与元数据一致', async () => {
    const request = registerSkillRequest({
      slug: 'm03-basic-skill',
      version: '1.0.0',
      title: 'M03 技能',
      description: 'M03 描述',
      payload: skillPayload(),
    });

    const created = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm03-register-1',
      json: request,
    });
    expect(created.status).toBe(201);
    expect(created.body.data.version).toBe('1.0.0');
    expect(created.body.data.registration_status).toBe('registered');
    expect(created.body.data.content_hash).toMatch(/^[0-9a-f]{64}$/);

    const detail = await harness.request({
      method: 'GET',
      path: `/assets/${created.body.data.asset_id}/versions/1.0.0`,
      token,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.data.title).toBe('M03 技能');
    expect(detail.body.data.description).toBe('M03 描述');
    expect(detail.body.data.content_hash).toBe(created.body.data.content_hash);
    expect(detail.body.data.payload).toEqual(request.payload);
  });

  it('API 重启后仍能读到同一版本与同一哈希', async () => {
    const request = registerSkillRequest({ slug: 'm03-restart-skill' });
    const created = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm03-register-restart',
      json: request,
    });
    expect(created.status).toBe(201);

    // 重启 API 进程：HTTP 服务重建，数据库与文件存储保持不变。
    await harness.restart();

    const detail = await harness.request({
      method: 'GET',
      path: `/assets/${created.body.data.asset_id}/versions/1.0.0`,
      token,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.data.content_hash).toBe(created.body.data.content_hash);
    expect(detail.body.data.payload).toEqual(request.payload);
    expect(detail.body.data.registration_status).toBe('registered');
  });

  it('分页按 limit 截断并给出 next_cursor', async () => {
    for (let index = 0; index < 5; index += 1) {
      const created = await harness.request({
        method: 'POST',
        path: '/assets',
        token,
        idempotencyKey: `m03-page-${index}`,
        json: registerSkillRequest({ slug: `m03-page-skill-${index}` }),
      });
      expect(created.status).toBe(201);
    }

    const page = await harness.request({
      method: 'GET',
      path: '/assets?limit=2',
      token,
    });
    expect(page.status).toBe(200);
    expect(page.body.data).toHaveLength(2);
    expect(page.body.next_cursor).toBeTruthy();

    const next = await harness.request({
      method: 'GET',
      path: `/assets?limit=2&cursor=${encodeURIComponent(page.body.next_cursor)}`,
      token,
    });
    expect(next.status).toBe(200);
    expect(next.body.data).toHaveLength(2);

    const firstIds = new Set(page.body.data.map((item: { asset_id: string }) => item.asset_id));
    for (const item of next.body.data) {
      expect(firstIds.has(item.asset_id)).toBe(false);
    }
  });

  it('注册不产生发布或执行副作用', async () => {
    const created = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm03-no-side-effect',
      json: registerSkillRequest({ slug: 'm03-no-effect' }),
    });
    expect(created.status).toBe(201);

    const operations = await harness.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM operation WHERE scope_id = $1',
      [harness.projectId],
    );
    expect(operations.rows[0]!.count).toBe('0');

    const status = await harness.request({
      method: 'GET',
      path: `/assets/${created.body.data.asset_id}/versions/1.0.0`,
      token,
    });
    // 只有注册状态，没有 published / approved / executable 之类的发布态。
    expect(status.body.data.registration_status).toBe('registered');
    expect(status.body.data.published).toBeUndefined();
    expect(status.body.data.executable).toBeUndefined();
  });
});
