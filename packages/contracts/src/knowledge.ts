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
  valid_from: string | null;
  valid_until: string | null;
  /** 知识版本内容摘要：审核接口的 expected_hash 就是它，客户端必须能读到。 */
  content_hash: string;
  created_at: string;
}

export interface KnowledgeReviewRequest {
  decision: 'approved' | 'rejected';
  expected_hash: string;
  reason: string;
  /** 审核生效起点，缺省表示立即生效。 */
  valid_from?: string;
  /** 审核失效点，缺省表示长期有效。 */
  valid_until?: string;
}

export interface KnowledgeReviewRecord {
  knowledge_id: string;
  version: string;
  decision: 'approved' | 'rejected';
  reviewer: string;
  expected_hash: string;
  reason: string;
  reviewed_at: string;
  valid_from: string | null;
  valid_until: string | null;
}

export interface KnowledgeWithdrawRequest {
  expected_state_revision: number;
  reason: string;
}

export interface AppliesToConditions {
  [key: string]: string | number | boolean | null;
}

export interface AppliesTo {
  mode: 'unconditional' | 'conditional';
  /** mode=conditional 时必填，键值必须全部在检索上下文中命中才算适用。 */
  conditions?: AppliesToConditions;
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
  /** 来源文件修订行的标识（uuid）；具体版本见 source_locator.source_file_version。 */
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

/**
 * 文档级授权的对外视图。
 *
 * 授权是文档级而不是项目级的：主体只能读到被显式授予的知识版本。
 */
export interface DocumentGrantView {
  knowledge_id: string;
  version: string;
  subject: string;
  can_read: boolean;
  can_download: boolean;
}

export const documentGrantRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['subject'],
  properties: {
    subject: { type: 'string', minLength: 1, maxLength: 128 },
    can_read: { type: 'boolean' },
    can_download: { type: 'boolean' },
  },
} as const;

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

/**
 * 适用条件契约。
 *
 * - mode=unconditional：不得携带 conditions，避免出现「声明了条件却不生效」的歧义。
 * - mode=conditional：必须携带非空 conditions，否则等同于通用知识，会绕过适用性判定。
 */
export const appliesToSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['mode'],
  properties: {
    mode: { type: 'string', enum: ['unconditional', 'conditional'] },
    conditions: {
      type: 'object',
      minProperties: 1,
      additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
    },
  },
  allOf: [
    {
      if: { properties: { mode: { const: 'conditional' } }, required: ['mode'] },
      then: {
        required: ['conditions'],
        properties: { conditions: { type: 'object', minProperties: 1 } },
      },
    },
    {
      if: { properties: { mode: { const: 'unconditional' } }, required: ['mode'] },
      then: { properties: { conditions: false } },
    },
  ],
} as const;

export const knowledgeReviewRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'expected_hash', 'reason'],
  properties: {
    decision: { type: 'string', enum: ['approved', 'rejected'] },
    expected_hash: { type: 'string', minLength: 1, maxLength: 128 },
    reason: { type: 'string', minLength: 1, maxLength: 1024 },
    valid_from: { type: 'string', format: 'date-time' },
    valid_until: { type: 'string', format: 'date-time' },
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
    // kb_ids / knowledge_refs 会直接进入 uuid 列与 uuid[] 强制转换，
    // 非法格式必须在边界被拒绝，否则会退化成数据库层的 500。
    kb_ids: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: { type: 'string', format: 'uuid' },
    },
    knowledge_refs: { type: 'array', maxItems: 200, items: { type: 'string', format: 'uuid' } },
    context: { type: 'object' },
    top_n: { type: 'integer', minimum: 1, maximum: RETRIEVAL_TOP_N_MAX },
  },
} as const;

/**
 * 适用条件判定。契约层与服务端共用同一份实现，避免前后端口径不一致。
 *
 * - mode=unconditional：始终适用。
 * - mode=conditional：conditions 的每个键都必须在检索上下文中出现且取值相等。
 */
export function isApplicable(
  appliesTo: unknown,
  context: Record<string, unknown> | undefined,
): boolean {
  if (typeof appliesTo !== 'object' || appliesTo === null || Array.isArray(appliesTo)) {
    return false;
  }
  const record = appliesTo as Record<string, unknown>;
  if (record.mode === 'unconditional') return true;
  if (record.mode !== 'conditional') return false;
  const conditions = record.conditions;
  if (typeof conditions !== 'object' || conditions === null || Array.isArray(conditions)) {
    return false;
  }
  const entries = Object.entries(conditions as AppliesToConditions);
  if (entries.length === 0) return false;
  if (!context) return false;
  return entries.every(([key, expected]) => {
    if (!Object.prototype.hasOwnProperty.call(context, key)) return false;
    return context[key] === expected;
  });
}

/** 是否为条件适用：用于区分「上下文不足」与「确实没有可检索内容」。 */
export function isConditional(appliesTo: unknown): boolean {
  if (typeof appliesTo !== 'object' || appliesTo === null || Array.isArray(appliesTo)) {
    return false;
  }
  return (appliesTo as Record<string, unknown>).mode === 'conditional';
}
