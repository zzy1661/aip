import { describe, expect, it } from 'vitest';
import { isSemver, PERMISSIONS } from '@aip/contracts';
import { createPool } from '@aip/api';

describe('测试基础设施', () => {
  it('能解析 @aip/contracts 源码', () => {
    expect(isSemver('1.0.0')).toBe(true);
    expect(PERMISSIONS).toContain('asset:bind');
  });

  it('能解析 @aip/api 源码', () => {
    expect(typeof createPool).toBe('function');
  });
});
