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

  async function resolveSkillRefs(
    client: PoolClient,
    scopeId: string,
    payload: AgentPayload,
  ): Promise<void> {
    // 按稳定顺序加行锁，避免多个 Agent 并发绑定同一批 Skill 时互相死锁。
    const ordered = payload.skill_refs
      .map((ref, index) => ({ ref, index }))
      .sort((a, b) =>
        a.ref.asset_id === b.ref.asset_id
          ? a.ref.version.localeCompare(b.ref.version)
          : a.ref.asset_id.localeCompare(b.ref.asset_id),
      );

    for (const { ref, index } of ordered) {
      assertVersionFormat(ref.version, `payload.skill_refs[${index}].version`);
      const row = await repo.findRevisionForUpdate(
        client,
        scopeId,
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
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_event
         (scope_id, id, subject, actor_source, trace_id, operation, resource_ref, result)
       VALUES ($1, $2, $3, 'principal', $4, $5, $6, $7)`,
      [
        principal.scope,
        newId(),
        principal.subject,
        principal.traceId,
        operation,
        resourceRef,
        result,
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
            await resolveSkillRefs(client, principal.scope, payload as AgentPayload);
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
    });
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

    const requestHash = hashObject({ operation: 'assets.new_version', request });

    return withTransaction(pool, async (client) => {
      const parent = await repo.findAsset(client, principal.scope, assetId);
      if (!parent) {
        throw apiError('NOT_FOUND', 'asset not found');
      }
      const isSkill = parent.type === 'Skill';
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
      }
      const contentHash = hashObject({
        type: parent.type,
        title: request.title,
        description: request.description,
        payload,
      });

      const outcome = await runIdempotent(
        client,
        {
          scopeId: principal.scope,
          subject: principal.subject,
          operation: 'assets.new_version',
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
            await resolveSkillRefs(client, principal.scope, payload as AgentPayload);
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
    });
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
      );
      return {
        data: {
          asset_id: assetId,
          version,
          registration_status: updated.registration_status,
          state_revision: updated.state_revision,
        },
      };
    });
  }

  async function validateOnly(principal: Principal, body: unknown): Promise<unknown> {
    assertVersionFormat((body as { version?: string } | null)?.version ?? '', 'version');
    const request = validator.assert<RegisterAssetRequest>(
      registerAssetRequestSchema,
      body,
    );
    const isSkill = request.type === 'Skill';
    const issues: Array<{ field_path: string; reason: string }> = [];
    let payload: SkillPayload | AgentPayload | null = null;
    try {
      payload = validator.assert<SkillPayload | AgentPayload>(
        isSkill ? skillPayloadSchema : agentPayloadSchema,
        request.payload,
        'payload',
      );
    } catch (error) {
      const apiErr = error as { details?: Array<{ field_path: string; reason: string }> };
      issues.push(...(apiErr.details ?? [{ field_path: 'payload', reason: 'invalid payload' }]));
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
        const apiErr = error as { details?: Array<{ field_path: string; reason: string }> };
        issues.push(...(apiErr.details ?? [{ field_path: 'payload', reason: 'invalid payload' }]));
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
