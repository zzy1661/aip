import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { registerAgentRequest, agentPayload } from '../helpers/fixtures.js';
import { createReadyKnowledgeBase, prepareApprovedDocument } from '../helpers/flow.js';

/**
 * M28：密钥不落库、不落日志、不回显。
 *
 * 断言口径：
 * - 上游 API key 与令牌签名密钥不出现在任何持久化行里；
 * - 带 api_key / URL / 嵌套 password 的 Agent 配置被拒绝，且密钥不留在任何行里；
 * - 上游返回的原始错误文本不回显到 API 响应体中。
 */
describe('M28 密钥不落库不落日志', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm28' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  async function dumpAllText(): Promise<string> {
    const tables = [
      'asset_revision',
      'asset',
      'audit_event',
      'operation',
      'idempotency_record',
      'knowledge_revision',
      'knowledge_review',
      'evidence',
    ];
    const chunks: string[] = [];
    for (const table of tables) {
      const { rows } = await harness.pool.query(`SELECT * FROM ${table}`);
      chunks.push(JSON.stringify(rows));
    }
    return chunks.join('\n');
  }

  it('完整知识库流程后，持久化行里没有上游密钥', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M28 知识库');
    await prepareApprovedDocument(harness, token, kbId, { marker: 'M28-SECRET' });

    const dump = await dumpAllText();
    // 替身上游使用的 API key。
    expect(dump).not.toContain('test-api-key');
    // 令牌签名密钥。
    expect(dump).not.toContain('aip-test-only-hs256-secret');
  });

  it('带 api_key 的 Agent 配置被拒绝，密钥不留在任何行里', async () => {
    const secret = 'sk-live-should-never-persist';
    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm28-api-key',
      json: registerAgentRequest({
        slug: 'm28-api-key',
        payload: agentPayload({
          config: { api_key: secret } as unknown as Record<string, unknown>,
        }),
      }),
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('CONTRACT_INVALID');
    expect(JSON.stringify(response.body)).not.toContain(secret);

    const dump = await dumpAllText();
    expect(dump).not.toContain(secret);
  });

  it('嵌套的 password 与 URL 端点同样被拒绝', async () => {
    const nestedSecret = 'nested-password-value';
    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm28-nested',
      json: registerAgentRequest({
        slug: 'm28-nested',
        payload: agentPayload({
          config: {
            outer: { inner: { password: nestedSecret } },
            endpoint: 'https://internal.example.com/hook',
          } as unknown as Record<string, unknown>,
        }),
      }),
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('CONTRACT_INVALID');
    expect(JSON.stringify(response.body)).not.toContain(nestedSecret);

    const dump = await dumpAllText();
    expect(dump).not.toContain(nestedSecret);
  });

  it('上游错误原文不回显到响应体', async () => {
    const upstreamSecret = 'upstream-internal-detail-8f2a';
    harness.ragflow.enqueue(
      (call) => call.method === 'POST' && call.path === '/api/v1/datasets',
      {
        status: 500,
        body: { code: 500, data: null, message: `internal failure ${upstreamSecret}` },
      },
      3,
    );

    const response = await harness.request({
      method: 'POST',
      path: '/knowledge-bases',
      token,
      idempotencyKey: 'm28-upstream-error',
      json: { name: 'M28 上游错误', description: '' },
    });

    expect(response.status).toBe(202);
    // 知识库创建是异步操作，真正的上游错误出现在推进时。
    await harness.advanceAll();

    const operation = await harness.request({
      method: 'GET',
      path: `/operations/${await latestOperationId(harness)}`,
      token,
    });
    expect(operation.status).toBe(200);
    expect(operation.body.data.last_error).toBeTruthy();
    expect(operation.body.data.last_error).not.toContain(upstreamSecret);
  });
});

async function latestOperationId(harness: Harness): Promise<string> {
  const { rows } = await harness.pool.query<{ id: string }>(
    `SELECT id FROM operation WHERE scope_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [harness.projectId],
  );
  return rows[0]!.id;
}
