/**
 * 规范化 JSON：递归按键排序，数组保持原有顺序。
 * 用于幂等摘要与内容哈希，保证同语义请求得到同摘要。
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(normalize);
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const entry = source[key];
    if (entry === undefined) continue;
    result[key] = normalize(entry);
  }
  return result;
}
