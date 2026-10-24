import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createRagFlowHttpClient,
  RagFlowUnavailableError,
  type RagFlowHttpClient,
} from '@aip/api';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import {
  createReadyKnowledgeBase,
  prepareApprovedDocument,
  seedRetrievalChunk,
  uploadSampleDocument,
} from '../helpers/flow.js';

/**
 * M19：只读重试预算与上游故障分类。
 *
 * 断言口径：
 * - 429 必须按 Retry-After 退避后重试，等待时间由上游给定的 Retry-After 决定；
 * - 等待时间不得越过只读预算：预算耗尽即放弃，不能把总耗时拖到预算之外；
 * - 故障分类必须区分「未送达」（连接被拒，可安全重试）与「送达未知」（写响应丢失，禁止盲重发）；
 * - 错误响应不得泄露上游 API key、上游原始报文与文件正文，且 trace_id 必须可核对。
 */

/** 找一个当前没有监听者的端口，用来稳定复现「连接被拒」。 */
async function findClosedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

/**
 * 起一个只回响应头、不回正文的上游。
 *
 * 这是「请求已送达上游、正文没有回来」的真实形态：读超时必须由它触发，
 * 否则「读超时属于已送达」这条分类无法被验证。
 */
async function startHeaderOnlyUpstream(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on('data', () => {
      socket.write(
        'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 64\r\n\r\n',
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

describe('M19 只读重试预算与故障分类', () => {
  let harness: Harness;
  let refusedHarness: Harness;
  let token: string;

  const READ_BUDGET_MS = 2_500;
  const MAX_READ_ATTEMPTS = 3;

  beforeAll(async () => {
    harness = await createHarness({
      label: 'm19retry',
      readBudgetMs: READ_BUDGET_MS,
      maxReadAttempts: MAX_READ_ATTEMPTS,
      readTimeoutMs: 2_000,
      connectTimeoutMs: 1_000,
    });
    token = await harness.token({ permissions: ALL_PERMISSIONS });

    // 上游端口没有监听者：连接在建立前就失败，属于「确定没有送达」。
    const closedPort = await findClosedPort();
    refusedHarness = await createHarness({
      label: 'm19refused',
      ragflowClient: createRagFlowHttpClient({
        baseUrl: `http://127.0.0.1:${closedPort}`,
        apiKey: 'test-api-key',
        connectTimeoutMs: 500,
        readTimeoutMs: 500,
        uploadTimeoutMs: 1_000,
        readBudgetMs: 1_000,
        maxReadAttempts: 1,
      }),
    });
  });

  afterAll(async () => {
    await harness.close();
    await refusedHarness.close();
  });

  /** 造一个直连上游的客户端，用于断言故障分类本身。 */
  function createProbeClient(baseUrl: string): RagFlowHttpClient {
    return createRagFlowHttpClient({
      baseUrl,
      apiKey: 'test-api-key',
      connectTimeoutMs: 1_000,
      readTimeoutMs: 300,
      uploadTimeoutMs: 1_000,
      readBudgetMs: 1_000,
      maxReadAttempts: 1,
    });
  }

  /** 造一个可检索的知识库：文档已解析、已审核，并播种一条上游分块。 */
  async function prepareRetrieval(
    target: Harness,
    label: string,
  ): Promise<{ kbId: string }> {
    const { kbId } = await createReadyKnowledgeBase(target, token, label);
    const document = await prepareApprovedDocument(target, token, kbId, { marker: label });
    seedRetrievalChunk(target, {
      documentId: document.documentId,
      datasetId: document.datasetId,
      content: label,
    });
    return { kbId };
  }

  function retrievalCalls(target: Harness): number {
    return target.ragflow.calls.filter(
      (call) => call.method === 'POST' && call.path === '/api/v1/retrieval',
    ).length;
  }

  it('上游 429 且带 Retry-After 时按 Retry-After 退避后重试成功', async () => {
    harness.ragflow.reset();
    const { kbId } = await prepareRetrieval(harness, 'M19-RETRY-AFTER');
    harness.ragflow.enqueue(
      (call) => call.method === 'POST' && call.path === '/api/v1/retrieval',
      {
        status: 429,
        body: { code: 429, data: null, message: 'slow down' },
        headers: { 'retry-after': '1' },
      },
    );

    const startedAt = Date.now();
    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M19-RETRY-AFTER', kb_ids: [kbId] },
    });
    const elapsed = Date.now() - startedAt;

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('authorized_evidence');
    expect(retrievalCalls(harness)).toBe(2);
    // 默认退避只有 250ms：等待达到 1s 说明等待时间由上游的 Retry-After 决定。
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
    expect(elapsed).toBeLessThan(READ_BUDGET_MS);
  });

  it('Retry-After 超出剩余预算时立即放弃，不做超预算等待', async () => {
    harness.ragflow.reset();
    const { kbId } = await prepareRetrieval(harness, 'M19-RETRY-OVER-BUDGET');
    harness.ragflow.enqueue(
      (call) => call.method === 'POST' && call.path === '/api/v1/retrieval',
      {
        status: 429,
        body: { code: 429, data: null, message: 'slow down' },
        headers: { 'retry-after': '30' },
      },
    );

    const startedAt = Date.now();
    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M19-RETRY-OVER-BUDGET', kb_ids: [kbId] },
    });
    const elapsed = Date.now() - startedAt;

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('RAGFLOW_UNAVAILABLE');
    // Retry-After 是 30s，但只读预算只有 2.5s：不能真的等 30s。
    expect(elapsed).toBeLessThan(2_000);
    expect(retrievalCalls(harness)).toBe(1);
  });

  it('上游持续 429 时尝试次数有上限，总耗时不超过只读预算', async () => {
    harness.ragflow.reset();
    const { kbId } = await prepareRetrieval(harness, 'M19-RETRY-BUDGET');
    harness.ragflow.enqueue(
      (call) => call.method === 'POST' && call.path === '/api/v1/retrieval',
      { status: 429, body: { code: 429, data: null, message: 'slow down' } },
      10,
    );

    const startedAt = Date.now();
    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M19-RETRY-BUDGET', kb_ids: [kbId] },
    });
    const elapsed = Date.now() - startedAt;

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('RAGFLOW_UNAVAILABLE');
    expect(retrievalCalls(harness)).toBeLessThanOrEqual(MAX_READ_ATTEMPTS);
    expect(retrievalCalls(harness)).toBeGreaterThan(1);
    expect(elapsed).toBeLessThan(READ_BUDGET_MS);
  });

  it('写响应丢失时只发一次创建请求，操作进入结果未知', async () => {
    harness.ragflow.reset();
    harness.ragflow.dropNext(
      (call) => call.method === 'POST' && call.path === '/api/v1/datasets',
    );

    const created = await harness.request({
      method: 'POST',
      path: '/knowledge-bases',
      token,
      idempotencyKey: `kb-${Math.random().toString(36).slice(2, 10)}`,
      json: { name: 'M19 写响应丢失', description: '' },
    });
    expect(created.status).toBe(202);
    const kbId = created.body.data.kb_id as string;
    const operationId = created.body.data.operation_id as string;

    await harness.advanceAll();

    const operation = await harness.request({
      method: 'GET',
      path: `/operations/${operationId}`,
      token,
    });
    expect(operation.body.data.state).toBe('unknown_outcome');
    expect(operation.body.data.last_error).toBe(
      'upstream write response was not confirmed',
    );

    const kb = await harness.request({
      method: 'GET',
      path: `/knowledge-bases/${kbId}`,
      token,
    });
    expect(kb.body.data.status).toBe('unknown_outcome');
    expect(kb.body.data.ragflow_dataset_id).toBeNull();

    const createCalls = harness.ragflow.calls.filter(
      (call) => call.method === 'POST' && call.path === '/api/v1/datasets',
    ).length;
    expect(createCalls).toBe(1);
  });

  it('连接被拒（确定没有送达）时操作留在 in_progress，允许安全重试', async () => {
    refusedHarness.ragflow.reset();
    const created = await refusedHarness.request({
      method: 'POST',
      path: '/knowledge-bases',
      token,
      idempotencyKey: `kb-${Math.random().toString(36).slice(2, 10)}`,
      json: { name: 'M19 连接被拒', description: '' },
    });
    expect(created.status).toBe(202);
    const kbId = created.body.data.kb_id as string;
    const operationId = created.body.data.operation_id as string;

    await refusedHarness.advanceAll();

    const operation = await refusedHarness.request({
      method: 'GET',
      path: `/operations/${operationId}`,
      token,
    });
    expect(operation.body.data.state).toBe('in_progress');
    expect(operation.body.data.state).not.toBe('failed');
    expect(operation.body.data.last_error).toContain('connection failed');
    expect(operation.body.data.last_error).toContain('temporarily unavailable');
    expect(operation.body.data.attempt).toBe(1);

    // 未送达可以安全重发：资源状态不得被回落到失败。
    const kb = await refusedHarness.request({
      method: 'GET',
      path: `/knowledge-bases/${kbId}`,
      token,
    });
    expect(kb.body.data.status).toBe('creating');
  });

  it('读请求的响应丢失时操作留在 in_progress，可以安全重试', async () => {
    harness.ragflow.reset();
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M19 读响应丢失');
    const uploaded = await uploadSampleDocument(harness, token, kbId, {
      marker: 'M19-READ-LOST',
    });

    // 状态轮询的响应丢失：请求已送达上游，只是回包没了。
    // 只读操作可以安全重试，操作不得落成失败。
    harness.ragflow.dropNext(
      (call) =>
        call.method === 'GET' &&
        call.path.endsWith('/documents') &&
        call.query.id !== undefined,
    );
    await harness.advanceAll();

    const { rows } = await harness.pool.query<{ id: string }>(
      `SELECT id FROM operation
        WHERE kind = 'document.parse' AND resource_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [uploaded.knowledgeRef],
    );
    const operationId = rows[0]?.id;
    expect(operationId).toBeTruthy();

    const operation = await harness.request({
      method: 'GET',
      path: `/operations/${operationId}`,
      token,
    });
    expect(operation.body.data.state).toBe('in_progress');
    expect(operation.body.data.state).not.toBe('failed');
    expect(operation.body.data.state).not.toBe('unknown_outcome');

    // 响应丢失后必须重发过一次只读轮询。
    const statusPolls = harness.ragflow.calls.filter(
      (call) =>
        call.method === 'GET' && call.path.endsWith('/documents') && call.query.id !== undefined,
    ).length;
    expect(statusPolls).toBeGreaterThanOrEqual(2);
  });

  it('读超时判为「已送达但没有回包」，连接失败判为「未送达」', async () => {
    const upstream = await startHeaderOnlyUpstream();
    const closedPort = await findClosedPort();

    let timeoutError: unknown = null;
    try {
      await createProbeClient(`http://127.0.0.1:${upstream.port}`).execute({
        method: 'GET',
        path: 'datasets',
        idempotentRead: true,
      });
    } catch (error) {
      timeoutError = error;
    }
    let refusedError: unknown = null;
    try {
      await createProbeClient(`http://127.0.0.1:${closedPort}`).execute({
        method: 'GET',
        path: 'datasets',
        idempotentRead: true,
      });
    } catch (error) {
      refusedError = error;
    }
    await upstream.close();

    expect(timeoutError).toBeInstanceOf(RagFlowUnavailableError);
    expect((timeoutError as RagFlowUnavailableError).kind).toBe('delivered_unknown');
    expect((timeoutError as RagFlowUnavailableError).reason).toBe('read timeout');

    expect(refusedError).toBeInstanceOf(RagFlowUnavailableError);
    expect((refusedError as RagFlowUnavailableError).kind).toBe('not_delivered');
    expect((refusedError as RagFlowUnavailableError).reason).toBe('connection failed');
  });

  it('错误响应不泄露上游 API key、上游原始报文与文件正文', async () => {
    harness.ragflow.reset();
    const { kbId } = await prepareRetrieval(harness, 'M19-NO-LEAK');
    harness.ragflow.enqueue(
      (call) => call.method === 'POST' && call.path === '/api/v1/retrieval',
      {
        status: 401,
        body: {
          code: 401,
          data: null,
          message: 'UPSTREAM-SECRET-MARKER test-api-key rejected',
        },
      },
    );

    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M19-NO-LEAK', kb_ids: [kbId] },
    });

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('RAGFLOW_UNAVAILABLE');
    expect(response.text).not.toContain('UPSTREAM-SECRET-MARKER');
    expect(response.text).not.toContain('test-api-key');

    // 文件正文同样不得出现在任何对调用方可见的错误结论里。
    const marker = 'M19-FILE-BODY-SECRET-MARKER';
    harness.ragflow.reset();
    const { kbId: uploadKbId } = await createReadyKnowledgeBase(harness, token, 'M19 文件泄露');
    harness.ragflow.enqueue(
      (call) =>
        call.method === 'POST' && call.path.endsWith('/documents') && call.query.id === undefined,
      {
        status: 401,
        body: { code: 401, data: null, message: `upload rejected ${marker}` },
      },
    );
    const uploaded = await uploadSampleDocument(harness, token, uploadKbId, { marker });
    await harness.advanceAll();

    const uploadOperation = await harness.request({
      method: 'GET',
      path: `/operations/${uploaded.operationId}`,
      token,
    });
    expect(uploadOperation.body.data.state).toBe('failed');
    expect(uploadOperation.body.data.last_error).toBe(
      'upstream rejected the platform credential',
    );
    expect(uploadOperation.text).not.toContain(marker);
    expect(String(uploadOperation.body.data.last_error)).not.toContain(marker);
    expect(String(uploadOperation.body.data.last_error)).not.toContain('test-api-key');
  });

  it('错误体的 trace_id 非空且与 x-trace-id 响应头一致', async () => {
    harness.ragflow.reset();
    const { kbId } = await prepareRetrieval(harness, 'M19-TRACE');
    harness.ragflow.enqueue(
      (call) => call.method === 'POST' && call.path === '/api/v1/retrieval',
      { status: 401, body: { code: 401, data: null, message: 'invalid api key' } },
    );

    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M19-TRACE', kb_ids: [kbId] },
    });

    expect(response.status).toBe(503);
    expect(typeof response.body.trace_id).toBe('string');
    expect(response.body.trace_id.length).toBeGreaterThan(0);
    expect(response.body.trace_id).toBe(response.headers.get('x-trace-id'));
  });
});
