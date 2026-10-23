import { createHash, randomUUID } from 'node:crypto';
import { canonicalize } from './canonical.js';

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** 结构化内容的稳定摘要。 */
export function hashObject(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

export function newId(): string {
  return randomUUID();
}

/** 面向 RAGFlow dataset 名称的稳定短名，避免把内部标题直接外传。 */
export function newDatasetName(scopeId: string): string {
  return `aip-${scopeId}-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}
