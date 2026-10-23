import { describe, expect, it } from 'vitest';
import { Validator, validateUpload } from '@aip/api';
import { UPLOAD_MAX_BYTES, skillPayloadSchema } from '@aip/contracts';

/**
 * M12 / M05：上传边界与内容入口（服务层单元口径）。
 *
 * 断言口径：
 * - 恰好等于上限的文件必须被接受（只测超限不算覆盖边界）；
 * - 压缩包等非白名单类型必须在触达上游之前被拒；
 * - 正文只有 inline_markdown 一种入口形态，本机路径形态的入口必须被契约拒绝。
 */
describe('M12/M05 上传边界与内容入口（校验层）', () => {
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

  it('恰好等于上限的文件被接受', () => {
    const content = Buffer.alloc(UPLOAD_MAX_BYTES, 0x61);
    const validated = validateUpload(
      { originalName: 'edge.md', mimeType: 'text/markdown', content },
      UPLOAD_MAX_BYTES,
    );
    expect(validated.content.length).toBe(UPLOAD_MAX_BYTES);
    expect(validated.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('超过上限一个字节的文件被拒绝', () => {
    expectApiError(
      () =>
        validateUpload(
          {
            originalName: 'edge.md',
            mimeType: 'text/markdown',
            content: Buffer.alloc(UPLOAD_MAX_BYTES + 1, 0x61),
          },
          UPLOAD_MAX_BYTES,
        ),
      'UPLOAD_TOO_LARGE',
      'file',
    );
  });

  it('压缩包类文件被拒绝', () => {
    for (const name of ['bundle.zip', 'bundle.gz', 'bundle.tar.gz']) {
      expectApiError(
        () =>
          validateUpload(
            {
              originalName: name,
              mimeType: 'application/zip',
              content: Buffer.from('PK'),
            },
            UPLOAD_MAX_BYTES,
          ),
        'UNSUPPORTED_MEDIA_TYPE',
        'file',
      );
    }
  });

  it('正文内容入口只接受 inline_markdown', () => {
    const validator = new Validator();
    const base = {
      input_contract: [],
      output_contract: [],
      concept_validation: 'not_requested',
      tags: ['test'],
    };

    // 本机路径形态的入口不是合法入口形态，必须被契约拒绝。
    expectApiError(
      () =>
        validator.assert(skillPayloadSchema, {
          ...base,
          content: { kind: 'local_path', path: '/etc/passwd' },
        }),
      'CONTRACT_INVALID',
    );

    // 即使 kind 合法，也不允许夹带 path 之类的额外入口字段。
    expectApiError(
      () =>
        validator.assert(skillPayloadSchema, {
          ...base,
          content: { kind: 'inline_markdown', body: '# x', path: '/etc/passwd' },
        }),
      'CONTRACT_INVALID',
    );

    // 唯一合法形态必须被接受。
    const accepted = validator.assert<{ content: { kind: string; body: string } }>(
      skillPayloadSchema,
      { ...base, content: { kind: 'inline_markdown', body: '# x' } },
    );
    expect(accepted.content.kind).toBe('inline_markdown');
  });

  it('正文入口被拒时不会读取任何本机文件', () => {
    // 契约层根本没有「按路径读取正文」的能力：正文只能是随请求内联的字面量。
    // 这里用契约 schema 的属性集合把这一点固定下来。
    const contentSchema = (
      skillPayloadSchema as {
        properties: { content: { properties: Record<string, unknown> } };
      }
    ).properties.content.properties;
    expect(Object.keys(contentSchema).sort()).toEqual(['body', 'kind']);
    expect(contentSchema.kind).toEqual({
      type: 'string',
      enum: ['inline_markdown'],
    });
  });
});
