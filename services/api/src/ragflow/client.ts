import http from 'node:http';
import https from 'node:https';
import { RagFlowProtocolError, RagFlowUnavailableError } from './errors.js';

export interface RawRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer | null;
  connectTimeoutMs: number;
  readTimeoutMs: number;
  /**
   * 本次尝试的总时间上限（含连接与读取）。
   * 只读重试按剩余预算切分，保证「多次尝试 + 退避」不超过总预算。
   */
  attemptTimeoutMs?: number;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export type Transport = (request: RawRequest) => Promise<RawResponse>;

export interface RagFlowHttpOptions {
  baseUrl: string;
  apiKey: string;
  connectTimeoutMs: number;
  readTimeoutMs: number;
  uploadTimeoutMs: number;
  /** 只读调用的总预算（连接 + 单次超时 + 退避 + Retry-After）。 */
  readBudgetMs: number;
  maxReadAttempts: number;
  transport?: Transport;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface RagFlowRequest {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  /** 写请求不做自动重试。 */
  idempotentRead: boolean;
  json?: unknown;
  multipart?: { name: string; filename: string; contentType: string; content: Buffer };
  timeoutMs?: number;
}

export interface RagFlowHttpResponse {
  status: number;
  body: unknown;
}

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/** 这些错误码只可能发生在连接建立之前：请求确定没有送达上游。 */
const NOT_DELIVERED_ERROR_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildMultipartBody(
  file: { name: string; filename: string; contentType: string; content: Buffer },
): { body: Buffer; contentType: string } {
  const boundary = `----aip${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n` +
      `Content-Type: ${file.contentType}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    body: Buffer.concat([head, file.content, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** 基于 node:http(s) 的传输实现：连接超时与读取超时可以分别控制，且默认不跟随重定向。 */
export const nodeTransport: Transport = (request) =>
  new Promise<RawResponse>((resolve, reject) => {
    const url = new URL(request.url);
    const agent = url.protocol === 'https:' ? https : http;
    const deadline =
      request.attemptTimeoutMs === undefined ? undefined : Date.now() + request.attemptTimeoutMs;
    const remaining = (): number =>
      deadline === undefined ? Number.POSITIVE_INFINITY : Math.max(1, deadline - Date.now());

    let connected = false;
    let readTimer: NodeJS.Timeout | undefined;

    const clientRequest = agent.request(
      url,
      { method: request.method, headers: request.headers },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            clientRequest.destroy();
            reject(new RagFlowProtocolError('response body exceeds the size limit'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (readTimer) clearTimeout(readTimer);
          if (attemptTimer) clearTimeout(attemptTimer);
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );

    const connectTimer = setTimeout(() => {
      clientRequest.destroy();
      // 连接阶段就超时：请求确定没有送达上游，可以安全重试。
      reject(new RagFlowUnavailableError('connect timeout', 'not_delivered', true));
    }, Math.min(request.connectTimeoutMs, remaining()));

    // 单次尝试的总时间上限独立计时。上游接受连接却一直不回包时，
    // 连接计时器已清除、读取计时器还没建立，只有这个计时器能兜底；
    // 否则整次调用会无限挂起，只读总预算形同虚设。
    const attemptTimer =
      deadline === undefined
        ? undefined
        : setTimeout(() => {
            clientRequest.destroy();
            reject(
              new RagFlowUnavailableError(
                'attempt timeout',
                connected ? 'delivered_unknown' : 'not_delivered',
                true,
              ),
            );
          }, Math.max(1, deadline - Date.now()));

    clientRequest.on('socket', (socket) => {
      if (socket.connecting) {
        socket.once('connect', () => {
          connected = true;
          clearTimeout(connectTimer);
        });
        return;
      }
      // 复用的 keep-alive 连接不会再次触发 connect 事件，
      // 连接计时器必须在这里清掉，否则它会在连接早已建立之后才超时。
      connected = true;
      clearTimeout(connectTimer);
    });
    clientRequest.on('response', () => {
      readTimer = setTimeout(() => {
        clientRequest.destroy();
        // 读超时：请求已被上游接收，回包没有回来。写操作禁止盲重发。
        reject(new RagFlowUnavailableError('read timeout', 'delivered_unknown', true));
      }, Math.min(request.readTimeoutMs, remaining()));
    });
    clientRequest.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(connectTimer);
      if (readTimer) clearTimeout(readTimer);
      if (attemptTimer) clearTimeout(attemptTimer);
      if (error.name === 'AbortError') {
        reject(new RagFlowUnavailableError('request aborted', 'delivered_unknown', true));
        return;
      }
      // 明确的连接阶段错误码说明请求没有送达；其余（连接重置、管道断开）
      // 可能发生在请求已经发出之后，只能按「送达未知」处理。
      const kind = NOT_DELIVERED_ERROR_CODES.has(error.code ?? '')
        ? 'not_delivered'
        : 'delivered_unknown';
      reject(new RagFlowUnavailableError('connection failed', kind, false));
    });

    if (request.body) clientRequest.write(request.body);
    clientRequest.end();
  });

/**
 * RAGFlow HTTP 出口。
 *
 * - 只读请求：最多 3 次尝试，总耗时（含连接、单次超时、退避、Retry-After）不超过总预算。
 * - 写请求：0 次自动重试；响应丢失由调用方登记为 unknown_outcome，交人工核查。
 * - 重定向不跟随，避免把服务端 key 转发到未知地址。
 */
export interface RagFlowHttpClient {
  execute(request: RagFlowRequest): Promise<RagFlowHttpResponse>;
}

export function createRagFlowHttpClient(options: RagFlowHttpOptions): RagFlowHttpClient {
  const transport = options.transport ?? nodeTransport;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  function buildRawRequest(request: RagFlowRequest): RawRequest {
    const url = new URL(request.path, `${options.baseUrl}/api/v1/`);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.apiKey}`,
    };
    let body: Buffer | null = null;
    if (request.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = Buffer.from(JSON.stringify(request.json), 'utf8');
    } else if (request.multipart !== undefined) {
      const multipart = buildMultipartBody(request.multipart);
      headers['Content-Type'] = multipart.contentType;
      body = multipart.body;
    }
    if (body) headers['Content-Length'] = String(body.length);
    // 上传使用独立的长超时；只读请求用单次读超时。
    const effectiveReadTimeout =
      request.timeoutMs ??
      (request.multipart ? options.uploadTimeoutMs : options.readTimeoutMs);
    return {
      url: url.toString(),
      method: request.method,
      headers,
      body,
      connectTimeoutMs: options.connectTimeoutMs,
      readTimeoutMs: effectiveReadTimeout,
    };
  }

  function parseBody(raw: RawResponse): unknown {
    if (raw.body.length === 0) return null;
    const text = raw.body.toString('utf8');
    try {
      return JSON.parse(text);
    } catch {
      throw new RagFlowProtocolError('response body is not valid JSON');
    }
  }

  function retryAfterMs(raw: RawResponse | null, attemptIndex: number): number {
    const header = raw?.headers['retry-after'];
    if (typeof header === 'string') {
      const seconds = Number.parseInt(header, 10);
      if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    }
    const base = attemptIndex === 0 ? 250 : 1000;
    return base + Math.floor(random() * 50);
  }

  async function execute(request: RagFlowRequest): Promise<RagFlowHttpResponse> {
    if (!request.idempotentRead) {
      const raw = await transport(buildRawRequest(request)).catch((error: unknown) => {
        // 写请求一旦送达就可能已经生效，调用方必须据此禁止重发。
        if (error instanceof RagFlowUnavailableError) error.writeAttempt = true;
        throw error;
      });
      return { status: raw.status, body: parseBody(raw) };
    }

    const deadline = Date.now() + options.readBudgetMs;
    let lastError: unknown;

    for (let index = 0; index < options.maxReadAttempts; index += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new RagFlowUnavailableError(
          'read retry budget exhausted',
          'upstream_unavailable',
          true,
        );
      }
      // 单次尝试的耗时分到剩余预算里，保证「多次尝试 + 退避」不超过总预算。
      const raw = await transport({
        ...buildRawRequest(request),
        attemptTimeoutMs: remaining,
      }).catch((error: unknown) => {
        lastError = error;
        return null;
      });
      if (raw) {
        if (!RETRYABLE_STATUS.has(raw.status)) {
          return { status: raw.status, body: parseBody(raw) };
        }
        lastError = new RagFlowUnavailableError(
          `upstream returned ${raw.status}`,
          'upstream_unavailable',
          false,
        );
      }

      const delay = retryAfterMs(raw, index);
      if (Date.now() + delay >= deadline) break;
      await sleep(delay);
    }
    throw lastError instanceof Error
      ? lastError
      : new RagFlowUnavailableError('read failed', 'upstream_unavailable', false);
  }

  return { execute };
}
