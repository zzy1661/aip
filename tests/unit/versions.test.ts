import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { registerSkillRequest, skillPayload } from '../helpers/fixtures.js';
import { CONTENT_MAX_BYTES, PAYLOAD_MAX_BYTES, type SkillContent } from '@aip/contracts';

/**
 * M05：版本号与内容体积。
 *
 * 断言口径：只有 MAJOR.MINOR.PATCH 合法；非法版本 422 且指向 version；
 * 正文超限 413；非法请求不落库；正文里的外部 URL 只是文本，不产生任何网络抓取。
 */
describe('M05 版本与内容体积', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm05' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  it.each(['latest', '^1.0', '1', 'v1.0.0', '1.0', '1.0.0.0', '01.0.0', ''])(
    '非法版本号 %s 被拒并指向 version',
    async (version) => {
      const response = await harness.request({
        method: 'POST',
        path: '/assets',
        token,
        idempotencyKey: `m05-version-${version.replace(/\W/g, '') || 'empty'}`,
        json: registerSkillRequest({
          slug: `m05-version-${version.replace(/\W/g, '') || 'empty'}`,
          version,
        }),
      });
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('INVALID_VERSION');
      expect(response.body.details[0].field_path).toBe('version');
    },
  );

  it('缺正文被拒并指向 content', async () => {
    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm05-missing-body',
      json: registerSkillRequest({
        slug: 'm05-missing-body',
        // 故意省略 body：契约层必须拒绝，类型上因此需要断言。
        payload: {
          ...skillPayload(),
          content: { kind: 'inline_markdown' } as SkillContent,
        },
      }),
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('CONTRACT_INVALID');
    expect(response.body.details[0].field_path).toContain('payload.content');
  });

  it('正文超过 256KiB 返回 413', async () => {
    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm05-content-too-large',
      json: registerSkillRequest({
        slug: 'm05-content-too-large',
        payload: skillPayload({
          content: {
            kind: 'inline_markdown',
            body: 'a'.repeat(CONTENT_MAX_BYTES + 1),
          },
        }),
      }),
    });
    expect(response.status).toBe(413);
    expect(response.body.code).toBe('UPLOAD_TOO_LARGE');
    expect(response.body.details[0].field_path).toContain('payload.content.body');
  });

  it('整体载荷超过 512KiB 返回 413', async () => {
    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm05-payload-too-large',
      json: registerSkillRequest({
        slug: 'm05-payload-too-large',
        payload: skillPayload({
          tags: Array.from({ length: 20 }, (_unused, index) => `tag-${index}-${'x'.repeat(30)}`),
          content: {
            kind: 'inline_markdown',
            body: 'b'.repeat(PAYLOAD_MAX_BYTES),
          },
        }),
      }),
    });
    expect(response.status).toBe(413);
    expect(response.body.code).toBe('UPLOAD_TOO_LARGE');
  });

  it('非法请求不写入任何数据', async () => {
    const before = await harness.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM asset_revision WHERE scope_id = $1',
      [harness.projectId],
    );
    await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm05-no-insert',
      json: registerSkillRequest({ slug: 'm05-no-insert', version: 'latest' }),
    });
    const after = await harness.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM asset_revision WHERE scope_id = $1',
      [harness.projectId],
    );
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
  });

  it('正文里的外部 URL 不会被抓取', async () => {
    const url = `${harness.ragflow.url}/api/v1/datasets/should-never-be-fetched`;
    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm05-url-body',
      json: registerSkillRequest({
        slug: 'm05-url-body',
        payload: skillPayload({
          content: {
            kind: 'inline_markdown',
            body: `# 外部引用\n\n请参考 ${url} 获取更多说明。\n`,
          },
        }),
      }),
    });
    expect(response.status).toBe(201);
    // 平台没有把正文里的地址当成内容入口。
    expect(harness.ragflow.calls).toHaveLength(0);
  });

  it('合法的 1.0.0 可以注册并按精确版本查回', async () => {
    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm05-valid',
      json: registerSkillRequest({ slug: 'm05-valid', version: '1.0.0' }),
    });
    expect(response.status).toBe(201);

    const detail = await harness.request({
      method: 'GET',
      path: `/assets/${response.body.data.asset_id}/versions/1.0.0`,
      token,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.data.version).toBe('1.0.0');
  });
});
