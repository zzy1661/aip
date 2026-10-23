import {
  CONTENT_MAX_BYTES,
  DELEGATABLE_PERMISSIONS,
  INSTRUCTIONS_MAX_BYTES,
  PAYLOAD_MAX_BYTES,
  type AgentPayload,
  type ContractField,
  type Permission,
  type SkillPayload,
} from '@aip/contracts';
import { apiError, fieldIssue } from '../http/errors.js';
import { isSemver } from '@aip/contracts';

/** 数值契约必须精确绑定概念与单位，缺失即拒绝，不做降级。 */
const NUMERIC_DATA_TYPES = new Set(['NUMBER']);

const FORBIDDEN_CONFIG_KEY = /(token|secret|password|passwd|credential|api_?key|access_?key|endpoint|command|cmd|exec|plugin|script|hook|path|dir)/i;

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** 资产主键是 uuid 列；非法格式必须在边界被拒绝，否则会变成数据库层的 500。 */
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function assertVersionFormat(version: string, fieldPath: string): void {
  if (!isSemver(version)) {
    throw apiError(
      'INVALID_VERSION',
      'version must be exactly MAJOR.MINOR.PATCH',
      [fieldIssue(fieldPath, 'expected MAJOR.MINOR.PATCH, e.g. 1.0.0')],
    );
  }
}

export function assertPayloadSize(payload: unknown, fieldPath = 'payload'): void {
  const size = byteLength(JSON.stringify(payload));
  if (size > PAYLOAD_MAX_BYTES) {
    throw apiError('UPLOAD_TOO_LARGE', 'payload exceeds the platform size limit', [
      fieldIssue(fieldPath, `payload size ${size} exceeds ${PAYLOAD_MAX_BYTES} bytes`),
    ]);
  }
}

export interface SkillSemanticInput {
  payload: SkillPayload;
  /** 是否存在任何概念引用。 */
  hasConceptRefs(): boolean;
}

export function validateSkillPayload(payload: SkillPayload): void {
  assertPayloadSize(payload);

  const bodySize = byteLength(payload.content.body);
  if (bodySize > CONTENT_MAX_BYTES) {
    throw apiError('UPLOAD_TOO_LARGE', 'skill content exceeds the platform size limit', [
      fieldIssue(
        'payload.content.body',
        `content size ${bodySize} exceeds ${CONTENT_MAX_BYTES} bytes`,
      ),
    ]);
  }

  const contracts: Array<{ field: ContractField; path: string }> = [
    ...payload.input_contract.map((field, index) => ({
      field,
      path: `payload.input_contract[${index}]`,
    })),
    ...payload.output_contract.map((field, index) => ({
      field,
      path: `payload.output_contract[${index}]`,
    })),
  ];

  for (const { field, path } of contracts) {
    if (NUMERIC_DATA_TYPES.has(field.data_type)) {
      if (!field.concept_ref) {
        throw apiError('CONTRACT_INVALID', 'numeric contract requires a concept reference', [
          fieldIssue(`${path}.concept_ref`, 'numeric data type requires an exact concept_ref'),
        ]);
      }
      if (!field.unit_ref) {
        throw apiError('CONTRACT_INVALID', 'numeric contract requires a unit reference', [
          fieldIssue(`${path}.unit_ref`, 'numeric data type requires an exact unit_ref'),
        ]);
      }
      if (!field.ontology_version) {
        throw apiError('CONTRACT_INVALID', 'numeric contract requires an ontology version', [
          fieldIssue(
            `${path}.ontology_version`,
            'numeric data type requires an exact ontology_version',
          ),
        ]);
      }
      if (!field.vocabulary_version) {
        throw apiError('CONTRACT_INVALID', 'numeric contract requires a vocabulary version', [
          fieldIssue(
            `${path}.vocabulary_version`,
            'numeric data type requires an exact vocabulary_version',
          ),
        ]);
      }
    }
  }

  const hasConceptRefs = contracts.some((entry) => entry.field.concept_ref !== null);
  if (hasConceptRefs) {
    if (payload.concept_validation !== 'validated') {
      throw apiError(
        'CONTRACT_INVALID',
        'concept references require concept_validation=validated',
        [fieldIssue('payload.concept_validation', 'must be validated when concept_ref is present')],
      );
    }
  } else if (payload.concept_validation !== 'not_requested') {
    throw apiError(
      'CONTRACT_INVALID',
      'skills without concept references must declare concept_validation=not_requested',
      [fieldIssue('payload.concept_validation', 'must be not_requested when no concept_ref is present')],
    );
  }
}

export function validateAgentPayload(
  payload: AgentPayload,
  callerPermissions: readonly Permission[],
): void {
  assertPayloadSize(payload);

  const instructionSize = byteLength(payload.instructions);
  if (instructionSize > INSTRUCTIONS_MAX_BYTES) {
    throw apiError('UPLOAD_TOO_LARGE', 'agent instructions exceed the platform size limit', [
      fieldIssue(
        'payload.instructions',
        `instructions size ${instructionSize} exceeds ${INSTRUCTIONS_MAX_BYTES} bytes`,
      ),
    ]);
  }

  const seen = new Set<string>();
  payload.skill_refs.forEach((ref, index) => {
    if (!UUID_LIKE.test(ref.asset_id)) {
      throw apiError('CONTRACT_INVALID', 'skill reference id is malformed', [
        fieldIssue(`payload.skill_refs[${index}].asset_id`, 'must be a uuid asset id'),
      ]);
    }
    const key = `${ref.asset_id}@${ref.version}`;
    if (seen.has(key)) {
      throw apiError('CONTRACT_INVALID', 'duplicate skill reference', [
        fieldIssue(`payload.skill_refs[${index}]`, `duplicate reference ${key}`),
      ]);
    }
    seen.add(key);
  });

  for (const permission of payload.requested_permissions) {
    if (!DELEGATABLE_PERMISSIONS.includes(permission as Permission)) {
      throw apiError('CONTRACT_INVALID', 'requested permission is not delegatable', [
        fieldIssue('payload.requested_permissions', `permission ${permission} is not delegatable`),
      ]);
    }
    if (!callerPermissions.includes(permission as Permission)) {
      throw apiError('PERMISSION_ESCALATION', 'requested permission exceeds the caller permissions', [
        fieldIssue(
          'payload.requested_permissions',
          `permission ${permission} is not held by the current principal`,
        ),
      ]);
    }
  }

  assertNoForbiddenConfig(payload.config);

  if (payload.execution_enabled === true) {
    throw apiError('CONTRACT_INVALID', 'agent execution is not available in this batch', [
      fieldIssue('payload.execution_enabled', 'execution_enabled must be false'),
    ]);
  }
}

function assertNoForbiddenConfig(config: Record<string, unknown>, path = 'payload.config'): void {
  for (const [key, value] of Object.entries(config)) {
    const keyPath = `${path}.${key}`;
    if (FORBIDDEN_CONFIG_KEY.test(key)) {
      throw apiError('CONTRACT_INVALID', 'agent config contains a forbidden entry', [
        fieldIssue(keyPath, `configuration key ${key} is not allowed`),
      ]);
    }
    if (typeof value === 'string') {
      if (URL_LIKE.test(value)) {
        throw apiError('CONTRACT_INVALID', 'agent config must not contain endpoints', [
          fieldIssue(keyPath, 'endpoint-like configuration values are not allowed'),
        ]);
      }
    } else if (value && typeof value === 'object') {
      assertNoForbiddenConfig(value as Record<string, unknown>, keyPath);
    }
  }
}
