import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '@aip/api';

/**
 * M-2：操作租约必须覆盖单轮推进的最坏耗时。
 *
 * 租约短于最坏耗时，处理途中租约就会到期，同一个操作会被第二个 worker
 * 重新领取，两个 worker 同时推进同一个写操作。
 */
describe('M-2 操作租约边界', () => {
  const baseEnv = {
    NODE_ENV: 'test',
    AUTH_MODE: 'hs256',
    AUTH_HS256_SECRET: 'test-secret',
    AIP_PROJECT_ID: 'project',
    DATABASE_URL: 'postgres://localhost/test',
    AIP_FILE_STORE_ROOT: '/tmp/aip-test',
    OIDC_ISSUER: 'https://issuer.invalid',
    OIDC_AUDIENCE: 'aip',
    RAGFLOW_BASE_URL: 'http://ragflow.invalid',
    RAGFLOW_API_KEY: 'key',
    RAGFLOW_API_VERSION: 'v0.20.5',
  };

  it('默认租约大于上传超时 + 只读预算 + 余量', () => {
    const config = loadConfig({ ...baseEnv } as NodeJS.ProcessEnv);
    expect(config.limits.operationLeaseMs).toBeGreaterThan(
      config.ragflow.uploadTimeoutMs + config.ragflow.readBudgetMs,
    );
  });

  it('显式配置过短的租约在启动时直接失败', () => {
    expect(() =>
      loadConfig({ ...baseEnv, AIP_OPERATION_LEASE_MS: '1000' } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError);
  });

  it('显式配置足够的租约被接受', () => {
    const config = loadConfig({
      ...baseEnv,
      AIP_OPERATION_LEASE_MS: '180000',
    } as NodeJS.ProcessEnv);
    expect(config.limits.operationLeaseMs).toBe(180000);
  });
});
