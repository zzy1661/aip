import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRagFlowHttpClient } from '@aip/api';

/**
 * M19：只读总预算必须真正约束等待时间。
 *
 * 回归场景：上游接受连接但一直不回包。此时连接阶段的计时器已经清除、
 * 响应阶段的计时器还没建立，如果没有单次尝试的总计时器兜底，
 * 整次调用会无限挂起，只读预算形同虚设。
 */
describe('M19 上游不回包时的总预算兜底', () => {
  let server: net.Server;
  let url: string;
  const accepted: number[] = [];
  const sockets: net.Socket[] = [];

  beforeAll(async () => {
    server = net.createServer((socket) => {
      accepted.push(Date.now());
      sockets.push(socket);
      // 接受连接后什么都不回：既不发响应头，也不发正文。
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    // 上游连接是被刻意留着的，close 之前要主动断开，否则 close 会一直等下去。
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('上游接受连接却不回包时，请求在总预算内结束而不是无限挂起', async () => {
    const client = createRagFlowHttpClient({
      baseUrl: url,
      apiKey: 'ragflow-secret-key',
      connectTimeoutMs: 500,
      readTimeoutMs: 300,
      uploadTimeoutMs: 500,
      readBudgetMs: 1_000,
      maxReadAttempts: 1,
    });

    const started = Date.now();
    await expect(
      client.execute({ method: 'GET', path: 'datasets', idempotentRead: true }),
    ).rejects.toMatchObject({ name: 'RagFlowUnavailableError' });

    const elapsed = Date.now() - started;
    // 总预算 1s：即使上游一直不回包，也必须在预算附近结束。
    expect(elapsed).toBeLessThan(5_000);
    // 上游确实接受过连接（请求已送达，回包未知）。
    expect(accepted.length).toBeGreaterThan(0);
  });
});
