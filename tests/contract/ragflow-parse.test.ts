import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import {
  completeUpstreamParse,
  createReadyKnowledgeBase,
  uploadSampleDocument,
} from '../helpers/flow.js';

/**
 * M13：解析状态轮询契约。
 *
 * 断言口径：只有上游同时给出 DONE、进度完成且分块数大于 0，知识版本才进入 ready；
 * FAIL/CANCEL 是终态失败；DONE 但零分块不得伪装成有内容。
 */
describe('M13 RAGFlow 解析状态契约', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm13' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('上游仍在解析时保持 in_progress，不提前置为 ready', async () => {
    harness.ragflow.reset();
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M13 解析中');
    const uploaded = await uploadSampleDocument(harness, token, kbId, { marker: 'M13-RUNNING' });

    await harness.advanceAll();

    const document = harness.ragflow.documents.get(
      [...harness.ragflow.documents.keys()].at(-1)!,
    );
    expect(document?.run).toBe('RUNNING');

    const detail = await harness.request({
      method: 'GET',
      path: `/knowledge/${uploaded.knowledgeRef}/versions/${uploaded.version}`,
      token,
    });
    expect(detail.body.data.status).not.toBe('ready');
  });

  it('DONE 且进度完成、分块数大于 0 时进入 ready 并登记索引版本', async () => {
    harness.ragflow.reset();
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M13 完成');
    const uploaded = await uploadSampleDocument(harness, token, kbId, { marker: 'M13-DONE' });

    await harness.advanceAll();
    completeUpstreamParse(harness, { chunkCount: 3 });
    await harness.advanceAll();

    const detail = await harness.request({
      method: 'GET',
      path: `/knowledge/${uploaded.knowledgeRef}/versions/${uploaded.version}`,
      token,
    });
    expect(detail.body.data.status).toBe('ready');
    expect(detail.body.data.chunk_count).toBe(3);
    expect(detail.body.data.index_revision).toBeTruthy();
  });

  it('上游 FAIL 时操作进入失败终态', async () => {
    harness.ragflow.reset();
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M13 失败');
    const uploaded = await uploadSampleDocument(harness, token, kbId, { marker: 'M13-FAIL' });

    await harness.advanceAll();
    const document = harness.ragflow.documents.get([...harness.ragflow.documents.keys()].at(-1)!);
    document!.run = 'FAIL';
    document!.progress_msg = 'parser crashed';
    await harness.advanceAll();

    const detail = await harness.request({
      method: 'GET',
      path: `/knowledge/${uploaded.knowledgeRef}/versions/${uploaded.version}`,
      token,
    });
    expect(detail.body.data.status).toBe('failed');
    expect(detail.body.data.last_error).toContain('parse failed');
  });

  it('上游 CANCEL 时按失败处理', async () => {
    harness.ragflow.reset();
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M13 取消');
    const uploaded = await uploadSampleDocument(harness, token, kbId, { marker: 'M13-CANCEL' });

    await harness.advanceAll();
    const document = harness.ragflow.documents.get([...harness.ragflow.documents.keys()].at(-1)!);
    document!.run = 'CANCEL';
    await harness.advanceAll();

    const detail = await harness.request({
      method: 'GET',
      path: `/knowledge/${uploaded.knowledgeRef}/versions/${uploaded.version}`,
      token,
    });
    expect(detail.body.data.status).not.toBe('ready');
    expect(detail.body.data.last_error).toContain('cancelled');
  });

  it('上游 DONE 但零分块时记为 empty，不得伪装成有内容', async () => {
    harness.ragflow.reset();
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M13 空文档');
    const uploaded = await uploadSampleDocument(harness, token, kbId, { marker: 'M13-EMPTY' });

    await harness.advanceAll();
    completeUpstreamParse(harness, { chunkCount: 0 });
    await harness.advanceAll();

    const detail = await harness.request({
      method: 'GET',
      path: `/knowledge/${uploaded.knowledgeRef}/versions/${uploaded.version}`,
      token,
    });
    expect(detail.body.data.status).toBe('empty');
    expect(detail.body.data.index_revision).toBeNull();
  });
});
