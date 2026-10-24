import { createHash } from 'node:crypto';
import { apiError, fieldIssue } from '../http/errors.js';

export const ALLOWED_EXTENSIONS = ['.txt', '.md', '.pdf'] as const;

export const ALLOWED_MIME_TYPES: Record<string, string[]> = {
  '.txt': ['text/plain'],
  '.md': ['text/markdown', 'text/plain'],
  '.pdf': ['application/pdf'],
};

export const MAX_BASENAME_LENGTH = 128;

export interface UploadCandidate {
  originalName: string;
  mimeType: string;
  content: Buffer;
}

export interface ValidatedUpload {
  basename: string;
  extension: string;
  mime: string;
  content: Buffer;
  sha256: string;
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index).toLowerCase();
}

/**
 * 上传校验：扩展名 + MIME + 文件头 + 文本编码，全部在调用上游之前完成。
 * 任何不合法请求都不会触发 RAGFlow 请求。
 */
export function validateUpload(
  candidate: UploadCandidate,
  maxBytes: number,
): ValidatedUpload {
  const rawName = candidate.originalName ?? '';
  if (rawName.length === 0) {
    throw apiError('UNSUPPORTED_MEDIA_TYPE', 'file name is required');
  }
  if (rawName.includes('/') || rawName.includes('\\') || rawName.includes('\0')) {
    throw apiError('CONTRACT_INVALID', 'file name must not contain a path', [
      fieldIssue('file', 'file name must be a bare base name'),
    ]);
  }
  const basename = rawName.trim();
  if (basename.length === 0 || basename.length > MAX_BASENAME_LENGTH) {
    throw apiError('CONTRACT_INVALID', 'file name length is out of range', [
      fieldIssue('file', `file name must be 1..${MAX_BASENAME_LENGTH} characters`),
    ]);
  }
  if (basename === '.' || basename === '..' || basename.startsWith('..')) {
    throw apiError('CONTRACT_INVALID', 'file name is not allowed', [
      fieldIssue('file', 'file name must not traverse directories'),
    ]);
  }

  const extension = extensionOf(basename);
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(extension)) {
    throw apiError('UNSUPPORTED_MEDIA_TYPE', 'file type is not supported', [
      fieldIssue('file', `supported extensions are ${ALLOWED_EXTENSIONS.join(', ')}`),
    ]);
  }

  const mime = (candidate.mimeType ?? '').split(';')[0]!.trim().toLowerCase();
  const allowedMimes = ALLOWED_MIME_TYPES[extension] ?? [];
  if (!allowedMimes.includes(mime)) {
    throw apiError('UNSUPPORTED_MEDIA_TYPE', 'file type is not supported', [
      fieldIssue('file', `expected one of ${allowedMimes.join(', ')} for ${extension}`),
    ]);
  }

  if (candidate.content.length === 0) {
    throw apiError('CONTRACT_INVALID', 'file is empty', [fieldIssue('file', 'file is empty')]);
  }
  if (candidate.content.length > maxBytes) {
    throw apiError('UPLOAD_TOO_LARGE', 'file exceeds the platform size limit', [
      fieldIssue('file', `file size ${candidate.content.length} exceeds ${maxBytes} bytes`),
    ]);
  }

  if (extension === '.pdf') {
    assertPdf(candidate.content);
  } else {
    assertPlainText(candidate.content);
  }

  return {
    basename,
    extension,
    mime,
    content: candidate.content,
    sha256: createHash('sha256').update(candidate.content).digest('hex'),
  };
}

function assertPdf(content: Buffer): void {
  const header = content.subarray(0, 5).toString('latin1');
  if (header !== '%PDF-') {
    throw apiError('UNSUPPORTED_MEDIA_TYPE', 'file content does not match its declared type', [
      fieldIssue('file', 'pdf magic bytes are missing'),
    ]);
  }
  // 加密字典标记可能距文件尾很远（尾部还有交叉引用表与增量更新段），
  // 只扫尾部 4 KiB 会漏检，因此全文件扫描。
  if (content.indexOf('/Encrypt', 0, 'latin1') !== -1) {
    throw apiError('CONTRACT_INVALID', 'encrypted pdf files are not supported', [
      fieldIssue('file', 'encrypted pdf is not supported'),
    ]);
  }
}

const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

function assertPlainText(content: Buffer): void {
  const text = content.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(content)) {
    throw apiError('CONTRACT_INVALID', 'text file is not valid utf-8', [
      fieldIssue('file', 'file is not valid utf-8'),
    ]);
  }
  if (TEXT_CONTROL.test(text)) {
    throw apiError('CONTRACT_INVALID', 'text file contains unsupported control characters', [
      fieldIssue('file', 'file contains binary control characters'),
    ]);
  }
}
