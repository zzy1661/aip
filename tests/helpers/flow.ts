import type { Harness } from './app.js';
import { sampleMarkdown, UNCONDITIONAL_APPLIES_TO } from './fixtures.js';

/**
 * 贯穿流程的公共步骤：建知识库 -> 上传 -> 解析 -> 审核。
 * 每一步都走真实 HTTP 接口，只有 RAGFlow 上游是替身。
 */

export interface KnowledgeBaseFixture {
  kbId: string;
  datasetId: string;
}

export async function createReadyKnowledgeBase(
  harness: Harness,
  token: string,
  name = '测试知识库',
): Promise<KnowledgeBaseFixture> {
  const created = await harness.request({
    method: 'POST',
    path: '/knowledge-bases',
    token,
    idempotencyKey: `kb-${Math.random().toString(36).slice(2, 10)}`,
    json: { name, description: '' },
  });
  if (created.status !== 202) {
    throw new Error(`knowledge base creation failed: ${created.status} ${created.text}`);
  }
  await harness.advanceAll();
  const kbId = created.body.data.kb_id as string;
  const dataset = [...harness.ragflow.datasets.values()].at(-1);
  return { kbId, datasetId: dataset?.id ?? '' };
}

export interface UploadedDocument {
  knowledgeRef: string;
  sourceRef: string;
  operationId: string;
  version: string;
  marker: string;
  content: string;
}

export async function uploadSampleDocument(
  harness: Harness,
  token: string,
  kbId: string,
  options: { marker?: string; version?: string; appliesTo?: string; fileName?: string } = {},
): Promise<UploadedDocument> {
  const marker = options.marker ?? `AIP-SAMPLE-${Math.random().toString(36).slice(2, 10)}`;
  const content = sampleMarkdown(marker);
  const version = options.version ?? '1.0.0';

  const response = await harness.request({
    method: 'POST',
    path: `/knowledge-bases/${kbId}/documents`,
    token,
    idempotencyKey: `doc-${Math.random().toString(36).slice(2, 10)}`,
    fields: {
      version,
      applies_to:
        options.appliesTo ?? JSON.stringify(UNCONDITIONAL_APPLIES_TO),
    },
    file: {
      filename: options.fileName ?? `${marker}.md`,
      contentType: 'text/markdown',
      content,
    },
  });
  if (response.status !== 202) {
    throw new Error(`document upload failed: ${response.status} ${response.text}`);
  }
  return {
    knowledgeRef: response.body.data.knowledge_ref,
    sourceRef: response.body.data.source_ref,
    operationId: response.body.data.operation_id,
    version,
    marker,
    content,
  };
}

/** 让替身上游把文档标记为解析完成。 */
export function completeUpstreamParse(
  harness: Harness,
  options: { chunkCount?: number; documentId?: string } = {},
): string {
  const documents = [...harness.ragflow.documents.values()];
  const target = options.documentId
    ? documents.find((document) => document.id === options.documentId)
    : documents.at(-1);
  if (!target) throw new Error('no upstream document to complete');
  target.run = 'DONE';
  target.progress = 1;
  target.chunk_count = options.chunkCount ?? 1;
  return target.id;
}

/** 上传 -> 解析到 ready，返回知识版本与上游文档。 */
export async function uploadAndParse(
  harness: Harness,
  token: string,
  kbId: string,
  options: { marker?: string; version?: string; appliesTo?: string; fileName?: string } = {},
): Promise<UploadedDocument & { documentId: string; datasetId: string }> {
  const uploaded = await uploadSampleDocument(harness, token, kbId, options);
  await harness.advanceAll();
  const documentId = completeUpstreamParse(harness);
  await harness.advanceAll();
  const datasetId = [...harness.ragflow.documents.values()].at(-1)?.datasetId ?? '';
  return { ...uploaded, documentId, datasetId };
}

/** 审核通过某个知识版本，返回审核后的状态。 */
export async function approveDocument(
  harness: Harness,
  token: string,
  knowledgeRef: string,
  version: string,
  options: { validFrom?: string; validUntil?: string; reason?: string } = {},
): Promise<{ status: number; body: any; text: string }> {
  const detail = await harness.request({
    method: 'GET',
    path: `/knowledge/${knowledgeRef}/versions/${version}`,
    token,
  });
  const contentHash = detail.body.data.content_hash as string;

  return harness.request({
    method: 'POST',
    path: `/knowledge/${knowledgeRef}/versions/${version}/review`,
    token,
    json: {
      decision: 'approved',
      expected_hash: contentHash,
      reason: options.reason ?? '测试审核通过',
      ...(options.validFrom === undefined ? {} : { valid_from: options.validFrom }),
      ...(options.validUntil === undefined ? {} : { valid_until: options.validUntil }),
    },
  });
}

/** 播种一条上游检索分块，用于构造检索回包。 */
export function seedRetrievalChunk(
  harness: Harness,
  options: {
    documentId: string;
    datasetId: string;
    content?: string;
    chunkId?: string;
    positions?: unknown[] | null;
    similarity?: number;
  },
): string {
  const chunkId = options.chunkId ?? `chunk-${Math.random().toString(36).slice(2, 10)}`;
  harness.ragflow.retrievalChunks.push({
    id: chunkId,
    content: options.content ?? '检索命中的知识片段',
    document_id: options.documentId,
    dataset_id: options.datasetId,
    similarity: options.similarity ?? 0.8,
    positions: options.positions ?? null,
  });
  return chunkId;
}

/** 上传 -> 解析完成 -> 审核通过，返回可检索的知识版本。 */
export async function prepareApprovedDocument(
  harness: Harness,
  token: string,
  kbId: string,
  options: { marker?: string; version?: string; appliesTo?: string; fileName?: string } = {},
): Promise<UploadedDocument & { documentId: string; datasetId: string }> {
  const uploaded = await uploadAndParse(harness, token, kbId, options);
  const review = await approveDocument(harness, token, uploaded.knowledgeRef, uploaded.version);
  if (review.status !== 200) {
    throw new Error(`review failed: ${review.status} ${review.text}`);
  }
  return uploaded;
}
