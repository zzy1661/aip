import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';

/**
 * M10：知识库创建与 RAGFlow dataset 的固定契约。
 *
 * 断言口径：只有 code=0 且带 data.id 才算成功；HTTP 200 但 code 非 0 是业务失败；
 * 缺 id 是协议错误；401 归为凭据配置问题；响应丢失时写操作不得盲重发。
 */
describe('M10 RAGFlow dataset 契约', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm10' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('创建知识库返回 202 与操作号，推进后写入 dataset 映射并置为 ready', async () => {
    const created = await harness.request({
      method: 'POST',
      path: '/knowledge-bases',
      token,
      idempotencyKey: 'm10-create-ok',
      json: { name: 'M10 知识库', description: '契约测试' },
    });

    expect(created.status).toBe(202);
    expect(created.body.data.kb_id).toBeTruthy();
    expect(created.body.data.operation_id).toBeTruthy();

    await harness.advanceAll();

    const detail = await harness.request({
      method: 'GET',
      path: `/knowledge-bases/${created.body.data.kb_id}`,
      token,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.data.status).toBe('ready');

    // 上游只创建一次 dataset：先按稳定名称核对，未命中才 POST。
    const datasetPosts = harness.ragflow.calls.filter(
      (call) => call.method === 'POST' && call.path === '/api/v1/datasets',
    );
    expect(datasetPosts).toHaveLength(1);
  });

  it('HTTP 200 但 code 非 0 是业务失败，知识库不进入 ready', async () => {
    harness.ragflow.reset();
    harness.ragflow.enqueue(
      (call) => call.method === 'POST' && call.path === '/api/v1/datasets',
      { status: 200, body: { code: 500, data: null, message: 'upstream internal error' } },
    );

    const created = await harness.request({
      method: 'POST',
      path: '/knowledge-bases',
      token,
      idempotencyKey: 'm10-create-biz-fail',
      json: { name: 'M10 业务失败', description: '' },
    });
    expect(created.status).toBe(202);

    await harness.advanceAll();

    const detail = await harness.request({
      method: 'GET',
      path: `/knowledge-bases/${created.body.data.kb_id}`,
      token,
    });
    expect(detail.body.data.status).not.toBe('ready');
  });

  it('缺少 data.id 是协议错误，知识库不进入 ready', async () => {
    harness.ragflow.reset();
    harness.ragflow.enqueue(
      (call) => call.method === 'POST' && call.path === '/api/v1/datasets',
      { status: 200, body: { code: 0, data: {}, message: 'success' } },
    );

    const created = await harness.request({
      method: 'POST',
      path: '/knowledge-bases',
      token,
      idempotencyKey: 'm10-create-protocol',
      json: { name: 'M10 协议错误', description: '' },
    });
    expect(created.status).toBe(202);

    await harness.advanceAll();

    const detail = await harness.request({
      method: 'GET',
      path: `/knowledge-bases/${created.body.data.kb_id}`,
      token,
    });
    expect(detail.body.data.status).not.toBe('ready');
  });

  it('上游 401 归为凭据/配置错误，不映射为业务成功', async () => {
    harness.ragflow.reset();
    harness.ragflow.enqueue(
      (call) => call.method === 'POST' && call.path === '/api/v1/datasets',
      { status: 401, body: { code: 401, data: null, message: 'unauthorized' } },
    );

    const created = await harness.request({
      method: 'POST',
      path: '/knowledge-bases',
      token,
      idempotencyKey: 'm10-create-401',
      json: { name: 'M10 上游 401', description: '' },
    });
    expect(created.status).toBe(202);

    await harness.advanceAll();

    const detail = await harness.request({
      method: 'GET',
      path: `/knowledge-bases/${created.body.data.kb_id}`,
      token,
    });
    expect(detail.body.data.status).not.toBe('ready');
  });

  it('按名称核对零命中时上游返回 108，按未命中处理并继续创建', async () => {
    harness.ragflow.reset();

    const created = await harness.request({
      method: 'POST',
      path: '/knowledge-bases',
      token,
      idempotencyKey: 'm10-create-name-lookup-108',
      json: { name: 'M10 名称核对', description: '' },
    });
    expect(created.status).toBe(202);

    await harness.advanceAll();

    // 上游在按名称过滤且零命中时返回 code=108（PERMISSION_ERROR），
    // 适配器必须把它当成「未命中」而不是业务失败。
    const nameLookups = harness.ragflow.calls.filter(
      (call) => call.method === 'GET' && call.path === '/api/v1/datasets',
    );
    expect(nameLookups.length).toBeGreaterThan(0);
    expect(nameLookups[0]!.query.name).toMatch(/^aip-/);

    const detail = await harness.request({
      method: 'GET',
      path: `/knowledge-bases/${created.body.data.kb_id}`,
      token,
    });
    expect(detail.body.data.status).toBe('ready');
  });

  it('创建响应丢失时登记 unknown_outcome，且不再发第二次 POST', async () => {
    harness.ragflow.reset();
    harness.ragflow.dropNext(
      (call) => call.method === 'POST' && call.path === '/api/v1/datasets',
    );

    const created = await harness.request({
      method: 'POST',
      path: '/knowledge-bases',
      token,
      idempotencyKey: 'm10-create-lost',
      json: { name: 'M10 响应丢失', description: '' },
    });
    expect(created.status).toBe(202);
    const operationId = created.body.data.operation_id;

    await harness.advanceAll();

    const operation = await harness.request({
      method: 'GET',
      path: `/operations/${operationId}`,
      token,
    });
    expect(operation.status).toBe(200);
    expect(operation.body.data.state).toBe('unknown_outcome');

    const datasetPosts = harness.ragflow.calls.filter(
      (call) => call.method === 'POST' && call.path === '/api/v1/datasets',
    );
    expect(datasetPosts).toHaveLength(1);
  });
});
