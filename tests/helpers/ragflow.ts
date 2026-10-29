import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * 固定版本 RAGFlow 的测试替身。
 *
 * 只实现适配器用到的最小协议投影，并完整记录每一个到达的 HTTP 请求，
 * 以便断言「空授权时出口请求数为 0」这类不能靠日志推断的行为。
 */

export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
  authorization: string | undefined;
}

export interface FakeResponse {
  status: number;
  /** JSON 响应体。 */
  body?: unknown;
  /** 原始文本响应体；与 body 二选一。 */
  raw?: string;
  headers?: Record<string, string>;
  /** 记录请求后直接断开连接，模拟「响应丢失」。 */
  drop?: boolean;
  /** 响应前延迟，用于超时与竞态场景。 */
  delayMs?: number;
  /**
   * 挂起：上游已经受理请求（文档已登记），但永远不返回响应。
   *
   * 与 drop 的区别：drop 是「请求没送达」，hang 是「请求已送达、结果未回」。
   * 崩溃恢复用例要落在后者上：发送意图已落库、上游已有同名文档，
   * 只有响应没回来，接管者才能靠只读核对认领而不是重传。
   */
  hang?: boolean;
}

export interface FakeDataset {
  id: string;
  name: string;
  description: string;
}

export interface FakeDocument {
  id: string;
  datasetId: string;
  name: string;
  run: string;
  progress: number | null;
  chunk_count: number | null;
  progress_msg: string;
  content: string;
}

export interface FakeChunk {
  id: string;
  content: string;
  document_id: string;
  dataset_id: string;
  similarity?: number;
  positions?: unknown[] | null;
}

interface QueuedResponse {
  match: (call: RecordedCall) => boolean;
  response: FakeResponse;
  remaining: number;
}

export interface FakeRagFlow {
  url: string;
  calls: RecordedCall[];
  /**
   * 当前还开着的连接数。
   *
   * 进程被 SIGKILL 之后，它在上游这边的连接必须一起消失：
   * 用它证明「那个进程真的没了」，而不只是「pid 被回收了」。
   */
  openConnections(): number;
  datasets: Map<string, FakeDataset>;
  documents: Map<string, FakeDocument>;
  retrievalChunks: FakeChunk[];
  enqueue(match: (call: RecordedCall) => boolean, response: FakeResponse, times?: number): void;
  dropNext(match: (call: RecordedCall) => boolean): void;
  reset(): void;
  close(): Promise<void>;
}

function envelope(data: unknown, message = 'success'): { code: number; data: unknown; message: string } {
  return { code: 0, data, message };
}

function parseQuery(raw: string): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(raw)) {
    query[key] = value;
  }
  return query;
}

/** 极简 multipart 解析：只需要文件名与内容，用于验证上传确实是单个 file 字段。 */
function parseMultipart(
  body: string,
  contentType: string,
): Array<{ name: string; filename: string; contentType: string; content: string }> {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) return [];
  const parts = body.split(`--${boundary}`);
  const result: Array<{ name: string; filename: string; contentType: string; content: string }> = [];
  for (const part of parts) {
    const separator = part.indexOf('\r\n\r\n');
    if (separator < 0) continue;
    const headers = part.slice(0, separator);
    let content = part.slice(separator + 4);
    if (content.endsWith('\r\n')) content = content.slice(0, -2);
    const disposition = /name="([^"]*)"(?:; filename="([^"]*)")?/.exec(headers);
    if (!disposition) continue;
    const type = /Content-Type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() ?? '';
    result.push({
      name: disposition[1] ?? '',
      filename: disposition[2] ?? '',
      contentType: type,
      content,
    });
  }
  return result;
}

export async function startFakeRagFlow(): Promise<FakeRagFlow> {
  const calls: RecordedCall[] = [];
  const datasets = new Map<string, FakeDataset>();
  const documents = new Map<string, FakeDocument>();
  const queue: QueuedResponse[] = [];
  const retrievalChunks: FakeChunk[] = [];
  let counter = 0;
  /** 挂起标记：只在本轮路由处理期间为真（路由处理是同步的）。 */
  let hanging = false;
  const nextId = (prefix: string): string => {
    counter += 1;
    return `${prefix}-${String(counter).padStart(4, '0')}`;
  };

  function sendFake(res: http.ServerResponse, response: FakeResponse): void {
    if (hanging) {
      // 上游已受理请求（副作用已落库），但响应永不写出：客户端会一直等下去。
      return;
    }
    if (response.drop) {
      res.socket?.destroy();
      return;
    }
    if (response.delayMs) {
      setTimeout(() => writeFake(res, response), response.delayMs);
      return;
    }
    writeFake(res, response);
  }

  function writeFake(res: http.ServerResponse, response: FakeResponse): void {
    if (res.writableEnded) return;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(response.headers ?? {}),
    };
    if (response.raw !== undefined) {
      headers['content-type'] = 'text/plain';
      res.writeHead(response.status, headers);
      res.end(response.raw);
      return;
    }
    res.writeHead(response.status, headers);
    res.end(JSON.stringify(response.body ?? null));
  }

  function respond(res: http.ServerResponse, call: RecordedCall): void {
    const { method, path } = call;

    if (method === 'POST' && path === '/api/v1/datasets') {
      const body = JSON.parse(call.body || '{}') as { name?: string; description?: string };
      const dataset: FakeDataset = {
        id: nextId('ds'),
        name: body.name ?? '',
        description: body.description ?? '',
      };
      datasets.set(dataset.id, dataset);
      sendFake(res, { status: 200, body: envelope({ id: dataset.id }) });
      return;
    }

    if (method === 'GET' && path === '/api/v1/datasets') {
      const name = call.query.name;
      const data = [...datasets.values()]
        .filter((dataset) => (name === undefined ? true : dataset.name === name))
        .map((dataset) => ({ id: dataset.id, name: dataset.name }));
      if (name !== undefined && data.length === 0) {
        // 与上游一致：按名称过滤零命中时返回 PERMISSION_ERROR，不是空数组。
        sendFake(res, {
          status: 200,
          body: { code: 108, data: null, message: `lacks permission for dataset '${name}'` },
        });
        return;
      }
      sendFake(res, { status: 200, body: envelope(data) });
      return;
    }

    const documentsMatch = /^\/api\/v1\/datasets\/([^/]+)\/documents$/.exec(path);
    if (documentsMatch && method === 'POST') {
      const datasetId = decodeURIComponent(documentsMatch[1]!);
      const parts = parseMultipart(call.body, call.headers['content-type'] ?? '');
      const file = parts.find((part) => part.name === 'file');
      const document: FakeDocument = {
        id: nextId('doc'),
        datasetId,
        name: file?.filename ?? 'unnamed',
        run: 'UNSTART',
        progress: 0,
        chunk_count: null,
        progress_msg: '',
        content: file?.content ?? '',
      };
      documents.set(document.id, document);
      sendFake(res, {
        status: 200,
        body: envelope([{ id: document.id, dataset_id: datasetId, name: document.name }]),
      });
      return;
    }

    if (documentsMatch && method === 'GET') {
      const datasetId = decodeURIComponent(documentsMatch[1]!);
      const id = call.query.id;
      const docs = [...documents.values()]
        .filter((document) => document.datasetId === datasetId && (!id || document.id === id))
        .map((document) => ({
          id: document.id,
          name: document.name,
          run: document.run,
          progress: document.progress,
          chunk_count: document.chunk_count,
          progress_msg: document.progress_msg,
        }));
      sendFake(res, { status: 200, body: envelope({ docs }) });
      return;
    }

    const chunksMatch = /^\/api\/v1\/datasets\/([^/]+)\/chunks$/.exec(path);
    if (chunksMatch && method === 'POST') {
      const body = JSON.parse(call.body || '{}') as { document_ids?: string[] };
      for (const documentId of body.document_ids ?? []) {
        const document = documents.get(documentId);
        if (document) {
          document.run = 'RUNNING';
          document.progress = 0;
        }
      }
      sendFake(res, { status: 200, body: envelope(true) });
      return;
    }

    const documentMatch = /^\/api\/v1\/datasets\/([^/]+)\/documents\/([^/]+)$/.exec(path);
    if (documentMatch && method === 'DELETE') {
      documents.delete(decodeURIComponent(documentMatch[2]!));
      sendFake(res, { status: 200, body: envelope(true) });
      return;
    }

    if (method === 'POST' && path === '/api/v1/retrieval') {
      const body = JSON.parse(call.body || '{}') as {
        dataset_ids?: string[];
        document_ids?: string[];
      };
      const chunks = retrievalChunks
        .filter(
          (chunk) =>
            (!body.document_ids || body.document_ids.includes(chunk.document_id)) &&
            (!body.dataset_ids || body.dataset_ids.includes(chunk.dataset_id)),
        )
        .map((chunk) => ({
          id: chunk.id,
          content: chunk.content,
          document_id: chunk.document_id,
          dataset_id: chunk.dataset_id,
          similarity: chunk.similarity ?? 0.5,
          positions: chunk.positions ?? null,
        }));
      sendFake(res, { status: 200, body: envelope({ chunks }) });
      return;
    }

    sendFake(res, { status: 404, body: envelope(null, 'route not found') });
  }

  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://fake.local');
      const call: RecordedCall = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: parseQuery(url.search),
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.join(',') : (value ?? ''),
          ]),
        ),
        body: rawBody,
        authorization: req.headers.authorization,
      };
      calls.push(call);

      const queued = queue.find((entry) => entry.remaining > 0 && entry.match(call));
      if (queued) {
        queued.remaining -= 1;
        if (queued.response.hang) {
          // 挂起：仍然执行正常路由（文档等副作用照常登记），只是不写响应。
          hanging = true;
          try {
            respond(res, call);
          } finally {
            hanging = false;
          }
          return;
        }
        sendFake(res, queued.response);
        return;
      }

      respond(res, call);
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    openConnections: () => sockets.size,
    datasets,
    documents,
    retrievalChunks,
    enqueue(match, response, times = 1) {
      queue.push({ match, response, remaining: times });
    },
    dropNext(match) {
      queue.push({ match, response: { status: 200, drop: true }, remaining: 1 });
    },
    reset() {
      calls.length = 0;
      queue.length = 0;
      datasets.clear();
      documents.clear();
      retrievalChunks.length = 0;
    },
    async close() {
      // 挂起中的请求会一直占着连接：必须先强制断开，否则 close 永远等不到回调。
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
