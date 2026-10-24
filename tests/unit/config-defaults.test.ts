import { describe, expect, it } from 'vitest';
import { loadConfig } from '@aip/api';

/**
 * M14 / m-16：生产默认值的真实取值。
 *
 * 解析截止时间这类判据此前只在测试替身里用 `parseDeadlineMs: 1` 验证过，
 * 生产默认值本身没有断言。这里把默认值钉死，避免「测试通过但生产是另一个值」。
 */
const BASE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  RAGFLOW_API_VERSION: 'v0.20.5',
  RAGFLOW_BASE_URL: 'https://ragflow.test',
  RAGFLOW_API_KEY: 'test-key',
  AIP_PROJECT_ID: 'test-project',
  DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
  AIP_FILE_STORE_ROOT: '/tmp/aip-test-files',
  OIDC_ISSUER: 'https://issuer.test',
  OIDC_AUDIENCE: 'aip-test',
};

describe('生产默认配置', () => {
  it('解析截止时间默认 20 分钟', () => {
    const config = loadConfig(BASE_ENV);
    expect(config.limits.parseDeadlineMs).toBe(1_200_000);
  });

  it('解析截止时间可由环境变量覆盖', () => {
    const config = loadConfig({ ...BASE_ENV, AIP_PARSE_DEADLINE_MS: '60000' });
    expect(config.limits.parseDeadlineMs).toBe(60_000);
  });

  it('只读总预算默认 30 秒，最多 3 次尝试', () => {
    const config = loadConfig(BASE_ENV);
    expect(config.ragflow.readBudgetMs).toBe(30_000);
    expect(config.ragflow.maxReadAttempts).toBe(3);
  });

  it('操作租约必须长于单轮推进的最坏耗时', () => {
    const config = loadConfig(BASE_ENV);
    const processing =
      config.ragflow.uploadTimeoutMs + config.ragflow.readBudgetMs;
    // 租约必须大于「一次上传 + 一次只读核对」的耗时，否则处理途中会被第二个 worker 领取。
    expect(config.limits.operationLeaseMs).toBeGreaterThan(processing);
    // 默认值还要额外留出 30 秒余量。
    expect(config.limits.operationLeaseMs).toBeGreaterThanOrEqual(processing + 30_000);
  });

  it('租约短于最坏耗时时直接拒绝启动', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, AIP_OPERATION_LEASE_MS: '1000' }),
    ).toThrow(/worst-case round duration/);
  });

  it('上传上限默认 20 MiB，可授权文档默认 200', () => {
    const config = loadConfig(BASE_ENV);
    expect(config.limits.uploadMaxBytes).toBe(20 * 1024 * 1024);
    expect(config.limits.retrievalMaxDocuments).toBe(200);
  });
});
