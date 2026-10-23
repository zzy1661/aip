import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));

/**
 * 所有测试层共用同一份源码别名：
 * 测试直接跑 TypeScript 源码，不依赖构建产物，避免出现「代码存在但测的是旧产物」。
 */
export const sourceAlias = {
  '@aip/contracts': resolve(root, 'packages/contracts/src/index.ts'),
  '@aip/api': resolve(root, 'services/api/src/index.ts'),
};

export function makeConfig(
  include: string[],
  options: { fileParallelism?: boolean } = {},
): ReturnType<typeof defineConfig> {
  return defineConfig({
    resolve: { alias: sourceAlias },
    test: {
      include,
      environment: 'node',
      globals: false,
      testTimeout: 60_000,
      hookTimeout: 120_000,
      teardownTimeout: 30_000,
      fileParallelism: options.fileParallelism ?? false,
    },
  });
}
