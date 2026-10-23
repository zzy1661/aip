import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { createReadyKnowledgeBase, uploadSampleDocument } from '../helpers/flow.js';

/**
 * M11：文档上传的固定契约。
 *
 * 断言口径：上传必须是单个 file 字段的 multipart；上游回包形状不符即失败；
 * 响应丢失时写操作不得重发。
 */
describe('M11 RAGFlow 上传契约', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm11' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('上传以单个 file 字段的 multipart 发出，随后只触发一次解析', async () => {
    harness.ragflow.reset();
    const { kbId, datasetId } = await createReadyKnowledgeBase(harness, token, 'M11 上传');
    const uploaded = await uploadSampleDocument(harness, token, kbId, { marker: 'M11-UPLOAD' });

    await harness.advanceAll();

    const uploadCalls = harness.ragflow.calls.filter(
      (call) => call.method === 'POST' && call.path === `/api/v1/datasets/${datasetId}/documents`,
    );
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0]!.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(uploadCalls[0]!.body).toContain('name="file"');
    expect(uploadCalls[0]!.body).toContain('M11-UPLOAD');
    expect(uploadCalls[0]!.authorization).toBe('Bearer test-api-key');

    // 解析启动是一次写请求，只允许一次。
    const parseCalls = harness.ragflow.calls.filter(
      (call) => call.method === 'POST' && call.path === `/api/v1/datasets/${datasetId}/chunks`,
    );
    expect(parseCalls).toHaveLength(1);
    expect(JSON.parse(parseCalls[0]!.body)).toMatchObject({
      document_ids: [expect.any(String)],
    });
    expect(uploaded.knowledgeRef).toBeTruthy();
  });

  it('上游 code 非 0 时上传失败，知识版本不会进入 ready', async () => {
    harness.ragflow.reset();
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M11 业务失败');
    harness.ragflow.enqueue(
      (call) => call.method === 'POST' && call.path.endsWith('/documents'),
      { status: 200, body: { code: 500, data: null, message: 'upstream rejected' } },
    );

    const uploaded = await uploadSampleDocument(harness, token, kbId, { marker: 'M11-BIZ-FAIL' });
    await harness.advanceAll();

    const detail = await harness.request({
      method: 'GET',
      path: `/knowledge/${uploaded.knowledgeRef}/versions/${uploaded.version}`,
      token,
    });
    expect(detail.body.data.status).not.toBe('ready');

    const operation = await harness.request({
      method: 'GET',
      path: `/operations/${uploaded.operationId}`,
      token,
    });
    expect(operation.body.data.state).toBe('failed');
  });

  it('上游回包缺少文档数组时是协议错误，不是成功', async () => {
    harness.ragflow.reset();
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M11 协议错误');
    harness.ragflow.enqueue(
      (call) => call.method === 'POST' && call.path.endsWith('/documents'),
      { status: 200, body: { code: 0, data: { id: 'doc-x' }, message: 'success' } },
    );

    const uploaded = await uploadSampleDocument(harness, token, kbId, { marker: 'M11-PROTOCOL' });
    await harness.advanceAll();

    const operation = await harness.request({
      method: 'GET',
      path: `/operations/${uploaded.operationId}`,
      token,
    });
    expect(operation.body.data.state).toBe('failed');
    expect(operation.body.data.last_error).toContain('contract');
  });

  it('上传响应丢失时登记 unknown_outcome，且不会重发第二次上传', async () => {
    harness.ragflow.reset();
    const { kbId, datasetId } = await createReadyKnowledgeBase(harness, token, 'M11 响应丢失');
    harness.ragflow.dropNext(
      (call) => call.method === 'POST' && call.path === `/api/v1/datasets/${datasetId}/documents`,
    );

    const uploaded = await uploadSampleDocument(harness, token, kbId, { marker: 'M11-LOST' });
    await harness.advanceAll();

    const operation = await harness.request({
      method: 'GET',
      path: `/operations/${uploaded.operationId}`,
      token,
    });
    expect(operation.body.data.state).toBe('unknown_outcome');

    const uploadCalls = harness.ragflow.calls.filter(
      (call) => call.method === 'POST' && call.path === `/api/v1/datasets/${datasetId}/documents`,
    );
    expect(uploadCalls).toHaveLength(1);
  });
});
