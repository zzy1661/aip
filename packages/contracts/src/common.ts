/**
 * 共享常量与通用类型：版本号、slug、权限、分页。
 * 契约层不依赖运行时库，前端与服务端共用同一份定义。
 */

export const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const ASSET_TYPES = ['Skill', 'Agent'] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export const REGISTRATION_STATUSES = ['registered', 'deprecated', 'revoked'] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export const KNOWLEDGE_REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type KnowledgeReviewStatus = (typeof KNOWLEDGE_REVIEW_STATUSES)[number];

export const KNOWLEDGE_STATUSES = [
  'uploaded',
  'parse_queued',
  'parsing',
  'ready',
  'empty',
  'failed',
  'unknown_outcome',
  'withdrawn',
] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

export const PERMISSIONS = [
  'asset:read',
  'asset:write',
  'asset:manage',
  'asset:bind',
  'knowledge:read',
  'knowledge:write',
  'knowledge:review',
  'knowledge:manage',
  'source:read',
  'operations:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Agent 可请求的权限白名单：不允许把管理类权限下放给被创建的 Agent。 */
export const DELEGATABLE_PERMISSIONS: readonly Permission[] = [
  'asset:read',
  'knowledge:read',
  'source:read',
];

export const DATA_TYPES = ['STRING', 'NUMBER', 'BOOLEAN', 'JSON'] as const;
export type DataType = (typeof DATA_TYPES)[number];

export const CONCEPT_VALIDATION_MODES = ['not_requested', 'validated'] as const;
export type ConceptValidationMode = (typeof CONCEPT_VALIDATION_MODES)[number];

export const LIST_LIMIT_DEFAULT = 20;
export const LIST_LIMIT_MAX = 100;

export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

export const CONTENT_MAX_BYTES = 256 * 1024;

export const PAYLOAD_MAX_BYTES = 512 * 1024;

export const INSTRUCTIONS_MAX_BYTES = 64 * 1024;

export const MAX_SKILL_REFS = 50;

export const MAX_TAGS = 20;

export const MAX_TAG_LENGTH = 32;

export const RETRIEVAL_TOP_N_MAX = 20;

export const RETRIEVAL_MAX_DOCUMENTS = 200;

export function isSemver(value: string): boolean {
  return SEMVER_PATTERN.test(value);
}

export function isSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}
