import { makeConfig } from './vitest.shared.js';

/**
 * 真实 RAGFlow 联调层。
 *
 * 只有在显式 RUN_REAL_RAGFLOW=1 且必需配置齐备时才真正执行；
 * 配置缺失时本层必须非零退出，不允许把「被跳过」记成「联调通过」。
 *
 * 单个用例的超时放宽到 3 分钟：真实上游的解析任务要跑 OCR 与版面分析，
 * 远超替身层的毫秒级响应，超时太紧会把「上游还在解析」误判成失败。
 */
export default makeConfig(['tests/real/**/*.test.ts'], {
  mode: 'real',
  testTimeoutMs: 180_000,
});
