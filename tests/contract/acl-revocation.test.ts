import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { knowledgeAuthorization, withTransaction } from '@aip/api';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import {
  createReadyKnowledgeBase,
  prepareApprovedDocument,
  seedRetrievalChunk,
} from '../helpers/flow.js';

/**
 * M20：授权撤销边界。
 *
 * 断言口径：
 * - 撤销发生在上游调用期间时，交付前必须重新确认授权，撤销后不得再交付证据；
 * - authz_state 行锁只覆盖「末次授权判定 + 有界响应交付」，不得跨越上游网络调用，
 *   因此撤销不会被上游调用期间的行锁阻塞。
 *
 * 边界说明：本平台不承诺召回已经发送出去的字节，只保证「交付点之前」的撤销生效。
 */
describe('M20 授权撤销边界', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm20' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('上游调用期间撤销授权时，交付前重新判定后不再返回证据', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M20 知识库');
    const document = await prepareApprovedDocument(harness, token, kbId, { marker: 'M20-DOC' });
    seedRetrievalChunk(harness, {
      documentId: document.documentId,
      datasetId: document.datasetId,
      content: 'M20-DOC',
    });

    // 上游响应延迟 500ms，期间执行撤销。
    harness.ragflow.enqueue(
      (call) => call.method === 'POST' && call.path === '/api/v1/retrieval',
      {
        status: 200,
        delayMs: 500,
        body: {
          code: 0,
          message: 'success',
          data: {
            chunks: [
              {
                id: 'chunk-m20',
                content: 'M20-DOC',
                document_id: document.documentId,
                dataset_id: document.datasetId,
                similarity: 0.9,
              },
            ],
          },
        },
      },
    );

    const pending = harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M20-DOC', kb_ids: [kbId] },
    });

    await new Promise((resolve) => setTimeout(resolve, 120));
    const revokeStartedAt = Date.now();
    await withTransaction(harness.pool, (client) =>
      knowledgeAuthorization.revokeDocument(client, {
        scopeId: harness.projectId,
        knowledgeId: document.knowledgeRef,
        knowledgeVersion: document.version,
        subject: 'user-1',
      }),
    );
    const revokeFinishedAt = Date.now();

    const response = await pending;
    const responseFinishedAt = Date.now();

    expect(response.status).toBe(200);
    expect(response.body.data.evidence).toHaveLength(0);
    expect(response.body.data.status).toBe('no_match');

    // 行锁不得跨越上游调用：撤销没有被上游等待期阻塞。
    expect(revokeFinishedAt - revokeStartedAt).toBeLessThan(responseFinishedAt - revokeFinishedAt);
  });
});
