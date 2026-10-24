import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { createReadyKnowledgeBase } from '../helpers/flow.js';
import { UPLOAD_MAX_BYTES } from '@aip/contracts';

/**
 * M12：HTTP 层的真实 20MiB 上限。
 *
 * 单元层只覆盖了校验函数；这里让请求真的走一遍 multipart 上传，
 * 确认「恰好等于上限被接受」与「超 1 字节被拒」在 HTTP 层同样成立。
 * 这里的 harness 用生产默认上限（20MiB），不缩小。
 */
describe('M12 上传上限：HTTP 层的 20MiB 边界', () => {
  let harness: Harness;
  let token: string;
  let kbId: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm12real', projectId: 'm12-real' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
    const kb = await createReadyKnowledgeBase(harness, token, 'M12 真实上限');
    kbId = kb.kbId;
  });

  afterAll(async () => {
    await harness.close();
  });

  it('恰好 20MiB 被接受', async () => {
    const response = await harness.request({
      method: 'POST',
      path: `/knowledge-bases/${kbId}/documents`,
      token,
      idempotencyKey: 'm12-exact-limit',
      fields: { version: '1.0.0', applies_to: JSON.stringify({ mode: 'unconditional' }) },
      file: {
        filename: 'exact-limit.md',
        contentType: 'text/markdown',
        content: Buffer.alloc(UPLOAD_MAX_BYTES, 0x61),
      },
    });
    expect(response.status).toBe(202);
  });

  it('超 1 字节被拒且不触达上游', async () => {
    const before = harness.ragflow.calls.length;
    const response = await harness.request({
      method: 'POST',
      path: `/knowledge-bases/${kbId}/documents`,
      token,
      idempotencyKey: 'm12-over-limit',
      fields: { version: '1.0.0', applies_to: JSON.stringify({ mode: 'unconditional' }) },
      file: {
        filename: 'over-limit.md',
        contentType: 'text/markdown',
        content: Buffer.alloc(UPLOAD_MAX_BYTES + 1, 0x61),
      },
    });
    expect(response.status).toBe(413);
    expect(response.body.code).toBe('UPLOAD_TOO_LARGE');
    expect(harness.ragflow.calls.slice(before)).toHaveLength(0);
  });
});
