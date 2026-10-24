import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  createOperationsService,
  createRagFlowAdapter,
  createRagFlowHttpClient,
  remoteDocumentName,
} from '@aip/api';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { createReadyKnowledgeBase, uploadSampleDocument } from '../helpers/flow.js';

/**
 * 上传身份：远端文档名必须在第一次发送之前落库。
 *
 * 上游文档名就是上传时的文件名。同一知识库里可能存在同名不同正文的来源，
 * 只按用户文件名核对上游会把另一份来源的旧文档错认成这次的上传。
 * 因此远端名由来源标识派生，并且在第一次 HTTP 之前与发送意图一起持久化。
 *
 * 反过来：没有持久身份的历史操作不能用新算法推算一个名字再去认领，
 * 那样会把「恰好同名」当成「就是这次上传的」。这类操作保持 unknown。
 */
let h: Harness;
let token: string;

beforeEach(async () => {
  h = await createHarness({ label: 'upload_identity' });
  token = await h.token({ permissions: ALL_PERMISSIONS });
});

afterEach(async () => {
  await h.close();
});

it('第一次上传之前，远端身份已经持久化在检查点里', async () => {
  const kb = await createReadyKnowledgeBase(h, token);
  const d = await uploadSampleDocument(h, token, kb.kbId, { fileName: 'identity.md' });
  let witnessed = false;
  const http = createRagFlowHttpClient({
    baseUrl: h.ragflow.url,
    apiKey: 'test-api-key',
    connectTimeoutMs: 500,
    readTimeoutMs: 1000,
    uploadTimeoutMs: 2000,
    readBudgetMs: 2000,
    maxReadAttempts: 1,
  });
  const execute = http.execute.bind(http);
  http.execute = async (input) => {
    if (input.method === 'POST' && input.path.endsWith('/documents')) {
      const { rows: [op] } = await h.pool.query('SELECT result FROM operation WHERE id=$1', [
        d.operationId,
      ]);
      expect(op.result.stage).toBe('upload_attempted');
      expect(op.result.remoteName).toBe(
        remoteDocumentName('identity.md', d.sourceRef, d.version),
      );
      witnessed = true;
    }
    return execute(input);
  };
  const adapter = createRagFlowAdapter({
    http,
    embeddingModel: 'test',
    parserConfig: {},
    chunkMethod: 'naive',
    similarityThreshold: 0.2,
    vectorSimilarityWeight: 0.3,
    topK: 64,
  });
  const operations = createOperationsService({
    pool: h.pool,
    ragflow: adapter,
    files: h.files,
    parseDeadlineMs: 60000,
    parserHash: 'test',
    embeddingRevision: 'test',
  });
  await operations.advance(d.operationId, h.projectId);
  expect(witnessed).toBe(true);
});

it('没有持久远端身份的历史上传意图，即使存在同名候选也必须保持 unknown', async () => {
  const kb = await createReadyKnowledgeBase(h, token);
  const d = await uploadSampleDocument(h, token, kb.kbId, { fileName: 'legacy.md' });
  // 历史形态：发送意图已落库，但没有持久化远端身份。
  await h.pool.query(
    "UPDATE operation SET result=(result - 'remoteName') || '{\"stage\":\"upload_attempted\"}'::jsonb WHERE id=$1",
    [d.operationId],
  );
  // 上游存在一个恰好等于新算法推算名的候选，但没有任何证据证明它就是这次上传。
  h.ragflow.documents.set('unproven-candidate', {
    id: 'unproven-candidate',
    datasetId: kb.datasetId,
    name: remoteDocumentName('legacy.md', d.sourceRef, d.version),
    run: 'UNSTART',
    progress: 0,
    chunk_count: null,
    progress_msg: '',
    content: 'UNPROVEN-OTHER-CONTENT',
  });
  await h.operations.advance(d.operationId, h.projectId);
  const { rows: [op] } = await h.pool.query(
    'SELECT state,remote_id FROM operation WHERE id=$1',
    [d.operationId],
  );
  expect(op.remote_id, '推算出来的名字不能证明旧实现曾经发送过它').toBeNull();
  expect(op.state).toBe('unknown_outcome');
});

for (const shape of ['empty', 'multiple', 'wrong-dataset'] as const) {
  it(`上传回包异常（${shape}）必须失败且不触发解析`, async () => {
    const kb = await createReadyKnowledgeBase(h, token);
    const d = await uploadSampleDocument(h, token, kb.kbId);
    const good = { id: 'bad-upload', dataset_id: kb.datasetId };
    const data =
      shape === 'empty'
        ? []
        : shape === 'multiple'
          ? [good, { ...good, id: 'second' }]
          : [{ ...good, dataset_id: 'wrong' }];
    h.ragflow.enqueue((c) => c.method === 'POST' && c.path.endsWith('/documents'), {
      status: 200,
      body: { code: 0, data },
    });
    await h.operations.advance(d.operationId, h.projectId);
    const { rows: [op] } = await h.pool.query('SELECT state FROM operation WHERE id=$1', [
      d.operationId,
    ]);
    expect(op.state).toBe('failed');
    expect(h.ragflow.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/chunks'))).toHaveLength(0);
  });
}
