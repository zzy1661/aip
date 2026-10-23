import { spawnSync } from 'node:child_process';

/**
 * 真实联调层的门禁。
 *
 * 背景：直接跑 `pnpm test:ragflow:real` 在缺配置时会跳过用例并以 0 退出，
 * 只看退出码的 CI 会把「没跑」判成「跑通」。本脚本把两件事都变成硬门禁：
 *
 * 1. 缺真实配置时：必须以非零退出，并且报错里明确列出缺失的配置项；
 * 2. 配置齐备时：真实联调必须以 0 退出。
 *
 * 用法：node tools/real-guard.mjs
 */
const REQUIRED = [
  'RAGFLOW_BASE_URL',
  'RAGFLOW_API_KEY',
  'RAGFLOW_API_VERSION',
  'RAGFLOW_TEST_PROJECT_ID',
  'RAGFLOW_EMBEDDING_MODEL',
  'RAGFLOW_EMBEDDING_REVISION',
  'RAGFLOW_IMAGE_DIGEST',
  'RAGFLOW_SOURCE_SHA',
];

const missing = REQUIRED.filter((name) => !process.env[name]);
const configured = missing.length === 0;

const result = spawnSync('pnpm', ['test:ragflow:real'], {
  env: { ...process.env, RUN_REAL_RAGFLOW: '1' },
  encoding: 'utf8',
  shell: process.platform === 'win32',
});

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
process.stdout.write(output);

if (configured) {
  if (result.status !== 0) {
    console.error('real layer must pass when the real RAGFlow configuration is complete');
    process.exit(1);
  }
  console.log('real layer ran against the configured upstream and passed');
  process.exit(0);
}

if (result.status === 0) {
  console.error(
    `real layer exited 0 without the real RAGFlow configuration; missing: ${missing.join(', ')}`,
  );
  process.exit(1);
}

if (!output.includes('required configuration is missing')) {
  console.error(
    `real layer failed for an unexpected reason; it must fail on the missing configuration: ${missing.join(', ')}`,
  );
  process.exit(1);
}

console.log(`real layer exits non-zero without configuration (missing: ${missing.join(', ')})`);
