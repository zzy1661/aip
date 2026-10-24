import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { registerSkillRequest, skillPayload } from '../helpers/fixtures.js';

/**
 * B-1：版本创建的幂等身份必须绑定目标资产。
 *
 * 反例：同一个 Idempotency-Key + 同一个请求体打到两个不同 assetId 时，
 * 如果幂等身份不含 assetId，第二次会回放第一次的响应，
 * 把版本写到资产 A 上，资产 B 的版本从未创建。
 */
describe('B-1 幂等身份绑定目标资产', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'b1scope' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  async function registerSkill(slug: string): Promise<string> {
    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: `b1-register-${slug}`,
      json: registerSkillRequest({ slug, version: '1.0.0' }),
    });
    expect(response.status).toBe(201);
    return response.body.data.asset_id as string;
  }

  it('同一个幂等键用在两个资产上时，各自成立', async () => {
    const assetA = await registerSkill('b1-scope-a');
    const assetB = await registerSkill('b1-scope-b');

    const versionBody = {
      version: '2.0.0',
      title: '第二版',
      description: 'B-1 回归',
      payload: skillPayload(),
    };

    const first = await harness.request({
      method: 'POST',
      path: `/assets/${assetA}/versions`,
      token,
      idempotencyKey: 'b1-shared-key',
      json: versionBody,
    });
    expect(first.status).toBe(201);

    const second = await harness.request({
      method: 'POST',
      path: `/assets/${assetB}/versions`,
      token,
      idempotencyKey: 'b1-shared-key',
      json: versionBody,
    });
    expect(second.status).toBe(201);
    expect(second.body.data.asset_id).toBe(assetB);

    const detailA = await harness.request({
      method: 'GET',
      path: `/assets/${assetA}/versions/2.0.0`,
      token,
    });
    expect(detailA.status).toBe(200);
    expect(detailA.body.data.asset_id).toBe(assetA);

    const detailB = await harness.request({
      method: 'GET',
      path: `/assets/${assetB}/versions/2.0.0`,
      token,
    });
    expect(detailB.status).toBe(200);
    expect(detailB.body.data.asset_id).toBe(assetB);
  });

  it('同一个资产上的同键重放仍然返回第一次的结果', async () => {
    const assetId = await registerSkill('b1-replay');

    const versionBody = {
      version: '3.0.0',
      title: '第三版',
      description: 'B-1 回归',
      payload: skillPayload(),
    };

    const first = await harness.request({
      method: 'POST',
      path: `/assets/${assetId}/versions`,
      token,
      idempotencyKey: 'b1-replay-key',
      json: versionBody,
    });
    expect(first.status).toBe(201);

    const replay = await harness.request({
      method: 'POST',
      path: `/assets/${assetId}/versions`,
      token,
      idempotencyKey: 'b1-replay-key',
      json: versionBody,
    });
    expect(replay.status).toBe(201);
    expect(replay.body.data.asset_id).toBe(assetId);

    const revisions = await harness.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM asset_revision
        WHERE scope_id = $1 AND asset_id = $2 AND version = '3.0.0'`,
      [harness.projectId, assetId],
    );
    expect(revisions.rows[0]!.count).toBe('1');
  });

  it('同一个资产上的同键不同请求体仍然是幂等冲突', async () => {
    const assetId = await registerSkill('b1-conflict');

    const first = await harness.request({
      method: 'POST',
      path: `/assets/${assetId}/versions`,
      token,
      idempotencyKey: 'b1-conflict-key',
      json: {
        version: '4.0.0',
        title: '第四版',
        description: 'B-1 回归',
        payload: skillPayload(),
      },
    });
    expect(first.status).toBe(201);

    const conflict = await harness.request({
      method: 'POST',
      path: `/assets/${assetId}/versions`,
      token,
      idempotencyKey: 'b1-conflict-key',
      json: {
        version: '4.0.0',
        title: '第四版（改了描述）',
        description: 'B-1 回归',
        payload: skillPayload(),
      },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});
