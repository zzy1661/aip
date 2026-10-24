import type { Pool, PoolClient } from 'pg';
import {
  agentPayloadSchema,
  assetStatusChangeRequestSchema,
  newAssetVersionRequestSchema,
  registerAssetRequestSchema,
  skillPayloadSchema,
  type AgentPayload,
  type AssetDetail,
  type AssetSummary,
  type RegisterAssetRequest,
  type SkillPayload,
} from '@aip/contracts';
import { apiError, fieldIssue } from '../http/errors.js';
import { Validator } from '../http/validate.js';
import { runIdempotent } from '../idempotency/service.js';
import { withTransaction } from '../db/uow.js';
import { hashObject, newId } from '../util/hash.js';
import type { Principal } from '../auth/principal.js';
import type { ConceptValidator } from '../ontology/client.js';
import {
  assertVersionFormat,
  validateAgentPayload,
  validateSkillPayload,
} from './validation.js';
import * as repo from './repository.js';

export interface RegistryDeps {
  pool: Pool;
  validator: Validator;
  concepts: ConceptValidator;
}

export interface RegisterResult {
  statusCode: number;
  body: unknown;
  replayed: boolean;
}

const MAX_PAGE_LIMIT = 100;

/**
 * 并发注册同一 slug / 版本时，唯一约束是最后一道防线。
 * 直接把底层唯一冲突暴露成 500 会让调用方无法区分「重名」与「服务故障」，
 * 这里统一映射为 VERSION_EXISTS（409）。
 */
function mapUniqueViolation(error: unknown, fieldPath: string): never {
  const code = (error as { code?: unknown }).code;
  if (code === '23505') {
    throw apiError('VERSION_EXISTS', 'this asset slug or version is already registered', [
      fieldIssue(fieldPath, 'already registered'),
    ]);
  }
  throw error;
}

/**
 * 触发器抛出的违规按语义细分，而不是一律当成状态冲突。
 *
 * `23001`（restrict_violation）同时被「版本内容不可变」与「绑定两端类型」两个触发器使用，
 * 只看 SQLSTATE 会把绑定类型错误报成状态冲突，甚至落成 500。
 */
function mapTriggerViolation(error: unknown, fieldPath: string): never {
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  if (code === '23001' && typeof message === 'string') {
    if (message.startsWith('asset_revision content columns are immutable')) {
      throw apiError('STATE_CONFLICT', 'asset revision content is immutable', [
        fieldIssue(fieldPath, 'create a new version instead of editing an existing one'),
      ]);
    }
    if (message.startsWith('asset_revision rows are immutable')) {
      throw apiError('STATE_CONFLICT', 'asset revision rows are immutable', [
        fieldIssue(fieldPath, 'rows cannot be deleted'),
      ]);
    }
    if (message.startsWith('binding endpoint must reference')) {
      throw apiError('CONTRACT_INVALID', 'skill binding endpoints have the wrong asset type', [
        fieldIssue(fieldPath, 'an Agent version can only bind a Skill version'),
      ]);
    }
    if (message.startsWith('illegal registration_status transition')) {
      throw apiError('STATE_CONFLICT', 'the requested registration status transition is not allowed', [
        fieldIssue(fieldPath, 'revoked is terminal and statuses only move forward'),
      ]);
    }
  }
  throw error;
}

export function createRegistryService(deps: RegistryDeps) {
  const { pool, validator, concepts } = deps;

  async function validateSkillConcepts(payload: SkillPayload): Promise<void> {
    const refs = [...payload.input_contract, ...payload.output_contract]
      .filter((field) => field.concept_ref !== null)
      .map((field) => ({
        concept_ref: field.concept_ref as string,
        unit_ref: field.unit_ref,
        ontology_version: field.ontology_version,
        vocabulary_version: field.vocabulary_version,
      }));
    if (refs.length === 0) return;
    const outcome = await concepts.validate(refs);
    if (!outcome.ok) {
      throw apiError('CONTRACT_INVALID', 'concept reference validation failed', [
        fieldIssue(outcome.field_path, outcome.reason),
      ]);
    }
  }

  /**
   * 绑定权限检查。
   *
   * 绑定既要求 asset:bind（变更绑定关系的能力），也要求 asset:read（读取被绑定 Skill 的能力）。
   * 服务端强制校验，页面权限表只是提示，不能作为唯一防线。
   *
   * 单独成函数是为了让它在任何写库动作之前执行：权限不足不应该先写资产再回滚。
   */
  function assertBindingPermissions(principal: Principal): void {
    for (const permission of ['asset:bind', 'asset:read'] as const) {
      if (!principal.permissions.includes(permission)) {
        throw apiError('FORBIDDEN', `binding skills requires the ${permission} permission`, [
          fieldIssue('payload.skill_refs', `missing permission: ${permission}`),
        ]);
      }
    }
  }

  async function resolveSkillRefs(
    client: PoolClient,
    principal: Principal,
    payload: AgentPayload,
  ): Promise<void> {
    // 这里只做需要行锁的数据库核对；权限判断已在写库之前完成。
    assertBindingPermissions(principal);

    // 按稳定顺序加行锁，避免多个 Agent 并发绑定同一批 Skill 时互相死锁。
    // 固定字节序比较：localeCompare 受运行环境 locale/ICU 影响，
    // 不同实例的加锁顺序可能不一致。
    const ordered = payload.skill_refs
      .map((ref, index) => ({ ref, index }))
      .sort((a, b) =>
        a.ref.asset_id === b.ref.asset_id
          ? compareBytes(a.ref.version, b.ref.version)
          : compareBytes(a.ref.asset_id, b.ref.asset_id),
      );

    for (const { ref, index } of ordered) {
      assertVersionFormat(ref.version, `payload.skill_refs[${index}].version`);
      const row = await repo.findRevisionForUpdate(
        client,
        principal.scope,
        ref.asset_id,
        ref.version,
      );
      if (!row || row.type !== 'Skill') {
        throw apiError('REF_NOT_AVAILABLE', 'referenced skill version is not available', [
          fieldIssue(`payload.skill_refs[${index}]`, 'referenced skill version is not available'),
        ]);
      }
      if (row.registration_status !== 'registered') {
        throw apiError('REF_NOT_AVAILABLE', 'referenced skill version is not available', [
          fieldIssue(
            `payload.skill_refs[${index}]`,
            `referenced skill version is ${row.registration_status}`,
          ),
        ]);
      }
    }
  }

  async function writeAudit(
    client: PoolClient,
    principal: Principal,
    operation: string,
    resourceRef: string,
    result: string,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_event
         (scope_id, id, subject, actor_source, trace_id, operation, resource_ref, result, detail)
       VALUES ($1, $2, $3, 'principal', $4, $5, $6, $7, $8::jsonb)`,
      [
        principal.scope,
        newId(),
        principal.subject,
        principal.traceId,
        operation,
        resourceRef,
        result,
        JSON.stringify(detail ?? {}),
      ],
    );
  }

  async function register(
    principal: Principal,
    body: unknown,
    idempotencyKey: string,
  ): Promise<RegisterResult> {
    assertVersionFormat((body as { version?: string } | null)?.version ?? '', 'version');
    const request = validator.assert<RegisterAssetRequest>(
      registerAssetRequestSchema,
      body,
    );

    const isSkill = request.type === 'Skill';
    const payload = validator.assert<SkillPayload | AgentPayload>(
      isSkill ? skillPayloadSchema : agentPayloadSchema,
      request.payload,
      'payload',
    );

    if (isSkill) {
      validateSkillPayload(payload as SkillPayload);
      await validateSkillConcepts(payload as SkillPayload);
    } else {
      validateAgentPayload(payload as AgentPayload, principal.permissions);
      // 绑定权限在任何写库动作之前判定。
      assertBindingPermissions(principal);
    }

    const contentHash = hashObject({
      type: request.type,
      title: request.title,
      description: request.description,
      payload,
    });
    const requestHash = hashObject({ operation: 'assets.register', request });

    return withTransaction(pool, async (client) => {
      const outcome = await runIdempotent(
        client,
        {
          scopeId: principal.scope,
          subject: principal.subject,
          operation: 'assets.register',
          key: idempotencyKey,
          requestHash,
        },
        async () => {
          const existing = await repo.findAssetBySlug(
            client,
            principal.scope,
            request.type,
            request.slug,
          );
          if (existing) {
            throw apiError('VERSION_EXISTS', 'an asset with this slug already exists', [
              fieldIssue('slug', `slug ${request.slug} is already registered`),
            ]);
          }
          const assetId = newId();
          await repo.insertAsset(
            client,
            principal.scope,
            assetId,
            request.type,
            request.slug,
            principal.subject,
          );
          await repo.insertAssetRevision(client, {
            scopeId: principal.scope,
            assetId,
            version: request.version,
            title: request.title,
            description: request.description,
            payload,
            contentHash,
            schemaVersion: 1,
            createdBy: principal.subject,
          });
          if (!isSkill) {
            await resolveSkillRefs(client, principal, payload as AgentPayload);
            await repo.insertBindings(
              client,
              principal.scope,
              assetId,
              request.version,
              (payload as AgentPayload).skill_refs,
            );
          }
          await writeAudit(
            client,
            principal,
            'assets.register',
            `${principal.scope}/${assetId}@${request.version}`,
            'succeeded',
          );
          const data = {
            asset_id: assetId,
            version: request.version,
            content_hash: contentHash,
            registration_status: 'registered',
          };
          return { statusCode: 201, body: { data } };
        },
      );
      return {
        statusCode: outcome.response.statusCode,
        body: outcome.response.body,
        replayed: outcome.replayed,
      };
    }).catch((error: unknown) => mapTriggerViolation(mapUniqueViolation(error, 'slug'), 'slug'));
  }

  async function createVersion(
    principal: Principal,
    assetId: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<RegisterResult> {
    assertVersionFormat((body as { version?: string } | null)?.version ?? '', 'version');
    const request = validator.assert<{
      version: string;
      title: string;
      description: string;
      payload: unknown;
    }>(newAssetVersionRequestSchema, body);

    const requestHash = hashObject({ operation: 'assets.new_version', assetId, request });

    // 目标资产类型必须在事务外先读到：本体校验是网络调用，
    // 不能持有数据库事务跨越它，否则慢本体会同时占用连接与锁，并撞上语句超时。
    const parentPreview = await repo.findAsset(pool, principal.scope, assetId);
    if (!parentPreview) {
      throw apiError('NOT_FOUND', 'asset not found');
    }
    const isSkill = parentPreview.type === 'Skill';
    const payload = validator.assert<SkillPayload | AgentPayload>(
      isSkill ? skillPayloadSchema : agentPayloadSchema,
      request.payload,
      'payload',
    );
    if (isSkill) {
      validateSkillPayload(payload as SkillPayload);
      await validateSkillConcepts(payload as SkillPayload);
    } else {
      validateAgentPayload(payload as AgentPayload, principal.permissions);
      // 绑定权限在任何写库动作之前判定。
      assertBindingPermissions(principal);
    }
    const contentHash = hashObject({
      type: parentPreview.type,
      title: request.title,
      description: request.description,
      payload,
    });

    return withTransaction(pool, async (client) => {
      const parent = await repo.findAsset(client, principal.scope, assetId);
      if (!parent) {
        throw apiError('NOT_FOUND', 'asset not found');
      }

      const outcome = await runIdempotent(
        client,
        {
          scopeId: principal.scope,
          subject: principal.subject,
          // 幂等身份绑定目标资产：同一个键用在不同资产上必须各自成立，
          // 否则第二次请求会回放第一次的响应，把版本写到了错误的资产上。
          operation: `assets.new_version:${assetId}`,
          key: idempotencyKey,
          requestHash,
        },
        async () => {
          const exists = await repo.findRevision(
            client,
            principal.scope,
            assetId,
            request.version,
          );
          if (exists) {
            throw apiError('VERSION_EXISTS', 'this asset version already exists', [
              fieldIssue('version', `version ${request.version} already exists`),
            ]);
          }
          await repo.insertAssetRevision(client, {
            scopeId: principal.scope,
            assetId,
            version: request.version,
            title: request.title,
            description: request.description,
            payload,
            contentHash,
            schemaVersion: 1,
            createdBy: principal.subject,
          });
          if (!isSkill) {
            await resolveSkillRefs(client, principal, payload as AgentPayload);
            await repo.insertBindings(
              client,
              principal.scope,
              assetId,
              request.version,
              (payload as AgentPayload).skill_refs,
            );
          }
          await writeAudit(
            client,
            principal,
            'assets.new_version',
            `${principal.scope}/${assetId}@${request.version}`,
            'succeeded',
          );
          return {
            statusCode: 201,
            body: {
              data: {
                asset_id: assetId,
                version: request.version,
                content_hash: contentHash,
                registration_status: 'registered',
              },
            },
          };
        },
      );
      return {
        statusCode: outcome.response.statusCode,
        body: outcome.response.body,
        replayed: outcome.replayed,
      };
    }).catch((error: unknown) => mapTriggerViolation(mapUniqueViolation(error, 'version'), 'version'));
  }

  async function list(
    principal: Principal,
    query: { type?: string; status?: string; cursor?: string; limit?: string },
  ): Promise<{ data: AssetSummary[]; next_cursor: string | null }> {
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const type = query.type === 'Skill' || query.type === 'Agent' ? query.type : undefined;
    const status =
      query.status === 'registered' || query.status === 'deprecated' || query.status === 'revoked'
        ? query.status
        : undefined;

    const rows = await repo.listAssets(pool, principal.scope, {
      type,
      status,
      cursor,
      limit,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const next =
      hasMore && page.length > 0
        ? encodeCursor({ assetId: page[page.length - 1]!.asset_id, version: page[page.length - 1]!.version })
        : null;
    return { data: page.map(repo.toSummary), next_cursor: next };
  }

  async function detail(
    principal: Principal,
    assetId: string,
    version: string,
  ): Promise<AssetDetail> {
    const row = await repo.findRevision(pool, principal.scope, assetId, version);
    if (!row) {
      throw apiError('NOT_FOUND', 'asset version not found');
    }
    const bindings = await repo.listBindings(pool, principal.scope, assetId, version);
    return repo.toDetail(
      row,
      bindings.map((binding) => ({
        skill_id: binding.skill_id,
        skill_version: binding.skill_version,
        skill_slug: binding.skill_slug,
        skill_content_hash: binding.skill_content_hash,
        binding_valid: binding.skill_status === 'registered',
      })),
    );
  }

  async function changeStatus(
    principal: Principal,
    assetId: string,
    version: string,
    body: unknown,
  ): Promise<{ data: unknown }> {
    const request = validator.assert<{
      status: 'deprecated' | 'revoked';
      expected_state_revision: number;
      reason: string;
    }>(assetStatusChangeRequestSchema, body);

    return withTransaction(pool, async (client) => {
      const existing = await repo.findRevision(client, principal.scope, assetId, version);
      if (!existing) {
        throw apiError('NOT_FOUND', 'asset version not found');
      }
      const updated = await repo.updateRegistrationStatus(
        client,
        principal.scope,
        assetId,
        version,
        request.expected_state_revision,
        request.status,
      );
      if (!updated) {
        throw apiError('STATE_CONFLICT', 'state revision is stale', [
          fieldIssue(
            'expected_state_revision',
            `current state revision is ${existing.state_revision}`,
          ),
        ]);
      }
      await writeAudit(
        client,
        principal,
        'assets.status',
        `${principal.scope}/${assetId}@${version}`,
        request.status,
        {
          reason: request.reason,
          from_status: existing.registration_status,
          to_status: request.status,
          state_revision: updated.state_revision,
        },
      );
      return {
        data: {
          asset_id: assetId,
          version,
          registration_status: updated.registration_status,
          state_revision: updated.state_revision,
        },
      };
    }).catch((error: unknown) => mapTriggerViolation(error, 'status'));
  }

  /**
   * 只校验不注册。
   *
   * 这个端点的语义是「把所有问题一次性列出来」，因此连信封层的错误也进问题列表，
   * 始终返回 200；只有鉴权失败才会是 4xx。任何进不去校验器的失败都必须变成一条问题，
   * 否则空问题列表会被读成「校验通过」。
   */
  async function validateOnly(principal: Principal, body: unknown): Promise<unknown> {
    const issues: Array<{ field_path: string; reason: string }> = [];
    let request: RegisterAssetRequest | null = null;
    try {
      assertVersionFormat((body as { version?: string } | null)?.version ?? '', 'version');
      request = validator.assert<RegisterAssetRequest>(registerAssetRequestSchema, body);
    } catch (error) {
      issues.push(...toIssues(error, 'invalid request'));
    }

    if (request) {
      const isSkill = request.type === 'Skill';
      let payload: SkillPayload | AgentPayload | null = null;
      try {
        payload = validator.assert<SkillPayload | AgentPayload>(
          isSkill ? skillPayloadSchema : agentPayloadSchema,
          request.payload,
          'payload',
        );
      } catch (error) {
        issues.push(...toIssues(error, 'invalid payload'));
      }
      if (payload) {
        try {
          if (isSkill) {
            validateSkillPayload(payload as SkillPayload);
            await validateSkillConcepts(payload as SkillPayload);
          } else {
            validateAgentPayload(payload as AgentPayload, principal.permissions);
          }
        } catch (error) {
          issues.push(...toIssues(error, 'invalid payload'));
        }
      }
    }

    return {
      data: {
        passed: issues.length === 0,
        issues,
        note: 'validation result is not a publication or execution approval',
      },
    };
  }

  return { register, createVersion, list, detail, changeStatus, validateOnly };
}

function clampLimit(raw: string | undefined): number {
  if (!raw) return 20;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw apiError('BAD_REQUEST', 'limit must be an integer between 1 and 100');
  }
  if (parsed > MAX_PAGE_LIMIT) {
    throw apiError('BAD_REQUEST', 'limit must be an integer between 1 and 100');
  }
  return parsed;
}

/**
 * 把校验异常转成问题列表。
 *
 * 细节为空的异常（例如本体不可达时的 `ONTO_UNAVAILABLE`）必须降级成一条问题，
 * 否则问题列表为空会被读成「校验通过」——那是伪造成功。
 */
function toIssues(
  error: unknown,
  fallbackReason: string,
): Array<{ field_path: string; reason: string }> {
  const apiErr = error as {
    code?: string;
    message?: string;
    details?: Array<{ field_path: string; reason: string }>;
  };
  if (apiErr.details && apiErr.details.length > 0) {
    return apiErr.details;
  }
  const reason = apiErr.message
    ? `${apiErr.code ? `${apiErr.code}: ` : ''}${apiErr.message}`
    : fallbackReason;
  return [{ field_path: 'payload', reason }];
}

/** 按 UTF-8 字节序比较两个字符串，与运行环境的 locale 无关。 */
export function compareBytes(left: string, right: string): number {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return Buffer.compare(a, b);
}

export function encodeCursor(cursor: { assetId: string; version: string }): string {
  return Buffer.from(`${cursor.assetId}:${cursor.version}`, 'utf8').toString('base64url');
}

export function decodeCursor(
  raw: string | undefined,
): { assetId: string; version: string } | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const separator = decoded.lastIndexOf(':');
    if (separator <= 0) throw new Error('malformed cursor');
    return {
      assetId: decoded.slice(0, separator),
      version: decoded.slice(separator + 1),
    };
  } catch {
    throw apiError('BAD_REQUEST', 'cursor is malformed');
  }
}

export type RegistryService = ReturnType<typeof createRegistryService>;
