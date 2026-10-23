import { describe, expect, it } from 'vitest';
import { validateUpload } from '@aip/api';
import { UPLOAD_MAX_BYTES } from '@aip/contracts';

/**
 * M12：上传大小与类型限制（服务层单元口径）。
 *
 * 断言口径：所有校验都在触达上游之前完成，
 * 因此不合法的文件既不会被接受，也不会产生任何上游请求。
 */
describe('M12 上传限制（校验层）', () => {
  function expectApiError(fn: () => unknown, code: string, fieldPath?: string): void {
    try {
      fn();
    } catch (error) {
      const apiError = error as { code?: string; details?: Array<{ field_path: string }> };
      expect(apiError.code).toBe(code);
      if (fieldPath) {
        expect(apiError.details?.[0]?.field_path).toBe(fieldPath);
      }
      return;
    }
    throw new Error(`expected ${code} but no error was thrown`);
  }

  it('超过 20MiB 的文件被拒绝', () => {
    expectApiError(
      () =>
        validateUpload(
          {
            originalName: 'big.md',
            mimeType: 'text/markdown',
            content: Buffer.alloc(UPLOAD_MAX_BYTES + 1, 0x61),
          },
          UPLOAD_MAX_BYTES,
        ),
      'UPLOAD_TOO_LARGE',
      'file',
    );
  });

  it('扩展名不在允许清单内被拒绝', () => {
    expectApiError(
      () =>
        validateUpload(
          { originalName: 'run.exe', mimeType: 'application/octet-stream', content: Buffer.from('x') },
          UPLOAD_MAX_BYTES,
        ),
      'UNSUPPORTED_MEDIA_TYPE',
      'file',
    );
  });

  it('MIME 与扩展名不匹配被拒绝', () => {
    expectApiError(
      () =>
        validateUpload(
          { originalName: 'note.md', mimeType: 'application/pdf', content: Buffer.from('# x') },
          UPLOAD_MAX_BYTES,
        ),
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  it('缺少 PDF 文件头被拒绝', () => {
    expectApiError(
      () =>
        validateUpload(
          { originalName: 'doc.pdf', mimeType: 'application/pdf', content: Buffer.from('plain') },
          UPLOAD_MAX_BYTES,
        ),
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  it('加密 PDF 被拒绝', () => {
    const content = Buffer.concat([
      Buffer.from('%PDF-1.7\n'),
      Buffer.from('body\n'),
      Buffer.from('/Encrypt 12 0 R\n'),
    ]);
    expectApiError(
      () =>
        validateUpload(
          { originalName: 'secret.pdf', mimeType: 'application/pdf', content },
          UPLOAD_MAX_BYTES,
        ),
      'CONTRACT_INVALID',
    );
  });

  it('非 UTF-8 文本被拒绝', () => {
    expectApiError(
      () =>
        validateUpload(
          {
            originalName: 'latin.txt',
            mimeType: 'text/plain',
            content: Buffer.from([0xff, 0xfe, 0x41]),
          },
          UPLOAD_MAX_BYTES,
        ),
      'CONTRACT_INVALID',
    );
  });

  it('含二进制控制字符的文本被拒绝', () => {
    expectApiError(
      () =>
        validateUpload(
          {
            originalName: 'binary.md',
            mimeType: 'text/markdown',
            content: Buffer.from([0x23, 0x20, 0x00, 0x01]),
          },
          UPLOAD_MAX_BYTES,
        ),
      'CONTRACT_INVALID',
    );
  });

  it('文件名含路径或 .. 被拒绝', () => {
    expectApiError(
      () =>
        validateUpload(
          { originalName: '../escape.md', mimeType: 'text/markdown', content: Buffer.from('# x') },
          UPLOAD_MAX_BYTES,
        ),
      'CONTRACT_INVALID',
      'file',
    );
    expectApiError(
      () =>
        validateUpload(
          { originalName: 'dir\\escape.md', mimeType: 'text/markdown', content: Buffer.from('# x') },
          UPLOAD_MAX_BYTES,
        ),
      'CONTRACT_INVALID',
      'file',
    );
  });

  it('空文件被拒绝', () => {
    expectApiError(
      () =>
        validateUpload(
          { originalName: 'empty.md', mimeType: 'text/markdown', content: Buffer.alloc(0) },
          UPLOAD_MAX_BYTES,
        ),
      'CONTRACT_INVALID',
    );
  });

  it('合法文件通过校验并给出稳定哈希', () => {
    const content = Buffer.from('# 标题\n\n正文\n', 'utf8');
    const validated = validateUpload(
      { originalName: 'ok.md', mimeType: 'text/markdown', content },
      UPLOAD_MAX_BYTES,
    );
    expect(validated.basename).toBe('ok.md');
    expect(validated.extension).toBe('.md');
    expect(validated.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(validated.content).toEqual(content);
  });

  it('txt 与 pdf 也在允许清单内', () => {
    expect(
      validateUpload(
        { originalName: 'a.txt', mimeType: 'text/plain', content: Buffer.from('hello') },
        UPLOAD_MAX_BYTES,
      ).extension,
    ).toBe('.txt');
    expect(
      validateUpload(
        { originalName: 'a.pdf', mimeType: 'application/pdf', content: Buffer.from('%PDF-1.4\n') },
        UPLOAD_MAX_BYTES,
      ).extension,
    ).toBe('.pdf');
  });
});
