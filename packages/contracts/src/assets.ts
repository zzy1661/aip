import {
  CONCEPT_VALIDATION_MODES,
  DATA_TYPES,
  DELEGATABLE_PERMISSIONS,
  MAX_SKILL_REFS,
  MAX_TAG_LENGTH,
  MAX_TAGS,
  SEMVER_PATTERN,
  SLUG_PATTERN,
} from './common.js';

export interface ContractField {
  name: string;
  concept_ref: string | null;
  data_type: (typeof DATA_TYPES)[number];
  unit_ref: string | null;
  /** 数值契约必须绑定精确的本体版本，否则不具备可验证语义。 */
  ontology_version: string | null;
  /** 数值契约必须绑定精确的词表版本。 */
  vocabulary_version: string | null;
  required: boolean;
}

export interface SkillContent {
  kind: 'inline_markdown';
  body: string;
}

export interface SkillPayload {
  content: SkillContent;
  input_contract: ContractField[];
  output_contract: ContractField[];
  concept_validation: (typeof CONCEPT_VALIDATION_MODES)[number];
  tags: string[];
}

export interface SkillRef {
  asset_id: string;
  version: string;
}

export interface AgentPayload {
  instructions: string;
  skill_refs: SkillRef[];
  model_profile_ref: string;
  requested_permissions: string[];
  config: Record<string, unknown>;
  execution_enabled: boolean;
}

export interface RegisterAssetRequest {
  type: 'Skill' | 'Agent';
  slug: string;
  version: string;
  title: string;
  description: string;
  payload: SkillPayload | AgentPayload;
}

export interface NewAssetVersionRequest {
  version: string;
  title: string;
  description: string;
  payload: SkillPayload | AgentPayload;
}

export interface AssetSummary {
  asset_id: string;
  type: 'Skill' | 'Agent';
  slug: string;
  version: string;
  title: string;
  description: string;
  registration_status: string;
  state_revision: number;
  content_hash: string;
  created_by: string;
  created_at: string;
}

export interface AssetBindingView {
  skill_id: string;
  skill_version: string;
  skill_slug: string | null;
  /** 被绑定版本的内容哈希：详情要能证明它精确指向哪个事实。 */
  skill_content_hash: string | null;
  binding_valid: boolean;
}

export interface AssetDetail extends AssetSummary {
  payload: SkillPayload | AgentPayload;
  schema_version: number;
  bindings: AssetBindingView[];
}

export interface AssetStatusChangeRequest {
  status: 'deprecated' | 'revoked';
  expected_state_revision: number;
  reason: string;
}

export interface ValidateAssetRequest extends RegisterAssetRequest {}

/* ------------------------------------------------------------------ */
/* JSON Schema（Ajv 使用）                                             */
/* ------------------------------------------------------------------ */

const slugSchema = {
  type: 'string',
  pattern: SLUG_PATTERN.source,
} as const;

const semverSchema = {
  type: 'string',
  pattern: SEMVER_PATTERN.source,
} as const;

const contractFieldSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'name',
    'concept_ref',
    'data_type',
    'unit_ref',
    'ontology_version',
    'vocabulary_version',
    'required',
  ],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 128 },
    concept_ref: { type: ['string', 'null'], maxLength: 256 },
    data_type: { type: 'string', enum: [...DATA_TYPES] },
    unit_ref: { type: ['string', 'null'], maxLength: 256 },
    ontology_version: { type: ['string', 'null'], maxLength: 256 },
    vocabulary_version: { type: ['string', 'null'], maxLength: 256 },
    required: { type: 'boolean' },
  },
} as const;

export const skillPayloadSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['content', 'input_contract', 'output_contract', 'concept_validation', 'tags'],
  properties: {
    content: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'body'],
      properties: {
        kind: { type: 'string', enum: ['inline_markdown'] },
        body: { type: 'string' },
      },
    },
    input_contract: { type: 'array', items: contractFieldSchema, maxItems: 64 },
    output_contract: { type: 'array', items: contractFieldSchema, maxItems: 64 },
    concept_validation: { type: 'string', enum: [...CONCEPT_VALIDATION_MODES] },
    tags: {
      type: 'array',
      maxItems: MAX_TAGS,
      items: { type: 'string', minLength: 1, maxLength: MAX_TAG_LENGTH },
    },
  },
} as const;

export const agentPayloadSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'instructions',
    'skill_refs',
    'model_profile_ref',
    'requested_permissions',
    'config',
    'execution_enabled',
  ],
  properties: {
    instructions: { type: 'string' },
    skill_refs: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_SKILL_REFS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['asset_id', 'version'],
        properties: {
          asset_id: { type: 'string', minLength: 1, maxLength: 128 },
          version: semverSchema,
        },
      },
    },
    // 只允许标识符形态：model_profile_ref 未来可能成为动态出网入口，
    // 不能承载地址或协议串。
    model_profile_ref: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      pattern: '^[A-Za-z0-9._-]+$',
    },
    requested_permissions: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', enum: [...DELEGATABLE_PERMISSIONS] },
    },
    config: { type: 'object' },
    execution_enabled: { type: 'boolean' },
  },
} as const;

export const registerAssetRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'slug', 'version', 'title', 'description', 'payload'],
  properties: {
    type: { type: 'string', enum: ['Skill', 'Agent'] },
    slug: slugSchema,
    version: semverSchema,
    title: { type: 'string', minLength: 1, maxLength: 128 },
    description: { type: 'string', maxLength: 4096 },
    payload: { type: 'object' },
  },
} as const;

export const newAssetVersionRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'title', 'description', 'payload'],
  properties: {
    version: semverSchema,
    title: { type: 'string', minLength: 1, maxLength: 128 },
    description: { type: 'string', maxLength: 4096 },
    payload: { type: 'object' },
  },
} as const;

export const assetStatusChangeRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'expected_state_revision', 'reason'],
  properties: {
    status: { type: 'string', enum: ['deprecated', 'revoked'] },
    expected_state_revision: { type: 'integer', minimum: 0 },
    reason: { type: 'string', minLength: 1, maxLength: 1024 },
  },
} as const;
