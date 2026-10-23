import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRagFlowHttpClient } from '@aip/api';

/**
 * M28：上游重定向不得泄漏凭据。
 *
 * 断言口径：RAGFlow 传输层不跟随重定向，
 * 因此上游凭据不会被送到重定向目标；重定向响应按原样返回给调用方。
 */
interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
}

async function startServer(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    recorded: RecordedRequest[],
  ) => void,
): Promise<{ url: string; recorded: RecordedRequest[]; close: () => Promise<void> }> {
  const recorded: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    recorded.push({
      method: req.method ?? 'GET',
      url: req.url ?? '',
      authorization: req.headers.authorization,
    });
    handler(req, res, recorded);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    recorded,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

describe('M28 上游重定向不泄漏凭据', () => {
  let target: Awaited<ReturnType<typeof startServer>>;
  let redirector: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    target = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data: [{ id: 'ds-leaked' }], message: 'success' }));
    });
    redirector = await startServer((_req, res) => {
      res.writeHead(302, { location: `${target.url}/api/v1/datasets` });
      res.end();
    });
  });

  afterAll(async () => {
    await redirector.close();
    await target.close();
  });

  it('不跟随重定向，重定向目标收不到任何请求', async () => {
    const client = createRagFlowHttpClient({
      baseUrl: redirector.url,
      apiKey: 'ragflow-secret-key',
      connectTimeoutMs: 2_000,
      readTimeoutMs: 2_000,
      uploadTimeoutMs: 2_000,
      readBudgetMs: 5_000,
      maxReadAttempts: 1,
    });

    const response = await client.execute({
      method: 'GET',
      path: 'datasets',
      idempotentRead: true,
    });

    // 重定向响应按原样返回，不被跟随。
    expect(response.status).toBe(302);
    // 重定向目标一次请求都没收到，凭据不可能泄漏过去。
    expect(target.recorded).toHaveLength(0);
    expect(JSON.stringify(target.recorded)).not.toContain('ragflow-secret-key');
    // 凭据只发给了被配置的上游地址本身。
    expect(redirector.recorded).toHaveLength(1);
    expect(redirector.recorded[0]!.authorization).toBe('Bearer ragflow-secret-key');
  });
});
