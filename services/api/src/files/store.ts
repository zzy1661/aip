import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { apiError } from '../http/errors.js';

/**
 * 受控文件存储：storage_key 由服务端生成，绝不接受用户提供的路径。
 */
export class FileStore {
  constructor(private readonly root: string) {}

  /** 存储键只使用服务端生成的 UUID 段，避免任何用户可控路径成分。 */
  buildStorageKey(scopeId: string, fileId: string, version: string): string {
    const scopePart = createHash('sha256').update(scopeId).digest('hex').slice(0, 16);
    return join(scopePart, fileId, version);
  }

  private absolutePath(storageKey: string): string {
    const target = resolve(this.root, storageKey);
    const root = resolve(this.root);
    if (target !== root && !target.startsWith(root + sep)) {
      throw apiError('CONTRACT_INVALID', 'storage key escapes the managed root');
    }
    return target;
  }

  async write(storageKey: string, content: Buffer): Promise<void> {
    const target = this.absolutePath(storageKey);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { mode: 0o640 });
  }

  async read(storageKey: string): Promise<Buffer> {
    try {
      return await readFile(this.absolutePath(storageKey));
    } catch {
      throw apiError('NOT_FOUND', 'source file is not available');
    }
  }

  async remove(storageKey: string): Promise<void> {
    await rm(this.absolutePath(storageKey), { force: true });
  }
}
