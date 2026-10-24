import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { createReadyKnowledgeBase, uploadSampleDocument } from '../helpers/flow.js';

/**
 * M12 / M05：上传被拒时平台不留下任何残留。
 *
 * 断言口径：
 * - 一次请求带多个文件必须被拒（不能只取第一个文件）；
 * - 被拒的上传既不能留下源文件行、知识版本行与操作行，也不能在文件存储里留下孤儿文件；
 * - 文件存储没有枚举接口，文件清单通过运行时私有根目录读取，
 *   这一点在此显式说明，避免把「无法枚举」误写成「断言通过」。
 */
describe('M12/M05 上传拒绝与残留', () => {
  let harness: Harness;
  let token: string;
  let kbId: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm12rej' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
    kbId = (await createReadyKnowledgeBase(harness, token, 'M12 拒绝')).kbId;
  });

  afterAll(async () => {
    await harness.close();
  });

  /** 文件存储根目录：FileStore 未暴露枚举接口，这里读运行时私有字段。 */
  function storeRoot(): string {
    return (harness.files as unknown as { root: string }).root;
  }

  function storedFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        out.push(full);
      }
    };
    walk(storeRoot());
    return out;
  }

  async function residue(): Promise<Record<string, number>> {
    const tables = ['source_file_revision', 'knowledge_revision', 'operation'];
    const result: Record<string, number> = {};
    for (const table of tables) {
      const { rows } = await harness.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table} WHERE scope_id = $1`,
        [harness.projectId],
      );
      result[table] = Number(rows[0]?.count ?? '0');
    }
    return result;
  }

  function buildTwoFileMultipart(): { body: Buffer; contentType: string } {
    const boundary = `----aip-test${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const head =
      `--${boundary}\r\nContent-Disposition: form-data; name="version"\r\n\r\n1.0.0\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="applies_to"\r\n\r\n{"mode":"unconditional"}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.md"\r\nContent-Type: text/markdown\r\n\r\n`;
    const tail =
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="b.md"\r\nContent-Type: text/markdown\r\n\r\n` +
      `# b\n\r\n--${boundary}--\r\n`;
    return {
      body: Buffer.from(`${head}# a\n${tail}`, 'utf8'),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

  it('一次请求带两个文件被拒绝', async () => {
    const multipart = buildTwoFileMultipart();
    const response = await fetch(
      `${harness.baseUrl}${harness.apiRoot}/knowledge-bases/${kbId}/documents`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': multipart.contentType,
          'idempotency-key': 'm12-two-files',
        },
        body: multipart.body,
      },
    );
    const body = (await response.json()) as { code?: string; message?: string };

    expect(response.status).toBe(400);
    expect(body.code).toBe('BAD_REQUEST');
    expect(body.message).toContain('invalid upload');
  });

  it('被拒的上传不留下数据库残留', async () => {
    const before = await residue();

    const rejected = await harness.request({
      method: 'POST',
      path: `/knowledge-bases/${kbId}/documents`,
      token,
      idempotencyKey: 'm12-reject-type',
      fields: { version: '2.0.0', applies_to: JSON.stringify({ mode: 'unconditional' }) },
      file: {
        filename: 'bundle.zip',
        contentType: 'application/zip',
        content: Buffer.from('PK'),
      },
    });
    expect(rejected.status).toBe(415);
    expect(rejected.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');

    expect(await residue()).toEqual(before);
  });

  it('被拒的上传不在文件存储里留下孤儿文件', async () => {
    // 先做一次成功上传，证明文件存储确实会写入文件，残留断言才有意义。
    await uploadSampleDocument(harness, token, kbId, { marker: 'M12-CONTROL' });
    const baseline = storedFiles();
    expect(baseline.length).toBeGreaterThan(0);

    const rejected = await harness.request({
      method: 'POST',
      path: `/knowledge-bases/${kbId}/documents`,
      token,
      idempotencyKey: 'm12-reject-residue',
      fields: { version: '3.0.0', applies_to: JSON.stringify({ mode: 'unconditional' }) },
      file: {
        filename: 'archive.gz',
        contentType: 'application/gzip',
        content: Buffer.from([0x1f, 0x8b, 0x08, 0x00]),
      },
    });
    expect(rejected.status).toBe(415);
    expect(rejected.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');

    expect(storedFiles().sort()).toEqual(baseline.sort());
  });

  it('缺少文件的上传被拒绝且不产生上游调用', async () => {
    const before = harness.ragflow.calls.length;
    const rejected = await harness.request({
      method: 'POST',
      path: `/knowledge-bases/${kbId}/documents`,
      token,
      idempotencyKey: 'm12-no-file',
      fields: { version: '4.0.0', applies_to: JSON.stringify({ mode: 'unconditional' }) },
    });
    expect(rejected.status).toBe(422);
    expect(rejected.body.code).toBe('CONTRACT_INVALID');
    expect(harness.ragflow.calls.length).toBe(before);
  });
});
