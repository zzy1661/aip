import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { createReadyKnowledgeBase } from '../helpers/flow.js';

/**
 * M12：上传的大小与类型限制。
 *
 * 断言口径：不合法的上传必须在触达上游之前被拒绝，
 * 因此每次拒绝都要断言「零上游请求」。
 */
describe('M12 上传限制', () => {
  let harness: Harness;
  let token: string;
  let kbId: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm12', uploadMaxBytes: 1024 });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
    const created = await createReadyKnowledgeBase(harness, token, 'M12 知识库');
    kbId = created.kbId;
  });

  afterAll(async () => {
    await harness.close();
  });

  async function upload(
    file: { filename: string; contentType: string; content: Buffer | string },
    key: string,
  ): Promise<{ status: number; body: any }> {
    const before = harness.ragflow.calls.length;
    const response = await harness.request({
      method: 'POST',
      path: `/knowledge-bases/${kbId}/documents`,
      token,
      idempotencyKey: key,
      fields: { version: '1.0.0', applies_to: JSON.stringify({ mode: 'unconditional' }) },
      file,
    });
    const upstreamCalls = harness.ragflow.calls.slice(before).length;
    expect(upstreamCalls).toBe(0);
    return { status: response.status, body: response.body };
  }

  it('超过大小上限的文件被拒绝且不触达上游', async () => {
    const result = await upload(
      {
        filename: 'too-large.md',
        contentType: 'text/markdown',
        content: 'x'.repeat(2048),
      },
      'm12-too-large',
    );
    expect(result.status).toBe(413);
    expect(result.body.code).toBe('UPLOAD_TOO_LARGE');
  });

  it('扩展名不在允许清单内被拒绝', async () => {
    const result = await upload(
      {
        filename: 'payload.exe',
        contentType: 'application/octet-stream',
        content: 'MZ binary',
      },
      'm12-bad-extension',
    );
    expect(result.status).toBe(415);
    expect(result.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('扩展名与 MIME 不匹配被拒绝', async () => {
    const result = await upload(
      { filename: 'note.md', contentType: 'application/pdf', content: '%PDF-1.4 fake' },
      'm12-mime-mismatch',
    );
    expect(result.status).toBe(415);
  });

  it('伪装成 pdf 的文本被拒绝', async () => {
    const result = await upload(
      { filename: 'fake.pdf', contentType: 'application/pdf', content: 'not really a pdf' },
      'm12-fake-pdf',
    );
    expect(result.status).toBe(415);
    expect(result.body.details[0].reason).toContain('pdf');
  });

  it('文件名中的路径成分被剥离，落库为裸文件名', async () => {
    // multipart 解析层已经剥离目录成分，服务层的路径校验是第二道防线；
    // 这里断言最终落库的名称不含任何路径分隔符。
    const response = await harness.request({
      method: 'POST',
      path: `/knowledge-bases/${kbId}/documents`,
      token,
      idempotencyKey: 'm12-path-traversal',
      fields: { version: '1.0.0', applies_to: JSON.stringify({ mode: 'unconditional' }) },
      file: { filename: '../escape.md', contentType: 'text/markdown', content: '# 正常内容' },
    });
    expect(response.status).toBe(202);
    const { rows } = await harness.pool.query(
      `SELECT name FROM source_file_revision WHERE scope_id = $1 AND id = $2`,
      [harness.projectId, response.body.data.source_ref],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('escape.md');
    expect(rows[0].name).not.toContain('/');
    expect(rows[0].name).not.toContain('\\');
  });

  it('空文件被拒绝', async () => {
    const result = await upload(
      { filename: 'empty.md', contentType: 'text/markdown', content: '' },
      'm12-empty',
    );
    expect(result.status).toBe(422);
  });

  it('含非法控制字符的文本被拒绝', async () => {
    const result = await upload(
      {
        filename: 'binary.md',
        contentType: 'text/markdown',
        content: Buffer.from([0x23, 0x20, 0x00, 0x01, 0x0a]),
      },
      'm12-control-chars',
    );
    expect(result.status).toBe(422);
  });

  it('合法文件被接受并登记为待解析', async () => {
    const before = harness.ragflow.calls.length;
    const response = await harness.request({
      method: 'POST',
      path: `/knowledge-bases/${kbId}/documents`,
      token,
      idempotencyKey: 'm12-ok',
      fields: { version: '1.0.0', applies_to: JSON.stringify({ mode: 'unconditional' }) },
      file: { filename: 'ok.md', contentType: 'text/markdown', content: '# 正常内容\n' },
    });
    expect(response.status).toBe(202);
    expect(response.body.data.knowledge_ref).toBeTruthy();
    expect(response.body.data.operation_id).toBeTruthy();
    // 上传本身只是登记，真正的上游调用发生在 worker 推进时。
    expect(harness.ragflow.calls.slice(before)).toHaveLength(0);
  });
});
