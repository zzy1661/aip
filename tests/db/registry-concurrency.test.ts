import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { registerSkillRequest, skillPayload } from '../helpers/fixtures.js';

/**
 * M04：并发与幂等。
 *
 * 断言口径：同一 slug/version 并发只落一个资产与一条成功审计，其余 409；
 * 同键同内容重放原资源；同键异内容 409 且旧正文不变；不得偷偷产生 1.0.1。
 */
describe('M04 并发注册与幂等', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm04' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('20 个并发的同 slug 同版本只有一个成功，其余 409', async () => {
    const slug = 'm04-race-skill';
    const body = registerSkillRequest({ slug, version: '1.0.0' });

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_unused, index) =>
        harness.request({
          method: 'POST',
          path: '/assets',
          token,
          idempotencyKey: `m04-race-${index}`,
          json: body,
        }),
      ),
    );

    const created = responses.filter((response) => response.status === 201);
    const conflicts = responses.filter((response) => response.status === 409);
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(19);
    for (const response of responses) {
      expect([201, 409]).toContain(response.status);
    }

    const assets = await harness.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM asset WHERE scope_id = $1 AND slug = $2',
      [harness.projectId, slug],
    );
    expect(assets.rows[0]!.count).toBe('1');

    const revisions = await harness.pool.query<{ version: string; count: string }>(
      `SELECT version, count(*)::text AS count FROM asset_revision
        WHERE scope_id = $1 AND asset_id = (
          SELECT id FROM asset WHERE scope_id = $1 AND slug = $2
        ) GROUP BY version`,
      [harness.projectId, slug],
    );
    expect(revisions.rows).toHaveLength(1);
    expect(revisions.rows[0]!.version).toBe('1.0.0');

    const audits = await harness.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_event
        WHERE scope_id = $1 AND operation = 'assets.register' AND result = 'succeeded'
          AND resource_ref LIKE $2`,
      [harness.projectId, `%/${created[0]!.body.data.asset_id}@1.0.0`],
    );
    expect(audits.rows[0]!.count).toBe('1');
  });

  it('同键同内容重放原资源，同键异内容 409 且旧正文不变', async () => {
    const slug = 'm04-idem-skill';
    const body = registerSkillRequest({ slug, version: '1.0.0' });

    const first = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm04-idem-key',
      json: body,
    });
    expect(first.status).toBe(201);

    const replay = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm04-idem-key',
      json: body,
    });
    expect(replay.status).toBe(201);
    expect(replay.body.data.asset_id).toBe(first.body.data.asset_id);
    expect(replay.body.data.content_hash).toBe(first.body.data.content_hash);

    const conflicting = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm04-idem-key',
      json: registerSkillRequest({ slug, version: '1.0.0', title: '换了标题' }),
    });
    expect(conflicting.status).toBe(409);
    expect(conflicting.body.code).toBe('IDEMPOTENCY_CONFLICT');

    const detail = await harness.request({
      method: 'GET',
      path: `/assets/${first.body.data.asset_id}/versions/1.0.0`,
      token,
    });
    expect(detail.body.data.title).toBe(body.title);
  });

  it('并发失败不会偷偷创建 1.0.1', async () => {
    const slug = 'm04-no-bump-skill';
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        harness.request({
          method: 'POST',
          path: '/assets',
          token,
          idempotencyKey: `m04-no-bump-${index}`,
          json: registerSkillRequest({ slug, version: '1.0.0' }),
        }),
      ),
    );
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);

    const versions = await harness.pool.query<{ version: string }>(
      `SELECT r.version FROM asset_revision r
         JOIN asset a ON a.scope_id = r.scope_id AND a.id = r.asset_id
        WHERE r.scope_id = $1 AND a.slug = $2`,
      [harness.projectId, slug],
    );
    expect(versions.rows.map((row) => row.version)).toEqual(['1.0.0']);
  });

  it('同 slug 的第二个版本必须显式创建，注册动作本身不产生新版本', async () => {
    const slug = 'm04-explicit-version-skill';
    const created = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm04-explicit-1',
      json: registerSkillRequest({ slug, version: '1.0.0' }),
    });
    expect(created.status).toBe(201);

    const versions = await harness.pool.query<{ version: string }>(
      `SELECT r.version FROM asset_revision r
         JOIN asset a ON a.scope_id = r.scope_id AND a.id = r.asset_id
        WHERE r.scope_id = $1 AND a.slug = $2 ORDER BY r.version`,
      [harness.projectId, slug],
    );
    expect(versions.rows.map((row) => row.version)).toEqual(['1.0.0']);

    const explicit = await harness.request({
      method: 'POST',
      path: `/assets/${created.body.data.asset_id}/versions`,
      token,
      idempotencyKey: 'm04-explicit-2',
      json: {
        version: '1.0.1',
        title: 'M04 技能 1.0.1',
        description: '',
        payload: skillPayload(),
      },
    });
    expect(explicit.status).toBe(201);

    const after = await harness.pool.query<{ version: string }>(
      `SELECT r.version FROM asset_revision r
         JOIN asset a ON a.scope_id = r.scope_id AND a.id = r.asset_id
        WHERE r.scope_id = $1 AND a.slug = $2 ORDER BY r.version`,
      [harness.projectId, slug],
    );
    expect(after.rows.map((row) => row.version)).toEqual(['1.0.0', '1.0.1']);
  });
});
