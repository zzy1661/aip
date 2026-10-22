import { RETRIEVAL_TOP_N_MAX } from './common.js';

export interface KnowledgeBaseSummary {
  kb_id: string;
  name: string;
  description: string;
  status: string;
  ragflow_dataset_id: string | null;
  operation_id: string | null;
  created_at: string;
}

export interface KnowledgeBaseDetail extends KnowledgeBaseSummary {
  document_count: number;
}

export interface DocumentSummary {
  knowledge_id: string;
  version: string;
  kb_id: string;
  source_file_id: string;
  source_file_version: string;
  source_file_name: string;
  source_sha256: string;
  mime: string;
  size: number;
  review_status: string;
  status: string;
  state_revision: number;
  index_revision: string | null;
  chunk_count: number | null;
  last_error: string | null;
  stale: boolean;
  applies_to: Record<string, unknown>;
  created_at: string;
}

export interface KnowledgeReviewRequest {
  decision: 'approved' | 'rejected';
  expected_hash: string;
  reason: string;
}

export interface KnowledgeReviewRecord {
  knowledge_id: string;
  version: string;
  decision: 'approved' | 'rejected';
  reviewer: string;
  expected_hash: string;
  reason: string;
  reviewed_at: string;
}

export interface KnowledgeWithdrawRequest {
  expected_state_revision: number;
  reason: string;
}

export interface AppliesTo {
  mode: 'unconditional' | 'conditional';
  [key: string]: unknown;
}

export interface RetrievalRequest {
  query: string;
  kb_ids: string[];
  knowledge_refs?: string[];
  context?: Record<string, unknown>;
  top_n?: number;
}

export type RetrievalStatus = 'authorized_evidence' | 'no_match' | 'needs_context';

export interface SourceLocator {
  source_file_id: string;
  source_file_version: string;
  /** 文本类来源缺少可核验位置时为 true，禁止伪造页码。 */
  incomplete: boolean;
  positions?: unknown[];
  page?: number;
  raw?: string;
}

export interface EvidenceItem {
  evidence_id: string;
  knowledge_ref: string;
  knowledge_version: string;
  index_revision: string;
  source_file_revision: string;
  source_locator: SourceLocator;
  chunk_id: string;
  chunk_hash: string;
  score: number;
  content: string;
}

export interface RetrievalResponse {
  status: RetrievalStatus;
  evidence: EvidenceItem[];
}

export interface OperationView {
  operation_id: string;
  kind: string;
  state: string;
  resource_id: string | null;
  remote_id: string | null;
  attempt: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export const createKnowledgeBaseRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 128 },
    description: { type: 'string', maxLength: 4096 },
  },
} as const;

export const knowledgeReviewRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'expected_hash', 'reason'],
  properties: {
    decision: { type: 'string', enum: ['approved', 'rejected'] },
    expected_hash: { type: 'string', minLength: 1, maxLength: 128 },
    reason: { type: 'string', minLength: 1, maxLength: 1024 },
  },
} as const;

export const knowledgeWithdrawRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['expected_state_revision', 'reason'],
  properties: {
    expected_state_revision: { type: 'integer', minimum: 0 },
    reason: { type: 'string', minLength: 1, maxLength: 1024 },
  },
} as const;

export const retrievalRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['query', 'kb_ids'],
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 4096 },
    kb_ids: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1 } },
    knowledge_refs: { type: 'array', maxItems: 200, items: { type: 'string', minLength: 1 } },
    context: { type: 'object' },
    top_n: { type: 'integer', minimum: 1, maximum: RETRIEVAL_TOP_N_MAX },
  },
} as const;
