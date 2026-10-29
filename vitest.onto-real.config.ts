import { makeConfig } from './vitest.shared.js';

/**
 * 真实本体联调层。
 *
 * 与 RAGFlow 的真实层分开：那一层验证知识库闭环，这一层验证**本体概念校验门**
 * 的两条证据（概念存在且已发布 → 通过；概念不存在 → 422）。
 *
 * 只有显式 `RUN_REAL_ONTO=1` 且 `ONTO_BASE_URL` 齐备时才真正执行；
 * 配置缺失时本层必须非零退出，不允许把「被跳过」记成「联调通过」。
 */
export default makeConfig(['tests/onto-real/**/*.test.ts'], {
  mode: 'onto-real',
  testTimeoutMs: 60_000,
});
