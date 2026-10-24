import type { QueryClient } from '../db/pool.js';
import type { AssetDetail, AssetSummary, RegistrationStatus, SkillRef } from '@aip/contracts';
import { redactSecretValues } from './config-policy.js';

export interface AssetRow {
  asset_id: string;
  type: 'Skill' | 'Agent';
  slug: string;
  version: string;
  title: string;
  description: string;
  content_hash: string;
  schema_version: number;
  registration_status: RegistrationStatus;
  created_by: string;
  created_at: Date;
  state_revision: number;
  payload?: unknown;
}

export interface AssetTypeRow {
  type: 'Skill' | 'Agent';
  slug: string;
}

export async function findAssetBySlug(
  client: QueryClient,
  scopeId: string,
  type: 'Skill' | 'Agent',
  slug: string,
): Promise<AssetTypeRow | null> {
  const { rows } = await client.query<AssetTypeRow>(
    `SELECT type, slug FROM asset WHERE scope_id = $1 AND type = $2 AND slug = $3`,
    [scopeId, type, slug],
  );
  return rows[0] ?? null;
}

export async function insertAsset(
  client: QueryClient,
  scopeId: string,
  assetId: string,
  type: 'Skill' | 'Agent',
  slug: string,
  owner: string,
): Promise<void> {
  await client.query(
    `INSERT INTO asset (scope_id, id, type, slug, owner) VALUES ($1, $2, $3, $4, $5)`,
    [scopeId, assetId, type, slug, owner],
  );
}

export interface InsertRevisionInput {
  scopeId: string;
  assetId: string;
  version: string;
  title: string;
  description: string;
  payload: unknown;
  contentHash: string;
  schemaVersion: number;
  createdBy: string;
}

export async function insertAssetRevision(
  client: QueryClient,
  input: InsertRevisionInput,
): Promise<void> {
  await client.query(
    `INSERT INTO asset_revision
       (scope_id, asset_id, version, title, description, payload, content_hash,
        schema_version, registration_status, created_by, state_revision)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'registered', $9, 1)`,
    [
      input.scopeId,
      input.assetId,
      input.version,
      input.title,
      input.description,
      JSON.stringify(input.payload),
      input.contentHash,
      input.schemaVersion,
      input.createdBy,
    ],
  );
}

const ASSET_SELECT = `
  SELECT r.asset_id, a.type, a.slug, r.version, r.title, r.description,
         r.content_hash, r.schema_version, r.registration_status, r.created_by,
         r.created_at, r.state_revision, r.payload
    FROM asset_revision r
    JOIN asset a ON a.scope_id = r.scope_id AND a.id = r.asset_id
`;

export async function findRevision(
  client: QueryClient,
  scopeId: string,
  assetId: string,
  version: string,
): Promise<AssetRow | null> {
  const { rows } = await client.query<AssetRow>(
    `${ASSET_SELECT} WHERE r.scope_id = $1 AND r.asset_id = $2 AND r.version = $3`,
    [scopeId, assetId, version],
  );
  return rows[0] ?? null;
}

/** 行锁读取：用于把「引用校验」与「状态变更」在同一版本行上线性化。 */
export async function findRevisionForUpdate(
  client: QueryClient,
  scopeId: string,
  assetId: string,
  version: string,
): Promise<AssetRow | null> {
  const { rows } = await client.query<AssetRow>(
    `${ASSET_SELECT} WHERE r.scope_id = $1 AND r.asset_id = $2 AND r.version = $3 FOR UPDATE`,
    [scopeId, assetId, version],
  );
  return rows[0] ?? null;
}

export async function findAsset(
  client: QueryClient,
  scopeId: string,
  assetId: string,
): Promise<{ id: string; type: 'Skill' | 'Agent'; slug: string } | null> {
  const { rows } = await client.query<{ id: string; type: 'Skill' | 'Agent'; slug: string }>(
    `SELECT id, type, slug FROM asset WHERE scope_id = $1 AND id = $2`,
    [scopeId, assetId],
  );
  return rows[0] ?? null;
}

export async function findRevisionBySlug(
  client: QueryClient,
  scopeId: string,
  type: 'Skill' | 'Agent',
  slug: string,
  version: string,
): Promise<AssetRow | null> {
  const { rows } = await client.query<AssetRow>(
    `${ASSET_SELECT} WHERE r.scope_id = $1 AND a.type = $2 AND a.slug = $3 AND r.version = $4`,
    [scopeId, type, slug, version],
  );
  return rows[0] ?? null;
}

export interface ListFilter {
  type?: 'Skill' | 'Agent';
  status?: RegistrationStatus;
  cursor?: { assetId: string; version: string } | null;
  limit: number;
}

export async function listAssets(
  client: QueryClient,
  scopeId: string,
  filter: ListFilter,
): Promise<AssetRow[]> {
  const conditions = ['r.scope_id = $1'];
  const values: unknown[] = [scopeId];
  if (filter.type) {
    values.push(filter.type);
    conditions.push(`a.type = $${values.length}`);
  }
  if (filter.status) {
    values.push(filter.status);
    conditions.push(`r.registration_status = $${values.length}`);
  }
  if (filter.cursor) {
    values.push(filter.cursor.assetId, filter.cursor.version);
    // 版本号按 semver 序比较：文本序下 1.0.10 < 1.0.9，分页会漏版本。
    conditions.push(
      `(r.asset_id, string_to_array(r.version, '.')::int[]) > ($${values.length - 1}::uuid, string_to_array($${values.length}, '.')::int[])`,
    );
  }
  values.push(filter.limit + 1);
  const { rows } = await client.query<AssetRow>(
    `${ASSET_SELECT} WHERE ${conditions.join(' AND ')}
      ORDER BY r.asset_id, string_to_array(r.version, '.')::int[]
      LIMIT $${values.length}`,
    values,
  );
  return rows;
}

export async function updateRegistrationStatus(
  client: QueryClient,
  scopeId: string,
  assetId: string,
  version: string,
  expectedStateRevision: number,
  status: 'deprecated' | 'revoked',
): Promise<AssetRow | null> {
  const { rows } = await client.query<AssetRow>(
    `UPDATE asset_revision
        SET registration_status = $5, state_revision = state_revision + 1
      WHERE scope_id = $1 AND asset_id = $2 AND version = $3 AND state_revision = $4
      RETURNING asset_id, version, registration_status, state_revision`,
    [scopeId, assetId, version, expectedStateRevision, status],
  );
  return rows[0] ?? null;
}

export async function insertBindings(
  client: QueryClient,
  scopeId: string,
  agentId: string,
  agentVersion: string,
  refs: SkillRef[],
): Promise<void> {
  for (const [index, ref] of refs.entries()) {
    await client.query(
      `INSERT INTO agent_skill_binding
         (scope_id, agent_id, agent_version, skill_id, skill_version, ordinal)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [scopeId, agentId, agentVersion, ref.asset_id, ref.version, index],
    );
  }
}

export interface BindingRow {
  skill_id: string;
  skill_version: string;
  skill_slug: string | null;
  skill_status: RegistrationStatus | null;
  skill_content_hash: string | null;
}

export async function listBindings(
  client: QueryClient,
  scopeId: string,
  agentId: string,
  agentVersion: string,
): Promise<BindingRow[]> {
  const { rows } = await client.query<BindingRow>(
    `SELECT b.skill_id, b.skill_version, a.slug AS skill_slug,
            r.registration_status AS skill_status,
            r.content_hash AS skill_content_hash
       FROM agent_skill_binding b
       LEFT JOIN asset_revision r
         ON r.scope_id = b.scope_id AND r.asset_id = b.skill_id AND r.version = b.skill_version
       LEFT JOIN asset a ON a.scope_id = r.scope_id AND a.id = r.asset_id
      WHERE b.scope_id = $1 AND b.agent_id = $2 AND b.agent_version = $3
      ORDER BY b.ordinal`,
    [scopeId, agentId, agentVersion],
  );
  return rows;
}

export function toSummary(row: AssetRow): AssetSummary {
  return {
    asset_id: row.asset_id,
    type: row.type,
    slug: row.slug,
    version: row.version,
    title: row.title,
    description: row.description,
    registration_status: row.registration_status,
    state_revision: row.state_revision,
    content_hash: row.content_hash,
    created_by: row.created_by,
    created_at: row.created_at.toISOString(),
  };
}

export function toDetail(
  row: AssetRow,
  bindings: AssetDetail['bindings'],
): AssetDetail {
  return {
    ...toSummary(row),
    payload: redactPayloadSecrets(row.payload) as AssetDetail['payload'],
    schema_version: row.schema_version,
    bindings,
  };
}

/**
 * 详情接口的兜底脱敏。
 *
 * 写入路径已经拒绝承载密钥的键与密钥形似值；这里再挡一层，
 * 保证即使有绕过写入路径的行，密钥也不会被原样读回。
 */
function redactPayloadSecrets(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  const record = payload as Record<string, unknown>;
  if (!('config' in record)) {
    return payload;
  }
  return { ...record, config: redactSecretValues(record.config) };
}
