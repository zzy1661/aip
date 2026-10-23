import { RagFlowProtocolError, RagFlowUnavailableError } from './errors.js';
import type { RagFlowHttpClient } from './client.js';
import {
  parseCreatedDataset,
  parseDocumentList,
  parseDocumentStatus,
  parseEnvelope,
  parseRetrievalChunks,
  parseUploadedDocuments,
  type DocumentStatus,
  type RetrievedChunk,
} from './schemas.js';

export interface RagFlowAdapterOptions {
  http: RagFlowHttpClient;
  embeddingModel: string;
  parserConfig: Record<string, unknown>;
  chunkMethod: string;
  /** 检索参数初值，仅用于本批可判定行为，不构成业务质量承诺。 */
  similarityThreshold: number;
  vectorSimilarityWeight: number;
  topK: number;
}

export interface RagFlowAdapter {
  createDataset(input: {
    name: string;
    description?: string;
  }): Promise<{ datasetId: string }>;
  uploadDocument(input: {
    datasetId: string;
    filename: string;
    contentType: string;
    content: Buffer;
  }): Promise<{ documentId: string }>;
  startParse(input: { datasetId: string; documentIds: string[] }): Promise<void>;
  getDocumentStatus(input: {
    datasetId: string;
    documentId: string;
  }): Promise<DocumentStatus>;
  retrieve(input: {
    question: string;
    datasetIds: string[];
    documentIds: string[];
    pageSize: number;
  }): Promise<RetrievedChunk[]>;
  /** 撤回后的远端清理。 */
  deleteDocument(input: { datasetId: string; documentId: string }): Promise<void>;
  /** 按名称核对数据集，用于写操作响应丢失后的人工前置核查。 */
  listDatasetsByName(name: string): Promise<Array<{ id: string; name: string }>>;
  /** 列出数据集内的文档，用于上传结果未知时的只读核对。 */
  listDocuments(datasetId: string): Promise<Array<{ id: string; name: string }>>;
}

function assertOk(status: number): void {
  if (status === 200 || status === 201) return;
  if (status === 401 || status === 403) {
    throw new RagFlowUnavailableError('upstream rejected the platform credential', false);
  }
  if (status >= 500) {
    throw new RagFlowUnavailableError(`upstream returned ${status}`, false);
  }
  throw new RagFlowProtocolError(`upstream returned ${status}`);
}

export function createRagFlowAdapter(options: RagFlowAdapterOptions): RagFlowAdapter {
  const { http } = options;

  return {
    async createDataset(input) {
      const body: Record<string, unknown> = {
        name: input.name,
        description: input.description ?? '',
        permission: 'me',
        chunk_method: options.chunkMethod,
      };
      if (options.embeddingModel) body.embedding_model = options.embeddingModel;
      if (Object.keys(options.parserConfig).length > 0) body.parser_config = options.parserConfig;

      const response = await http.execute({
        method: 'POST',
        path: 'datasets',
        idempotentRead: false,
        json: body,
      });
      assertOk(response.status);
      const envelope = parseEnvelope(response.body);
      return { datasetId: parseCreatedDataset(envelope.data).id };
    },

    async uploadDocument(input) {
      const response = await http.execute({
        method: 'POST',
        path: `datasets/${encodeURIComponent(input.datasetId)}/documents`,
        idempotentRead: false,
        multipart: {
          name: 'file',
          filename: input.filename,
          contentType: input.contentType,
          content: input.content,
        },
      });
      assertOk(response.status);
      const envelope = parseEnvelope(response.body);
      const document = parseUploadedDocuments(envelope.data, input.datasetId);
      return { documentId: document.id };
    },

    async startParse(input) {
      if (input.documentIds.length === 0) {
        throw new RagFlowProtocolError('parse requires at least one document id');
      }
      const response = await http.execute({
        method: 'POST',
        path: `datasets/${encodeURIComponent(input.datasetId)}/chunks`,
        idempotentRead: false,
        json: { document_ids: input.documentIds },
      });
      assertOk(response.status);
      parseEnvelope(response.body);
    },

    async getDocumentStatus(input) {
      const response = await http.execute({
        method: 'GET',
        path:
          `datasets/${encodeURIComponent(input.datasetId)}/documents` +
          `?id=${encodeURIComponent(input.documentId)}&page=1&page_size=1`,
        idempotentRead: true,
      });
      assertOk(response.status);
      const envelope = parseEnvelope(response.body);
      const status = parseDocumentStatus(envelope.data);
      if (status.id !== input.documentId) {
        throw new RagFlowProtocolError('document status response does not match the requested id');
      }
      return status;
    },

    async retrieve(input) {
      if (input.datasetIds.length === 0 || input.documentIds.length === 0) {
        // 该 tag 的实现会在 document_ids 为空时退化为按 metadata 过滤全库，必须阻断。
        throw new RagFlowProtocolError('retrieval requires explicit dataset and document ids');
      }
      const response = await http.execute({
        method: 'POST',
        path: 'retrieval',
        idempotentRead: true,
        json: {
          question: input.question,
          dataset_ids: input.datasetIds,
          document_ids: input.documentIds,
          page: 1,
          page_size: input.pageSize,
          top_k: options.topK,
          similarity_threshold: options.similarityThreshold,
          vector_similarity_weight: options.vectorSimilarityWeight,
          use_kg: false,
          keyword: false,
          // 该 tag 只把字符串 "false" 视为关闭高亮，布尔值会被当成开启。
          highlight: 'false',
        },
      });
      assertOk(response.status);
      const envelope = parseEnvelope(response.body);
      return parseRetrievalChunks(envelope.data);
    },

    async deleteDocument(input) {
      const response = await http.execute({
        method: 'DELETE',
        path: `datasets/${encodeURIComponent(input.datasetId)}/documents/${encodeURIComponent(input.documentId)}`,
        idempotentRead: false,
      });
      assertOk(response.status);
    },

    async listDatasetsByName(name) {
      const response = await http.execute({
        method: 'GET',
        path: `datasets?name=${encodeURIComponent(name)}&page=1&page_size=100`,
        idempotentRead: true,
      });
      assertOk(response.status);
      const envelope = parseEnvelope(response.body);
      if (!Array.isArray(envelope.data)) {
        throw new RagFlowProtocolError('dataset list response data is not an array');
      }
      return envelope.data
        .filter(
          (entry): entry is { id: string; name: string } =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof (entry as { id?: unknown }).id === 'string' &&
            typeof (entry as { name?: unknown }).name === 'string',
        )
        .map((entry) => ({ id: entry.id, name: entry.name }));
    },

    async listDocuments(datasetId) {
      const response = await http.execute({
        method: 'GET',
        path: `datasets/${encodeURIComponent(datasetId)}/documents?page=1&page_size=100`,
        idempotentRead: true,
      });
      assertOk(response.status);
      const envelope = parseEnvelope(response.body);
      return parseDocumentList(envelope.data);
    },
  };
}
