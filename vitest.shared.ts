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
  options: { fileParallelism?: boolean; mode: string; testTimeoutMs?: number },
): ReturnType<typeof defineConfig> {
  return defineConfig({
    resolve: { alias: sourceAlias },
    test: {
      include,
      environment: 'node',
      globals: false,
      testTimeout: options.testTimeoutMs ?? 60_000,
      hookTimeout: 120_000,
      teardownTimeout: 30_000,
      fileParallelism: options.fileParallelism ?? false,
      // 运行模式写进环境变量：worker 侧的断言计数与请求事实需要知道写到哪个报告目录。
      env: { AIP_REPORT_MODE: options.mode },
      setupFiles: [resolve(root, 'tests/helpers/report-setup.ts')],
      reporters: [
        'default',
        [resolve(root, 'tools/report/reporter.ts'), { mode: options.mode }],
      ],
    },
  });
}
