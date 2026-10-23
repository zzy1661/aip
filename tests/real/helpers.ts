import { randomBytes } from 'node:crypto';
import {
  createRagFlowHttpClient,
  nodeTransport,
  type RawRequest,
  type RawResponse,
  type Transport,
} from '@aip/api';
import { createHarness, type Harness } from '../helpers/app.js';
import { TEST_DATABASE_URL } from '../helpers/db.js';

/**
 * 真实 RAGFlow 联调层。
 *
 * 规则：
 * - 未设置 RUN_REAL_RAGFLOW=1 时，本层报告 NOT RUN 并跳过（退出码 0）；
 * - 设置了 RUN_REAL_RAGFLOW=1 但配置不齐时，本层必须失败（退出码非 0），
 *   并列出缺失的配置项名称，绝不把「没跑」记成「跑通」。
 *
 * 本层验证的是平台与真实 RAGFlow 的闭环；身份使用进程内临时 HS256 密钥，
 * 不涉及任何真实凭据，真实凭据只有 RAGFLOW_API_KEY。
 */

/** 真实联调需要的全部配置项名称（用于缺失项报告）。 */
export const REAL_ENV_NAMES = [
  'RUN_REAL_RAGFLOW',
  'RAGFLOW_BASE_URL',
  'RAGFLOW_API_KEY',
  'RAGFLOW_API_VERSION',
  'RAGFLOW_TEST_PROJECT_ID',
  'RAGFLOW_EMBEDDING_MODEL',
  'RAGFLOW_EMBEDDING_REVISION',
  'RAGFLOW_IMAGE_DIGEST',
  'RAGFLOW_SOURCE_SHA',
] as const;

/** 除 RUN_REAL_RAGFLOW 之外必须齐备的配置项。 */
const REQUIRED_ENV_NAMES = REAL_ENV_NAMES.filter((name) => name !== 'RUN_REAL_RAGFLOW');

export interface RealEnv {
  baseUrl: string;
  apiKey: string;
  apiVersion: string;
  projectId: string;
  embeddingModel: string;
  embeddingRevision: string;
  imageDigest: string;
  sourceSha: string;
  databaseUrl: string;
  /** 解析等待上限（毫秒）。 */
  parseTimeoutMs: number;
}

export function isRealEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RUN_REAL_RAGFLOW === '1';
}

/** 返回缺失的配置项名称列表。 */
export function missingRealEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return REQUIRED_ENV_NAMES.filter((name) => !env[name]);
}

/**
 * 读取真实联调配置。
 *
 * 配置不齐时抛错并列出缺失项，让整层以非零退出码结束。
 */
export function loadRealEnv(env: NodeJS.ProcessEnv = process.env): RealEnv {
  const missing = missingRealEnv(env);
  if (missing.length > 0) {
    throw new Error(
      `RUN_REAL_RAGFLOW=1 but required configuration is missing: ${missing.join(', ')}`,
    );
  }
  if (env.RAGFLOW_API_VERSION !== 'v0.20.5') {
    throw new Error(
      `RAGFLOW_API_VERSION must be v0.20.5, got: ${env.RAGFLOW_API_VERSION ?? ''}`,
    );
  }
  return {
    baseUrl: env.RAGFLOW_BASE_URL!.replace(/\/+$/, ''),
    apiKey: env.RAGFLOW_API_KEY!,
    apiVersion: env.RAGFLOW_API_VERSION!,
    projectId: env.RAGFLOW_TEST_PROJECT_ID!,
    embeddingModel: env.RAGFLOW_EMBEDDING_MODEL!,
    embeddingRevision: env.RAGFLOW_EMBEDDING_REVISION!,
    imageDigest: env.RAGFLOW_IMAGE_DIGEST!,
    sourceSha: env.RAGFLOW_SOURCE_SHA!,
    databaseUrl: env.AIP_REAL_DATABASE_URL ?? TEST_DATABASE_URL,
    parseTimeoutMs: Number.parseInt(env.AIP_REAL_PARSE_TIMEOUT_MS ?? '600000', 10),
  };
}

export interface RealHarness extends Harness {
  /** 真实上游请求计数。 */
  realCallCount(): number;
}

/** 统计真实上游调用次数的传输包装。 */
function countingTransport(inner: Transport): { transport: Transport; count: () => number } {
  let calls = 0;
  return {
    transport: async (request: RawRequest): Promise<RawResponse> => {
      calls += 1;
      return inner(request);
    },
    count: () => calls,
  };
}

export async function createRealHarness(env: RealEnv): Promise<RealHarness> {
  const { transport, count } = countingTransport(nodeTransport);
  const ragflowClient = createRagFlowHttpClient({
    baseUrl: env.baseUrl,
    apiKey: env.apiKey,
    connectTimeoutMs: 5_000,
    readTimeoutMs: 30_000,
    uploadTimeoutMs: 120_000,
    readBudgetMs: 60_000,
    maxReadAttempts: 3,
    transport,
  });

  const harness = await createHarness({
    label: 'real',
    projectId: env.projectId,
    ragflowClient,
    verifySecret: randomBytes(32).toString('hex'),
    parseDeadlineMs: env.parseTimeoutMs,
    uploadMaxBytes: 20 * 1024 * 1024,
    // 真实联调必须落在独立库上：AIP_REAL_DATABASE_URL 未设置时退回默认测试库。
    databaseUrl: env.databaseUrl,
  });

  return { ...harness, realCallCount: count };
}

/** 等待知识版本进入终态：ready 或 failed。 */
export async function waitForKnowledgeReady(
  harness: RealHarness,
  token: string,
  knowledgeRef: string,
  version: string,
  timeoutMs: number,
): Promise<{ status: string; review_status: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: { status: string; review_status: string } = { status: 'unknown', review_status: 'unknown' };
  while (Date.now() < deadline) {
    await harness.advanceAll();
    const response = await harness.request({
      method: 'GET',
      path: `/knowledge/${knowledgeRef}/versions/${version}`,
      token,
    });
    if (response.status === 200) {
      last = {
        status: response.body.data.status,
        review_status: response.body.data.review_status,
      };
      if (last.status === 'ready' || last.status === 'failed') return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return last;
}
