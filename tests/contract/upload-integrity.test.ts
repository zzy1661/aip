import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { createReadyKnowledgeBase, uploadSampleDocument } from '../helpers/flow.js';

/**
 * M11 / M21：上传的事实与来源文件的完整性。
 *
 * 断言口径：
 * - 上传内容的 sha256 真实落库，且知识版本引用的也是同一个哈希；
 * - 启动解析的写请求只带一个 document_id，且该 id 属于本次知识库的数据集；
 * - 来源下载返回的字节与原始文件逐字节相同，哈希头等于原始内容的 sha256。
 */
describe('M11/M21 上传事实与来源完整性', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm11m21' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('上传内容的 sha256 落库，且知识版本引用同一个哈希', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M11 哈希落库');
    const uploaded = await uploadSampleDocument(harness, token, kbId, { marker: 'M11-SHA256' });
    await harness.advanceAll();

    const expected = createHash('sha256').update(uploaded.content).digest('hex');
    const source = await harness.pool.query<{ sha256: string; size: string }>(
      `SELECT sha256, size::text AS size FROM source_file_revision
        WHERE scope_id = $1 AND id = $2 AND version = $3`,
      [harness.projectId, uploaded.sourceRef, uploaded.version],
    );
    expect(source.rows).toHaveLength(1);
    expect(source.rows[0]!.sha256).toBe(expected);
    expect(Number.parseInt(source.rows[0]!.size, 10)).toBe(
      Buffer.byteLength(uploaded.content, 'utf8'),
    );

    const knowledge = await harness.pool.query<{ content_hash: string }>(
      `SELECT content_hash FROM knowledge_revision
        WHERE scope_id = $1 AND knowledge_id = $2 AND version = $3`,
      [harness.projectId, uploaded.knowledgeRef, uploaded.version],
    );
    expect(knowledge.rows).toHaveLength(1);
    // 知识版本的摘要覆盖了来源文件的哈希，因此它必然不同于来源哈希本身。
    expect(knowledge.rows[0]!.content_hash).not.toBe(expected);
  });

  it('启动解析只带一个 document_id，且属于本次知识库的数据集', async () => {
    harness.ragflow.reset();
    const { kbId, datasetId } = await createReadyKnowledgeBase(harness, token, 'M11 单文档');
    const uploaded = await uploadSampleDocument(harness, token, kbId, { marker: 'M11-ONE-DOC' });
    await harness.advanceAll();

    const upstreamDocument = [...harness.ragflow.documents.values()].at(-1)!;
    expect(upstreamDocument.datasetId).toBe(datasetId);

    const parseCalls = harness.ragflow.calls.filter(
      (call) => call.method === 'POST' && call.path === `/api/v1/datasets/${datasetId}/chunks`,
    );
    expect(parseCalls).toHaveLength(1);
    const payload = JSON.parse(parseCalls[0]!.body) as { document_ids: string[] };
    expect(payload.document_ids).toHaveLength(1);
    expect(payload.document_ids[0]).toBe(upstreamDocument.id);
  });

  it('来源下载返回原始字节，哈希头等于原始内容的 sha256', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M21 下载一致');
    const uploaded = await uploadSampleDocument(harness, token, kbId, { marker: 'M21-DOWNLOAD' });
    await harness.advanceAll();

    const response = await harness.request({
      method: 'GET',
      path: `/sources/${uploaded.sourceRef}/versions/${uploaded.version}/download`,
      token,
    });
    expect(response.status).toBe(200);
    expect(response.text).toBe(uploaded.content);
    expect(response.headers.get('x-content-sha256')).toBe(
      createHash('sha256').update(uploaded.content).digest('hex'),
    );
  });
});
