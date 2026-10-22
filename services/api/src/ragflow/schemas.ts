import { RagFlowBusinessError, RagFlowProtocolError, sanitizeUpstreamMessage } from './errors.js';

/**
 * RAGFlow v0.20.5 固定契约的响应投影。
 * 只接受该 tag 明确出现的字段，未知或缺失一律判定为协议错误，不猜测。
 */

export interface RagFlowEnvelope {
  code: number;
  data: unknown;
  message: string;
}

export function parseEnvelope(body: unknown): RagFlowEnvelope {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new RagFlowProtocolError('response body is not an object');
  }
  const record = body as Record<string, unknown>;
  if (typeof record.code !== 'number') {
    throw new RagFlowProtocolError('response is missing a numeric code');
  }
  const message = sanitizeUpstreamMessage(record.message);
  if (record.code !== 0) {
    throw new RagFlowBusinessError(record.code, message);
  }
  return { code: record.code, data: record.data, message };
}

export function parseCreatedDataset(data: unknown): { id: string } {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new RagFlowProtocolError('dataset creation response data is not an object');
  }
  const id = (data as Record<string, unknown>).id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new RagFlowProtocolError('dataset creation response is missing data.id');
  }
  return { id };
}

export interface UploadedDocument {
  id: string;
  dataset_id: string | null;
}

export function parseUploadedDocuments(data: unknown, datasetId: string): UploadedDocument {
  if (!Array.isArray(data)) {
    throw new RagFlowProtocolError('upload response data is not an array');
  }
  if (data.length !== 1) {
    throw new RagFlowProtocolError(`upload response returned ${data.length} documents, expected 1`);
  }
  const entry = data[0];
  if (typeof entry !== 'object' || entry === null) {
    throw new RagFlowProtocolError('upload response entry is not an object');
  }
  const record = entry as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new RagFlowProtocolError('upload response entry is missing id');
  }
  const reportedDataset =
    typeof record.dataset_id === 'string'
      ? record.dataset_id
      : typeof record.knowledgebase_id === 'string'
        ? record.knowledgebase_id
        : null;
  if (reportedDataset !== null && reportedDataset !== datasetId) {
    throw new RagFlowProtocolError('upload response dataset id does not match the request');
  }
  return { id, dataset_id: reportedDataset };
}

export type RunStatus = 'UNSTART' | 'RUNNING' | 'CANCEL' | 'DONE' | 'FAIL';

/**
 * 该 tag 的列表实现把 0..4 映射为枚举名，但存在重复赋值路径，
 * 因此只接受明确枚举名或 0..4 的字符串表示；null 与未知值都是协议错误。
 */
export function normalizeRunStatus(value: unknown): RunStatus {
  if (typeof value === 'string') {
    const direct = value.toUpperCase();
    if (
      direct === 'UNSTART' ||
      direct === 'RUNNING' ||
      direct === 'CANCEL' ||
      direct === 'DONE' ||
      direct === 'FAIL'
    ) {
      return direct;
    }
    const numeric: Record<string, RunStatus> = {
      '0': 'UNSTART',
      '1': 'RUNNING',
      '2': 'CANCEL',
      '3': 'DONE',
      '4': 'FAIL',
    };
    const mapped = numeric[value];
    if (mapped) return mapped;
  }
  throw new RagFlowProtocolError('document run status is missing or unknown');
}

export interface DocumentStatus {
  id: string;
  run: RunStatus;
  progress: number | null;
  chunk_count: number | null;
  progress_msg: string;
}

export function parseDocumentStatus(data: unknown): DocumentStatus {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new RagFlowProtocolError('document list response data is not an object');
  }
  const record = data as Record<string, unknown>;
  const docs = record.docs;
  if (!Array.isArray(docs) || docs.length === 0) {
    throw new RagFlowProtocolError('document list response contains no docs');
  }
  const doc = docs[0];
  if (typeof doc !== 'object' || doc === null) {
    throw new RagFlowProtocolError('document list entry is not an object');
  }
  const entry = doc as Record<string, unknown>;
  const id = entry.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new RagFlowProtocolError('document list entry is missing id');
  }
  const progress =
    typeof entry.progress === 'number' && Number.isFinite(entry.progress) ? entry.progress : null;
  const chunkCount =
    typeof entry.chunk_count === 'number' && Number.isInteger(entry.chunk_count)
      ? entry.chunk_count
      : null;
  return {
    id,
    run: normalizeRunStatus(entry.run),
    progress,
    chunk_count: chunkCount,
    progress_msg: sanitizeUpstreamMessage(entry.progress_msg),
  };
}

export interface RetrievedChunk {
  id: string;
  content: string;
  document_id: string;
  dataset_id: string;
  similarity: number | null;
  positions: unknown[] | null;
}

export function parseRetrievalChunks(data: unknown): RetrievedChunk[] {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new RagFlowProtocolError('retrieval response data is not an object');
  }
  const chunks = (data as Record<string, unknown>).chunks;
  if (!Array.isArray(chunks)) {
    throw new RagFlowProtocolError('retrieval response is missing chunks');
  }
  return chunks.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new RagFlowProtocolError('retrieval chunk is not an object');
    }
    const record = entry as Record<string, unknown>;
    const id = record.id;
    const content = record.content;
    const documentId = record.document_id;
    const datasetId =
      typeof record.dataset_id === 'string'
        ? record.dataset_id
        : typeof record.kb_id === 'string'
          ? record.kb_id
          : null;
    if (typeof id !== 'string' || id.length === 0) {
      throw new RagFlowProtocolError('retrieval chunk is missing id');
    }
    if (typeof content !== 'string') {
      throw new RagFlowProtocolError('retrieval chunk is missing content');
    }
    if (typeof documentId !== 'string' || documentId.length === 0) {
      throw new RagFlowProtocolError('retrieval chunk is missing document_id');
    }
    if (datasetId === null) {
      throw new RagFlowProtocolError('retrieval chunk is missing dataset identity');
    }
    return {
      id,
      content,
      document_id: documentId,
      dataset_id: datasetId,
      similarity:
        typeof record.similarity === 'number' && Number.isFinite(record.similarity)
          ? record.similarity
          : null,
      positions: Array.isArray(record.positions) ? record.positions : null,
    };
  });
}
