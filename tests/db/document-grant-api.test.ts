import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import {
  createReadyKnowledgeBase,
  prepareApprovedDocument,
  seedRetrievalChunk,
} from '../helpers/flow.js';

/**
 * M-6：文档级授权必须有对外 API。
 *
 * 断言口径：
 * - 授予后目标主体可检索到该文档的证据；
 * - 撤销后目标主体立即检索不到，且不可下载；
 * - 授权管理需要 knowledge:manage，缺失即 403；
 * - 授权集合本身可被列出，撤销是可判定的状态而不是「消失」。
 */
describe('M-6 文档级授权 API', () => {
  let harness: Harness;
  let managerToken: string;
  let readerToken: string;
  let kbId: string;
  let knowledgeRef: string;
  let version: string;
  let documentId: string;
  let datasetId: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm6' });
    managerToken = await harness.token({ permissions: ALL_PERMISSIONS });
    // 目标主体只有读取与下载能力，没有授权管理能力。
    readerToken = await harness.token({
      subject: 'reader-1',
      permissions: ['knowledge:read', 'source:read'],
    });
    const kb = await createReadyKnowledgeBase(harness, managerToken, 'M6 知识库');
    kbId = kb.kbId;
    const document = await prepareApprovedDocument(harness, managerToken, kbId, {
      marker: 'M6-GRANT',
    });
    knowledgeRef = document.knowledgeRef;
    version = document.version;
    documentId = document.documentId;
    datasetId = document.datasetId;
    // 上游命中分块只播种一次：每次检索都追加会让证据条数随调用次数漂移。
    seedRetrievalChunk(harness, { documentId, datasetId, content: 'M6-GRANT' });
  });

  afterAll(async () => {
    await harness.close();
  });

  async function retrieve(token: string): Promise<any> {
    return harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M6-GRANT', kb_ids: [kbId] },
    });
  }

  it('未授予文档读取权的主体检索不到该文档', async () => {
    const response = await retrieve(readerToken);
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('no_match');
    expect(response.body.data.evidence).toHaveLength(0);
  });

  it('缺少 knowledge:manage 的主体不能管理授权', async () => {
    const response = await harness.request({
      method: 'POST',
      path: `/knowledge/${knowledgeRef}/versions/${version}/grants`,
      token: readerToken,
      json: { subject: 'reader-1' },
    });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('授予读取权后目标主体可检索到该文档', async () => {
    const granted = await harness.request({
      method: 'POST',
      path: `/knowledge/${knowledgeRef}/versions/${version}/grants`,
      token: managerToken,
      json: { subject: 'reader-1', can_read: true, can_download: true },
    });
    expect(granted.status).toBe(200);
    expect(granted.body.data.subject).toBe('reader-1');
    expect(granted.body.data.can_read).toBe(true);

    const response = await retrieve(readerToken);
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('authorized_evidence');
    expect(response.body.data.evidence).toHaveLength(1);
    expect(response.body.data.evidence[0].knowledge_ref).toBe(knowledgeRef);
  });

  it('授权集合可被列出', async () => {
    const response = await harness.request({
      method: 'GET',
      path: `/knowledge/${knowledgeRef}/versions/${version}/grants`,
      token: managerToken,
    });
    expect(response.status).toBe(200);
    const grants = response.body.data.grants as any[];
    expect(grants.map((grant) => grant.subject)).toContain('reader-1');
  });

  it('撤销后目标主体立即检索不到该文档', async () => {
    const revoked = await harness.request({
      method: 'DELETE',
      path: `/knowledge/${knowledgeRef}/versions/${version}/grants/reader-1`,
      token: managerToken,
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.data.can_read).toBe(false);
    expect(revoked.body.data.can_download).toBe(false);

    const response = await retrieve(readerToken);
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('no_match');
    expect(response.body.data.evidence).toHaveLength(0);
  });

  it('撤销后目标主体不可下载来源文件', async () => {
    const document = await harness.request({
      method: 'GET',
      path: `/knowledge/${knowledgeRef}/versions/${version}`,
      token: managerToken,
    });
    const sourceFileId = document.body.data.source_file_id as string;

    await harness.request({
      method: 'POST',
      path: `/knowledge/${knowledgeRef}/versions/${version}/grants`,
      token: managerToken,
      json: { subject: 'reader-1', can_read: true, can_download: true },
    });

    const allowed = await harness.request({
      method: 'GET',
      path: `/sources/${sourceFileId}/versions/${version}/download`,
      token: readerToken,
    });
    expect(allowed.status).toBe(200);

    await harness.request({
      method: 'DELETE',
      path: `/knowledge/${knowledgeRef}/versions/${version}/grants/reader-1`,
      token: managerToken,
    });

    const denied = await harness.request({
      method: 'GET',
      path: `/sources/${sourceFileId}/versions/${version}/download`,
      token: readerToken,
    });
    expect(denied.status).toBe(404);
  });

  it('对不存在的知识版本授权返回 404', async () => {
    const response = await harness.request({
      method: 'POST',
      path: `/knowledge/${knowledgeRef}/versions/9.9.9/grants`,
      token: managerToken,
      json: { subject: 'reader-1' },
    });
    expect(response.status).toBe(404);
  });

  it('下载权限必须蕴含读取权限', async () => {
    const response = await harness.request({
      method: 'POST',
      path: `/knowledge/${knowledgeRef}/versions/${version}/grants`,
      token: managerToken,
      json: { subject: 'reader-1', can_read: false, can_download: true },
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('CONTRACT_INVALID');
  });
});
