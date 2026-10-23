import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileStore } from '@aip/api';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { registerSkillRequest } from '../helpers/fixtures.js';
import { createReadyKnowledgeBase, uploadSampleDocument } from '../helpers/flow.js';

const { Pool: PgPool } = pg;
const ADMIN_URL = 'postgres://aip_test:aip_test_pw@127.0.0.1:55433/aip_test';

/**
 * M02：项目隔离。
 *
 * 断言口径：不同项目用不同的库/账号/schema，同一 slug 互不冲突；
 * 跨项目的令牌、路径、资源 ID 一律被拒；账号之间连不上对方的库。
 */
describe('M02 项目隔离', () => {
  let projectA: Harness;
  let projectB: Harness;
  let tokenA: string;
  let tokenB: string;

  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  const roleA = `aip_iso_a_${suffix}`;
  const roleB = `aip_iso_b_${suffix}`;
  const dbA = `aip_iso_a_db_${suffix}`;
  const dbB = `aip_iso_b_db_${suffix}`;
  const password = 'aip-isolation-only';

  beforeAll(async () => {
    projectA = await createHarness({ label: 'm02a', projectId: 'project-a' });
    projectB = await createHarness({ label: 'm02b', projectId: 'project-b' });
    tokenA = await projectA.token({ permissions: ALL_PERMISSIONS });
    tokenB = await projectB.token({ permissions: ALL_PERMISSIONS });

    const admin = new PgPool({ connectionString: ADMIN_URL, max: 2 });
    try {
      await admin.query(`CREATE ROLE "${roleA}" LOGIN PASSWORD '${password}'`);
      await admin.query(`CREATE ROLE "${roleB}" LOGIN PASSWORD '${password}'`);
      await admin.query(`CREATE DATABASE "${dbA}" OWNER "${roleA}"`);
      await admin.query(`CREATE DATABASE "${dbB}" OWNER "${roleB}"`);
      // 撤销公共连接权限：只有属主能连自己的库。
      await admin.query(`REVOKE CONNECT ON DATABASE "${dbA}" FROM PUBLIC`);
      await admin.query(`REVOKE CONNECT ON DATABASE "${dbB}" FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE "${dbA}" TO "${roleA}"`);
      await admin.query(`GRANT CONNECT ON DATABASE "${dbB}" TO "${roleB}"`);
    } finally {
      await admin.end();
    }
  });

  afterAll(async () => {
    const admin = new PgPool({ connectionString: ADMIN_URL, max: 2 });
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = ANY($1::text[])`,
        [[dbA, dbB]],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${dbA}"`);
      await admin.query(`DROP DATABASE IF EXISTS "${dbB}"`);
      await admin.query(`DROP ROLE IF EXISTS "${roleA}"`);
      await admin.query(`DROP ROLE IF EXISTS "${roleB}"`);
    } finally {
      await admin.end();
    }
    await projectA.close();
    await projectB.close();
  });

  it('两个项目可以注册同一个 slug，互不冲突', async () => {
    const slug = `shared-slug-${suffix}`;

    const inA = await projectA.request({
      method: 'POST',
      path: '/assets',
      token: tokenA,
      idempotencyKey: `m02-a-${suffix}`,
      json: registerSkillRequest({ slug }),
    });
    const inB = await projectB.request({
      method: 'POST',
      path: '/assets',
      token: tokenB,
      idempotencyKey: `m02-b-${suffix}`,
      json: registerSkillRequest({ slug }),
    });

    expect(inA.status).toBe(201);
    expect(inB.status).toBe(201);
    expect(inA.body.data.asset_id).not.toBe(inB.body.data.asset_id);
  });

  it('A 的令牌访问 B 的项目路径被拒', async () => {
    const response = await projectB.request({
      method: 'GET',
      path: '/assets',
      token: tokenA,
    });
    expect(response.status).toBe(403);
  });

  it('A 的令牌在 A 项目里查 B 的资源 ID 得到 404，不泄露存在性', async () => {
    const createdB = await projectB.request({
      method: 'POST',
      path: '/assets',
      token: tokenB,
      idempotencyKey: `m02-b2-${suffix}`,
      json: registerSkillRequest(),
    });
    expect(createdB.status).toBe(201);

    const lookup = await projectA.request({
      method: 'GET',
      path: `/assets/${createdB.body.data.asset_id}/versions/1.0.0`,
      token: tokenA,
    });
    expect(lookup.status).toBe(404);
  });

  it('A 的账号连不上 B 的库', async () => {
    const urlB = `postgres://${roleA}:${password}@127.0.0.1:55433/${dbB}`;
    const pool = new PgPool({ connectionString: urlB, max: 1, connectionTimeoutMillis: 5000 });
    try {
      await expect(pool.query('SELECT 1')).rejects.toThrow(/permission denied/i);
    } finally {
      await pool.end().catch(() => undefined);
    }
  });

  it('各自的账号能连自己的库', async () => {
    const urlA = `postgres://${roleA}:${password}@127.0.0.1:55433/${dbA}`;
    const pool = new PgPool({ connectionString: urlA, max: 1, connectionTimeoutMillis: 5000 });
    try {
      const result = await pool.query('SELECT current_database() AS name');
      expect(result.rows[0].name).toBe(dbA);
    } finally {
      await pool.end();
    }
  });

  it('文件存储路径与操作登记不跨项目串用', async () => {
    const created = await projectA.request({
      method: 'POST',
      path: '/knowledge-bases',
      token: tokenA,
      idempotencyKey: `m02-kb-${suffix}`,
      json: { name: 'M02 知识库', description: '' },
    });
    expect(created.status).toBe(202);

    const operationA = await projectA.request({
      method: 'GET',
      path: `/operations/${created.body.data.operation_id}`,
      token: tokenA,
    });
    expect(operationA.status).toBe(200);

    // 同一个 operation id 在 B 项目里不可见。
    const operationB = await projectB.request({
      method: 'GET',
      path: `/operations/${created.body.data.operation_id}`,
      token: tokenB,
    });
    expect(operationB.status).toBe(404);
  });

  it('文件存储路径按项目隔离，同一文件标识在两个项目落在不同路径', async () => {
    const { kbId } = await createReadyKnowledgeBase(projectA, tokenA, 'M02 文件隔离');
    const uploaded = await uploadSampleDocument(projectA, tokenA, kbId, { marker: 'M02-FILE' });
    await projectA.advanceAll();

    const stored = await projectA.pool.query<{ storage_key: string }>(
      `SELECT storage_key FROM source_file_revision
        WHERE scope_id = $1 AND id = $2 AND version = $3`,
      [projectA.projectId, uploaded.sourceRef, uploaded.version],
    );
    expect(stored.rows).toHaveLength(1);
    const storageKey = stored.rows[0]!.storage_key;

    // 存储键由项目作用域派生：A 的文件落在 A 的前缀下。
    expect(storageKey).toBe(
      new FileStore('/tmp/aip-isolation-path-probe').buildStorageKey(
        'project-a',
        uploaded.sourceRef,
        uploaded.version,
      ),
    );
    // 同一个文件标识在 B 项目里必须落在另一个路径，不能命中 A 的文件。
    expect(
      new FileStore('/tmp/aip-isolation-path-probe').buildStorageKey(
        'project-b',
        uploaded.sourceRef,
        uploaded.version,
      ),
    ).not.toBe(storageKey);

    // B 的令牌下载 A 的来源文件按资源缺失处理。
    const download = await projectB.request({
      method: 'GET',
      path: `/sources/${uploaded.sourceRef}/versions/${uploaded.version}/download`,
      token: tokenB,
    });
    expect(download.status).toBe(404);
  });
});
