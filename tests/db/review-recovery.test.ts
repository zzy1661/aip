import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  createOperationsService,
  createRagFlowAdapter,
  createRagFlowHttpClient,
  RagFlowUnavailableError,
  type RagFlowAdapter,
} from '@aip/api';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import {
  createReadyKnowledgeBase,
  uploadSampleDocument,
  prepareApprovedDocument,
} from '../helpers/flow.js';

/**
 * 独立复审发现的四条恢复与交付边界。
 *
 * 这些断言在复审时全部失败（5/5），它们固定的是「不应发生的事」：
 * - 只读核对的失败不能授权另一次写请求；
 * - 只读核对的失败不能回退已经确认过的前序步骤；
 * - 上传恢复不能靠用户文件名认领另一份来源；
 * - 交付前必须复核授权，撤权已提交就不能再发正文。
 */
let h: Harness;
let token: string;

beforeEach(async () => {
  h = await createHarness({ label: 'review_recovery' });
  token = await h.token({ permissions: ALL_PERMISSIONS });
});

afterEach(async () => {
  await h.close();
});

/** 造一个上游适配器替身：只覆盖指定方法，其余走真实 HTTP 替身上游。 */
function worker(overrides: Partial<RagFlowAdapter>) {
  const adapter = createRagFlowAdapter({
    http: createRagFlowHttpClient({
      baseUrl: h.ragflow.url,
      apiKey: 'test-api-key',
      connectTimeoutMs: 500,
      readTimeoutMs: 1000,
      uploadTimeoutMs: 2000,
      readBudgetMs: 2000,
      maxReadAttempts: 1,
    }),
    embeddingModel: 'test',
    parserConfig: {},
    chunkMethod: 'naive',
    similarityThreshold: 0.2,
    vectorSimilarityWeight: 0.3,
    topK: 64,
  });
  Object.assign(adapter, overrides);
  return {
    adapter,
    operations: createOperationsService({
      pool: h.pool,
      ragflow: adapter,
      files: h.files,
      parseDeadlineMs: 60_000,
      parserHash: 'test',
      embeddingRevision: 'test',
    }),
  };
}

async function retry(id: string): Promise<void> {
  await h.pool.query('UPDATE operation SET next_attempt_at=NULL WHERE id=$1', [id]);
}

it('未知的数据集写：核对用的 GET 连不上不能授权另一次 POST', async () => {
  const r = await h.request({
    method: 'POST',
    path: '/knowledge-bases',
    token,
    idempotencyKey: 'read-is-not-write',
    json: { name: 'review', description: '' },
  });
  const id = r.body.data.operation_id;
  await h.pool.query(
    "UPDATE operation SET result=jsonb_set(result,'{stage}','\"dataset_create_attempted\"'),state='in_progress' WHERE id=$1",
    [id],
  );
  let creates = 0;
  const { operations } = worker({
    listDatasetsByName: async () => {
      throw new RagFlowUnavailableError('connection failed', 'not_delivered');
    },
    createDataset: async () => {
      creates += 1;
      return { datasetId: 'DUPLICATE' };
    },
  });
  await operations.advance(id, h.projectId);
  await retry(id);
  await operations.advance(id, h.projectId);
  expect(creates, '核对用的 GET 失败说明不了之前的 POST 有没有送达').toBe(0);
});

it('上传已确认后，解析请求未送达时只重试解析，不重复上传', async () => {
  const kb = await createReadyKnowledgeBase(h, token);
  const d = await uploadSampleDocument(h, token, kb.kbId);
  let starts = 0;
  const { operations } = worker({
    startParse: async () => {
      starts += 1;
      const e = new RagFlowUnavailableError('connection failed', 'not_delivered');
      e.writeAttempt = true;
      throw e;
    },
  });
  await operations.advance(d.operationId, h.projectId);
  await retry(d.operationId);
  await operations.advance(d.operationId, h.projectId);
  expect(starts).toBe(2);
  expect(
    h.ragflow.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/documents')),
    '已确认的上传必须保持已落库',
  ).toHaveLength(1);
});

it('重建触发已确认后，轮询用的 GET 失败不能重新触发重建', async () => {
  const kb = await createReadyKnowledgeBase(h, token);
  const d = await prepareApprovedDocument(h, token, kb.kbId);
  const r = await h.request({
    method: 'POST',
    path: `/knowledge/${d.knowledgeRef}/versions/${d.version}/reindex`,
    token,
    idempotencyKey: 'reindex-read-failure',
  });
  expect(r.status).toBe(202);
  const id = r.body.data.operation_id;
  let starts = 0;
  const { operations } = worker({
    startParse: async () => {
      starts += 1;
    },
    getDocumentStatus: async () => {
      throw new RagFlowUnavailableError('connection failed', 'not_delivered');
    },
  });
  await operations.advance(id, h.projectId);
  await retry(id);
  await operations.advance(id, h.projectId);
  expect(starts, '轮询用的 GET 不能回退已确认的重建触发').toBe(1);
});

it('上传恢复不能认领另一份用户文件名相同、来源不同的文档', async () => {
  const kb = await createReadyKnowledgeBase(h, token);
  const first = await prepareApprovedDocument(h, token, kb.kbId, {
    fileName: 'shared.md',
    marker: 'FIRST-CONTENT',
  });
  const second = await uploadSampleDocument(h, token, kb.kbId, {
    fileName: 'shared.md',
    marker: 'DIFFERENT-CONTENT',
  });
  await h.pool.query(
    "UPDATE operation SET result=jsonb_set(result,'{stage}','\"upload_attempted\"'),state='in_progress' WHERE id=$1",
    [second.operationId],
  );
  await h.operations.advance(second.operationId, h.projectId);
  const { rows: [op] } = await h.pool.query(
    'SELECT state, remote_id FROM operation WHERE id=$1',
    [second.operationId],
  );
  expect(op.remote_id, '文件名相同不构成来源身份').not.toBe(first.documentId);
  expect(op.state).toBe('unknown_outcome');
});

it('下载在文件读取期间撤权，撤权已提交且尚未发出正文时必须拒绝', async () => {
  const kb = await createReadyKnowledgeBase(h, token);
  const d = await prepareApprovedDocument(h, token, kb.kbId, {
    marker: 'REVOKED-BEFORE-DELIVERY',
  });
  let entered!: () => void;
  let release!: () => void;
  const reading = new Promise<void>((r) => {
    entered = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const read = h.files.read.bind(h.files);
  h.files.read = async (key: string) => {
    entered();
    await gate;
    return read(key);
  };
  const pending = h.request({
    path: `/sources/${d.sourceRef}/versions/${d.version}/download`,
    token,
  });
  await reading;
  try {
    const revoked = await h.request({
      method: 'DELETE',
      path: `/knowledge/${d.knowledgeRef}/versions/${d.version}/grants/user-1`,
      token,
    });
    expect(revoked.status).toBe(200);
  } finally {
    release();
  }
  const result = await pending;
  expect(
    result.status,
    '撤权在文件读取完成、正文发出之前提交，下载必须被拒绝',
  ).toBe(404);
});

it('下载在文件读取期间撤回知识版本，撤回已提交时必须拒绝', async () => {
  const kb = await createReadyKnowledgeBase(h, token);
  const d = await prepareApprovedDocument(h, token, kb.kbId, {
    marker: 'WITHDRAWN-BEFORE-DELIVERY',
  });
  const detail = await h.request({
    path: `/knowledge/${d.knowledgeRef}/versions/${d.version}`,
    token,
  });
  const stateRevision = detail.body.data.state_revision as number;

  let entered!: () => void;
  let release!: () => void;
  const reading = new Promise<void>((r) => {
    entered = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const read = h.files.read.bind(h.files);
  h.files.read = async (key: string) => {
    entered();
    await gate;
    return read(key);
  };
  const pending = h.request({
    path: `/sources/${d.sourceRef}/versions/${d.version}/download`,
    token,
  });
  await reading;
  try {
    const withdrawn = await h.request({
      method: 'POST',
      path: `/knowledge/${d.knowledgeRef}/versions/${d.version}/withdraw`,
      token,
      json: { expected_state_revision: stateRevision, reason: '在途撤回' },
    });
    expect(withdrawn.status).toBe(200);
  } finally {
    release();
  }
  const result = await pending;
  expect(
    result.status,
    '撤回在文件读取完成、正文发出之前提交，下载必须被拒绝',
  ).toBe(404);
});
