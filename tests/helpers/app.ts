import http from 'node:http';
import type { Express } from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import {
  createApp,
  createKnowledgeService,
  createOperationsService,
  createRagFlowAdapter,
  createRagFlowHttpClient,
  createRegistryService,
  FileStore,
  Validator,
  knowledgeAuthorization,
  operationsRepository,
  withTransaction,
  type KnowledgeService,
  type OperationsService,
  type RagFlowHttpClient,
  type RegistryService,
} from '@aip/api';
import type { ConceptValidator, ConceptValidationOutcome } from '@aip/api';
import { createTestDatabase, type TestDatabase } from './db.js';
import { createTestVerifier, mintToken } from './auth.js';
import { startFakeRagFlow, type FakeRagFlow } from './ragflow.js';
import { appendTraceRecord, sha256Of } from '../../tools/report/context.js';
import { expect } from 'vitest';
import { decodeJwt } from 'jose';

export const TEST_PROJECT_ID = 'aip-test-project';

/** 可控的概念校验替身：默认放行，可切换为「本体不可用 / 概念不存在」。 */
export function makeConceptValidator(
  outcome: ConceptValidationOutcome = { ok: true },
): ConceptValidator {
  return {
    async validate() {
      return outcome;
    },
  };
}

export interface HarnessOptions {
  label?: string;
  projectId?: string;
  conceptOutcome?: ConceptValidationOutcome;
  /** 自定义概念校验器：用于验证「本体不可用即拒绝」这类分支。 */
  conceptValidator?: ConceptValidator;
  /** 真实集成层直接使用真实 RAGFlow 客户端；默认使用记录式替身。 */
  ragflowClient?: RagFlowHttpClient;
  /** 校验令牌用的 HS256 密钥；真实集成层用进程内临时密钥。 */
  verifySecret?: string;
  uploadMaxBytes?: number;
  retrievalMaxDocuments?: number;
  readBudgetMs?: number;
  maxReadAttempts?: number;
  readTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** 解析截止时间；用于验证超时终态。 */
  parseDeadlineMs?: number;
  /** 真实集成层用真实嵌入模型名；默认用替身值。 */
  embeddingModel?: string;
  /** 真实集成层用真实解析器配置；默认用替身值。 */
  parserConfig?: Record<string, unknown>;
  /** 记录在知识版本上的解析器来源摘要。 */
  parserHash?: string;
  /** 记录在知识版本上的嵌入模型修订号。 */
  embeddingRevision?: string;
  /** 操作租约时长；用于验证 epoch 栅栏与并发推进。 */
  operationLeaseMs?: number;
  /** 结果未知后的冷静期；设为 0 可让核对轮次立即可领取。 */
  unknownOutcomeDeferMs?: number;
  /** 测试库连接串；真实集成层用它指向独立库，不污染默认测试库。 */
  databaseUrl?: string;
}

export interface RequestOptions {
  method?: string;
  /** 相对项目根路径，例如 /assets。 */
  path: string;
  token?: string;
  json?: unknown;
  /** multipart 的普通字段。 */
  fields?: Record<string, string>;
  file?: { filename: string; contentType: string; content: Buffer | string };
  headers?: Record<string, string>;
  idempotencyKey?: string;
}

export interface HttpResult {
  status: number;
  headers: Headers;
  text: string;
  body: any;
}

export interface Harness {
  projectId: string;
  baseUrl: string;
  apiRoot: string;
  /** 暴露 Express 实例，供 OpenAPI 与实际路由表做一致性断言。 */
  app: Express;
  pool: Pool;
  db: TestDatabase;
  ragflow: FakeRagFlow;
  files: FileStore;
  operations: OperationsService;
  registry: RegistryService;
  knowledge: KnowledgeService;
  /** 捕获到的服务日志：用于「日志里不得出现密钥」这类断言。 */
  logs: Array<{ payload: unknown; message: string }>;
  token(options?: {
    subject?: string;
    permissions?: readonly string[];
    expiresInSeconds?: number;
    signedWith?: string;
  }): Promise<string>;
  request(options: RequestOptions): Promise<HttpResult>;
  /** 重启 API 进程：数据库与文件存储保持不变，HTTP 服务重建。 */
  restart(): Promise<void>;
  /** 跑一次 worker 推进，把待处理操作推进到终态。 */
  advanceAll(): Promise<void>;
  close(): Promise<void>;
}

const REPORT_MODE = process.env.AIP_REPORT_MODE ?? 'unknown';

/**
 * 主体角色标签。
 *
 * 报告里的「主体角色」字段：按权限集粗分角色，便于复核时确认用例覆盖了哪类主体。
 */
function roleOf(permissions: string[]): string {
  if (permissions.includes('knowledge:manage') || permissions.includes('asset:manage')) {
    return 'manager';
  }
  if (permissions.includes('knowledge:review')) return 'reviewer';
  if (permissions.includes('knowledge:write') || permissions.includes('asset:write')) return 'writer';
  if (permissions.length === 0) return 'no-permission';
  return 'reader';
}

/**
 * 记录一次请求的运行期事实：主体角色、trace_id 与请求样例哈希。
 *
 * reporter 跑在主进程，看不到 worker 里的令牌与响应头，
 * 这些事实只能由发起请求的进程写出来。
 */
function recordRequestFact(
  options: RequestOptions,
  response: { status: number; headers: Headers },
  body: unknown,
): void {
  const state = expect.getState();
  let subject = 'anonymous';
  let permissions: string[] = [];
  if (options.token) {
    try {
      const claims = decodeJwt(options.token);
      if (typeof claims.sub === 'string') subject = claims.sub;
      if (Array.isArray(claims.permissions)) {
        permissions = claims.permissions.filter(
          (entry): entry is string => typeof entry === 'string',
        );
      }
    } catch {
      // 令牌不可解析时按匿名主体记录，不影响用例结论。
    }
  }
  appendTraceRecord(REPORT_MODE, {
    kind: 'request',
    case: state.currentTestName ?? '',
    test_path: state.testPath ?? '',
    method: options.method ?? 'GET',
    path: options.path,
    status: response.status,
    trace_id: response.headers.get('x-trace-id') ?? '',
    subject_role: `${subject}/${roleOf(permissions)}`,
    permissions,
    sample_hash: sha256Of(typeof body === 'string' ? body : JSON.stringify(body ?? null)),
  });
}

function buildMultipart(
  file: { filename: string; contentType: string; content: Buffer | string },
  fields: Record<string, string>,
): { body: Buffer; contentType: string } {
  const boundary = `----aip-test${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.contentType}\r\n\r\n`,
      'utf8',
    ),
  );
  parts.push(Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8'));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const projectId = options.projectId ?? TEST_PROJECT_ID;
  const db = await createTestDatabase(options.label ?? 'case', options.databaseUrl);
  const fileRoot = await mkdtemp(join(tmpdir(), 'aip-test-files-'));
  const ragflow = await startFakeRagFlow();

  const files = new FileStore(fileRoot);
  const validator = new Validator();

  const ragflowHttp =
    options.ragflowClient ??
    createRagFlowHttpClient({
      baseUrl: ragflow.url,
      apiKey: 'test-api-key',
      connectTimeoutMs: options.connectTimeoutMs ?? 1000,
      readTimeoutMs: options.readTimeoutMs ?? 2000,
      uploadTimeoutMs: 5000,
      readBudgetMs: options.readBudgetMs ?? 5000,
      maxReadAttempts: options.maxReadAttempts ?? 3,
    });

  const adapter = createRagFlowAdapter({
    http: ragflowHttp,
    embeddingModel: options.embeddingModel ?? 'test-embedding-model',
    parserConfig: options.parserConfig ?? { layout_parser: { model: 'test' } },
    chunkMethod: 'naive',
    similarityThreshold: 0.2,
    vectorSimilarityWeight: 0.3,
    topK: 64,
  });

  const operations = createOperationsService({
    pool: db.pool,
    ragflow: adapter,
    files,
    parseDeadlineMs: options.parseDeadlineMs ?? 60_000,
    leaseMs: options.operationLeaseMs ?? 40_000,
    unknownOutcomeDeferMs: options.unknownOutcomeDeferMs,
    parserHash: options.parserHash ?? 'test-parser-sha',
    embeddingRevision: options.embeddingRevision ?? 'test-embedding-revision',
  });

  const registry = createRegistryService({
    pool: db.pool,
    validator,
    concepts:
      options.conceptValidator ?? makeConceptValidator(options.conceptOutcome ?? { ok: true }),
  });

  const knowledge = createKnowledgeService({
    pool: db.pool,
    validator,
    ragflow: adapter,
    operations,
    files,
    limits: {
      uploadMaxBytes: options.uploadMaxBytes ?? 20 * 1024 * 1024,
      retrievalMaxDocuments: options.retrievalMaxDocuments ?? 200,
      parseDeadlineMs: options.parseDeadlineMs ?? 60_000,
    },
    parserHash: options.parserHash ?? 'test-parser-sha',
    embeddingRevision: options.embeddingRevision ?? 'test-embedding-revision',
  });

  const logs: Array<{ payload: unknown; message: string }> = [];

  const app = createApp({
    projectId,
    verifier: createTestVerifier(options.verifySecret),
    isDenied: (scope, subject) => knowledgeAuthorization.isDenied(db.pool, scope, subject),
    registry,
    knowledge,
    logger: {
      error(payload, message) {
        logs.push({ payload, message });
        console.error(`[harness] ${message}`, payload);
      },
    },
  });

  let server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  let baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const apiRoot = `/api/v1/projects/${projectId}`;

  async function request(requestOptions: RequestOptions): Promise<HttpResult> {
    const headers: Record<string, string> = { ...(requestOptions.headers ?? {}) };
    if (requestOptions.token) headers.authorization = `Bearer ${requestOptions.token}`;
    if (requestOptions.idempotencyKey) {
      headers['idempotency-key'] = requestOptions.idempotencyKey;
    }

    let body: NonNullable<RequestInit['body']> | undefined;
    if (requestOptions.file) {
      const multipart = buildMultipart(requestOptions.file, requestOptions.fields ?? {});
      headers['content-type'] = multipart.contentType;
      body = multipart.body;
    } else if (requestOptions.fields) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(requestOptions.fields).toString();
    } else if (requestOptions.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(requestOptions.json);
    }

    const response = await fetch(`${baseUrl}${apiRoot}${requestOptions.path}`, {
      method: requestOptions.method ?? 'GET',
      headers,
      body,
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    recordRequestFact(requestOptions, response, body);
    return { status: response.status, headers: response.headers, text, body: parsed };
  }

  return {
    projectId,
    baseUrl,
    apiRoot,
    app,
    pool: db.pool,
    db,
    ragflow,
    files,
    operations,
    registry,
    knowledge,
    /** 捕获到的服务日志：用于「日志里不得出现密钥」这类断言。 */
    logs,
    async token(tokenOptions = {}) {
      return mintToken({
        subject: tokenOptions.subject ?? 'user-1',
        scope: projectId,
        permissions: tokenOptions.permissions ?? [],
        ...(tokenOptions.expiresInSeconds === undefined
          ? {}
          : { expiresInSeconds: tokenOptions.expiresInSeconds }),
        ...(tokenOptions.signedWith === undefined && options.verifySecret === undefined
          ? {}
          : { signedWith: tokenOptions.signedWith ?? options.verifySecret }),
      });
    },
    request,
    /** 重启 API 进程：丢弃 HTTP 服务重建，数据库与文件存储保持不变。 */
    async restart(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    /**
     * 推进待处理操作。
     *
     * 解析类操作在上游完成前会一直停在 in_progress，因此收敛判据是
     * 「本轮没有任何操作的状态发生变化」，而不是「没有待处理操作」。
     */
    async advanceAll(): Promise<void> {
      const states = new Map<string, string>();
      for (let round = 0; round < 12; round += 1) {
        const claimable = await withTransaction(db.pool, (client) =>
          operationsRepository.listClaimableOperations(client, projectId, 50),
        );
        if (claimable.length === 0) return;
        let changed = false;
        for (const operation of claimable) {
          const before = states.get(operation.id);
          const result = await operations.advance(operation.id, projectId);
          if (before !== result.state) {
            states.set(operation.id, result.state);
            changed = true;
          }
        }
        if (!changed) return;
      }
      throw new Error('operations did not settle within the expected number of rounds');
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await ragflow.close();
      await db.close();
      await rm(fileRoot, { recursive: true, force: true });
    },
  };
}
