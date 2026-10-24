import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { registerSkillRequest } from '../helpers/fixtures.js';

/**
 * M-3：版本事实在 DB 层不可变。
 *
 * content_hash 的计算输入包含 title / description / payload，
 * 因此这三列一旦可被绕过 API 直接改写，「内容寻址」就会被削弱：
 * 同一个 content_hash 会指向两份不同的内容。
 */
describe('M-3 版本事实 DB 层不可变', () => {
  let harness: Harness;
  let token: string;
  let assetId: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'immutability' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
    const created = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'immutable-skill',
      json: registerSkillRequest({ slug: 'immutable-skill', title: '原始标题' }),
    });
    expect(created.status).toBe(201);
    assetId = created.body.data.asset_id as string;
  });

  afterAll(async () => {
    await harness.close();
  });

  async function currentRow(): Promise<{ title: string; content_hash: string }> {
    const { rows } = await harness.pool.query<{ title: string; content_hash: string }>(
      `SELECT title, content_hash FROM asset_revision
        WHERE scope_id = $1 AND asset_id = $2 AND version = '1.0.0'`,
      [harness.projectId, assetId],
    );
    return rows[0]!;
  }

  it.each([
    ['title', `UPDATE asset_revision SET title = '被改写的标题'`],
    ['description', `UPDATE asset_revision SET description = '被改写的描述'`],
    ['payload', `UPDATE asset_revision SET payload = jsonb_set(payload, '{tags}', '["x"]')`],
    ['content_hash', `UPDATE asset_revision SET content_hash = 'deadbeef'`],
  ])('%s 的直接 UPDATE 被拒绝', async (_column, statement) => {
    await expect(
      harness.pool.query(`${statement} WHERE scope_id = $1 AND asset_id = $2`, [
        harness.projectId,
        assetId,
      ]),
    ).rejects.toThrowError(/immutable/i);

    const row = await currentRow();
    expect(row.title).toBe('原始标题');
  });

  it('DELETE 被拒绝', async () => {
    await expect(
      harness.pool.query(
        `DELETE FROM asset_revision WHERE scope_id = $1 AND asset_id = $2`,
        [harness.projectId, assetId],
      ),
    ).rejects.toThrowError(/immutable/i);
  });

  it('content_hash 与版本内容始终一致', async () => {
    const detail = await harness.request({
      method: 'GET',
      path: `/assets/${assetId}/versions/1.0.0`,
      token,
    });
    expect(detail.status).toBe(200);
    const row = await currentRow();
    expect(detail.body.data.content_hash).toBe(row.content_hash);
    expect(detail.body.data.title).toBe(row.title);
  });
});
