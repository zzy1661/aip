import { makeConfig } from './vitest.shared.js';

/**
 * 真实 RAGFlow 联调层。
 *
 * 只有在显式 RUN_REAL_RAGFLOW=1 且必需配置齐备时才真正执行；
 * 配置缺失时本层必须非零退出，不允许把「被跳过」记成「联调通过」。
 */
export default makeConfig(['tests/real/**/*.test.ts']);
