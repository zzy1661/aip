import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { ERROR_CODES, PERMISSIONS } from '@aip/contracts';
import { createKnowledgeRouter, createRegistryRouter } from '@aip/api';
import { createHarness, type Harness } from '../helpers/app.js';

/**
 * DOC-02：OpenAPI 与实现的一致性必须由断言守住，不能靠人工核对。
 *
 * 三条断言：
 * 1. 错误码枚举与契约层双向相等（多一个少一个都要失败）；
 * 2. 每个操作声明的 `x-permission` 都是真实存在的权限；
 * 3. 文档中的路径/操作集合与 Express 实际注册的路由集合完全相等。
 *
 * 第 3 条同时覆盖两个方向：文档写了但没实现、实现���但没写。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const spec = YAML.parse(readFileSync(resolve(repoRoot, 'openapi/aip-v1.yaml'), 'utf8')) as any;

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

const PROBE_UUID = '00000000-0000-4000-8000-000000000000';

interface RouteEntry {
  method: string;
  path: string;
}

/** Express 的 `:name` 与 OpenAPI 的 `{name}` 需要归一到同一种写法。 */
function toOpenApiPath(expressPath: string): string {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function collectRoutes(router: unknown): RouteEntry[] {
  const entries: RouteEntry[] = [];
  const stack = (router as { stack?: unknown[] })?.stack ?? [];
  for (const layer of stack as any[]) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods ?? {})) {
        if (method === '_all') continue;
        entries.push({ method: method.toUpperCase(), path: toOpenApiPath(layer.route.path) });
      }
      continue;
    }
    if (Array.isArray(layer.handle?.stack)) {
      entries.push(...collectRoutes(layer.handle));
    }
  }
  return entries;
}

function documentedOperations(): RouteEntry[] {
  const entries: RouteEntry[] = [];
  for (const [path, item] of Object.entries(spec.paths as Record<string, any>)) {
    for (const method of HTTP_METHODS) {
      if (item[method]) entries.push({ method: method.toUpperCase(), path });
    }
  }
  return entries;
}

function collectRefs(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, found);
    return found;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === '$ref' && typeof value === 'string') found.push(value);
      else collectRefs(value, found);
    }
  }
  return found;
}

function resolvePointer(ref: string): unknown {
  const segments = ref.replace(/^#\//, '').split('/');
  let current: any = spec;
  for (const segment of segments) {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current === undefined || current === null || !(key in current)) return undefined;
    current = current[key];
  }
  return current;
}

describe('DOC-02 OpenAPI 与实现一致', () => {
  let harness: Harness;
  let implemented: RouteEntry[];

  beforeAll(async () => {
    harness = await createHarness({ label: 'openapi' });
    implemented = [
      ...collectRoutes(harness.app.router ?? (harness.app as any)._router),
      ...collectRoutes(createRegistryRouter(harness.registry)),
      ...collectRoutes(createKnowledgeRouter(harness.knowledge)),
    ];
  });

  afterAll(async () => {
    await harness.close();
  });

  it('错误码枚举与契约层双向相等', () => {
    const documented = spec.components.schemas.ErrorCode.enum as string[];
    expect(new Set(documented)).toEqual(new Set(ERROR_CODES));
    expect([...documented].sort()).toEqual([...ERROR_CODES].sort());
  });

  it('文档里的每个操作都声明了已知权限', () => {
    const known = new Set<string>([...PERMISSIONS, 'none']);
    const unknown: string[] = [];
    for (const [path, item] of Object.entries(spec.paths as Record<string, any>)) {
      for (const method of HTTP_METHODS) {
        const operation = item[method];
        if (!operation) continue;
        const permission = operation['x-permission'];
        if (typeof permission !== 'string' || !known.has(permission)) {
          unknown.push(`${method.toUpperCase()} ${path} -> ${String(permission)}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it('文档里的 operationId 唯一且非空', () => {
    const ids: string[] = [];
    for (const item of Object.values(spec.paths as Record<string, any>)) {
      for (const method of HTTP_METHODS) {
        const operation = (item as any)[method];
        if (!operation) continue;
        if (typeof operation.operationId === 'string') ids.push(operation.operationId);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
  });

  it('文档里的 $ref 全部可解析', () => {
    const dangling = collectRefs(spec).filter((ref) => {
      if (!ref.startsWith('#/')) return true;
      return resolvePointer(ref) === undefined;
    });
    expect(dangling).toEqual([]);
  });

  it('文档路径集合与实际注册路由集合完全相等', () => {
    const key = (entry: RouteEntry) => `${entry.method} ${entry.path}`;
    const documented = new Set(documentedOperations().map(key));
    const actual = new Set(implemented.map(key));
    expect([...documented].sort()).toEqual([...actual].sort());
  });

  it('每个文档路径在运行期都能命中路由（不会落到 route not found）', async () => {
    const token = await harness.token({ permissions: PERMISSIONS });
    const unreachable: string[] = [];
    for (const entry of documentedOperations()) {
      const concrete = entry.path.replace(/\{([^}]+)\}/g, (_match, name: string) =>
        name === 'version' ? '1.0.0' : name === 'subject' ? 'probe-subject' : PROBE_UUID,
      );
      let message: string | undefined;
      if (concrete === '/healthz') {
        const response = await fetch(`${harness.baseUrl}/healthz`);
        message = ((await response.json()) as { message?: string }).message;
      } else {
        const result = await harness.request({
          method: entry.method,
          path: concrete,
          token,
          idempotencyKey: `openapi-probe-${entry.method}-${concrete}`,
        });
        message = result.body?.message;
      }
      if (message === 'route not found') unreachable.push(`${entry.method} ${entry.path}`);
    }
    expect(unreachable).toEqual([]);
  });
});
