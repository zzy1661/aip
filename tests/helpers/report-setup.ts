import { afterEach, expect } from 'vitest';
import { appendTraceRecord } from '../../tools/report/context.js';

/**
 * 运行期记录：每个用例结束时记下断言计数。
 *
 * reporter 跑在主进程，拿不到 worker 里的断言计数，
 * 只能由用例所在进程写出来再合并。
 */
const mode = process.env.AIP_REPORT_MODE ?? 'unknown';

afterEach(() => {
  const state = expect.getState();
  appendTraceRecord(mode, {
    kind: 'case',
    case: state.currentTestName ?? '',
    test_path: state.testPath ?? '',
    assertion_count: state.assertionCalls ?? 0,
  });
});
