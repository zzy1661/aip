import { describe, expect, it } from 'vitest';
import { classifyReview } from '@aip/api';

/**
 * ZACH-17 裁决 (a)：审核结论的状态机。
 *
 * `approved` 是终态：
 * - 从 approved 出发的改判（approved → rejected）一律 forbidden；
 * - 从 approved 出发的同结论重放（approved → approved）按幂等处理；
 * - 尚未批准的版本（pending / rejected）保持原有行为，两种结论都照常落库。
 */
describe('审核结论状态机', () => {
  it('pending 的两种结论都照常落库', () => {
    expect(classifyReview('pending', 'approved')).toBe('apply');
    expect(classifyReview('pending', 'rejected')).toBe('apply');
  });

  it('rejected 的两种结论都照常落库（可以重新审核）', () => {
    expect(classifyReview('rejected', 'approved')).toBe('apply');
    expect(classifyReview('rejected', 'rejected')).toBe('apply');
  });

  it('已批准的版本不能被改判为拒绝', () => {
    expect(classifyReview('approved', 'rejected')).toBe('forbidden');
  });

  it('已批准的版本同结论重放按幂等处理', () => {
    expect(classifyReview('approved', 'approved')).toBe('idempotent');
  });
});
