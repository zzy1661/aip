import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import type { FakeResponse } from '../helpers/ragflow.js';

/**
 * M10：数据集创建的失败分支必须互相可区分。
 *
 * 断言口径：
 * - 上游业务失败（code != 0）、协议不符（HTTP 200 但 data 缺少 id）、凭据被拒（401）
 *   是三类不同故障，落到操作上的结论必须能区分开；
 * - 三类失败都不得落数据集 id，知识库状态必须回落成失败；
 * - 失败后不得再发第二次创建请求；
 * - 成功路径只发一次创建请求，并把数据集 id 落库。
 */
describe('M10 数据集创建失败分支', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm10neg' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  interface CreateOutcome {
    operationState: string;
    operationLastError: string | null;
    operationAttempt: number;
    kbStatus: string;
    datasetId: string | null;
    createCalls: number;
  }

  /** 跑一次「创建知识库 -> 推进上游调用」的完整场景，返回可断言的事实。 */
  async function runCreateScenario(
    name: string,
    upstream: FakeResponse | null,
  ): Promise<CreateOutcome> {
    harness.ragflow.reset();
    if (upstream) {
      harness.ragflow.enqueue(
        (call) => call.method === 'POST' && call.path === '/api/v1/datasets',
        upstream,
      );
    }

    const created = await harness.request({
      method: 'POST',
      path: '/knowledge-bases',
      token,
      idempotencyKey: `kb-${Math.random().toString(36).slice(2, 10)}`,
      json: { name, description: '' },
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
    const kb = await harness.request({
      method: 'GET',
      path: `/knowledge-bases/${kbId}`,
      token,
    });
    const createCalls = harness.ragflow.calls.filter(
      (call) => call.method === 'POST' && call.path === '/api/v1/datasets',
    ).length;

    return {
      operationState: operation.body.data.state,
      operationLastError: operation.body.data.last_error,
      operationAttempt: operation.body.data.attempt,
      kbStatus: kb.body.data.status,
      datasetId: kb.body.data.ragflow_dataset_id,
      createCalls,
    };
  }

  it('上游业务失败（code != 0）落成失败终态，不落数据集 id，也不重发创建请求', async () => {
    const outcome = await runCreateScenario('M10 业务失败', {
      status: 200,
      body: { code: 500, data: null, message: 'dataset quota exceeded' },
    });

    expect(outcome.operationState).toBe('failed');
    expect(outcome.operationLastError).toBe('upstream business failure code=500');
    expect(outcome.operationLastError).not.toContain('dataset quota exceeded');
    expect(outcome.kbStatus).toBe('failed');
    expect(outcome.datasetId).toBeNull();
    expect(outcome.createCalls).toBe(1);
  });

  it('上游 HTTP 200 但 data 缺少 id 时按协议错误落成失败终态，不落数据集 id', async () => {
    const outcome = await runCreateScenario('M10 协议错误', {
      status: 200,
      body: { code: 0, data: { name: 'no-id-here' }, message: 'success' },
    });

    expect(outcome.operationState).toBe('failed');
    expect(outcome.operationLastError).toBe(
      'upstream response did not match the fixed contract',
    );
    expect(outcome.kbStatus).toBe('failed');
    expect(outcome.datasetId).toBeNull();
    expect(outcome.createCalls).toBe(1);
  });

  it('上游 401 时按凭据被拒落成失败终态，不落数据集 id，也不重发创建请求', async () => {
    const outcome = await runCreateScenario('M10 凭据被拒', {
      status: 401,
      body: { code: 401, data: null, message: 'invalid api key' },
    });

    expect(outcome.operationState).toBe('failed');
    expect(outcome.operationLastError).toBe('upstream rejected the platform credential');
    expect(outcome.operationLastError).not.toContain('invalid api key');
    expect(outcome.kbStatus).toBe('failed');
    expect(outcome.datasetId).toBeNull();
    expect(outcome.createCalls).toBe(1);
  });

  it('三类失败的结论互相可区分，不会落成同一个错误结论', async () => {
    const business = await runCreateScenario('M10 区分-业务失败', {
      status: 200,
      body: { code: 500, data: null, message: 'dataset quota exceeded' },
    });
    const protocol = await runCreateScenario('M10 区分-协议错误', {
      status: 200,
      body: { code: 0, data: { name: 'no-id-here' }, message: 'success' },
    });
    const credential = await runCreateScenario('M10 区分-凭据被拒', {
      status: 401,
      body: { code: 401, data: null, message: 'invalid api key' },
    });

    const messages = [
      business.operationLastError,
      protocol.operationLastError,
      credential.operationLastError,
    ];
    expect(new Set(messages).size).toBe(3);
    for (const outcome of [business, protocol, credential]) {
      expect(outcome.operationState).toBe('failed');
      expect(outcome.datasetId).toBeNull();
      expect(outcome.createCalls).toBe(1);
    }
  });

  it('成功路径只发一次创建请求，并把数据集 id 落库', async () => {
    const outcome = await runCreateScenario('M10 成功路径', null);

    expect(outcome.operationState).toBe('succeeded');
    expect(outcome.operationLastError).toBeNull();
    expect(outcome.operationAttempt).toBe(1);
    expect(outcome.kbStatus).toBe('ready');
    expect(outcome.datasetId).toBeTruthy();
    expect(outcome.createCalls).toBe(1);
  });
});
