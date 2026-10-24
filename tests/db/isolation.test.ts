import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileStore } from '@aip/api';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { registerSkillRequest } from '../helpers/fixtures.js';
import { createReadyKnowledgeBase, uploadSampleDocument } from '../helpers/flow.js';
import {
  adminConfigured,
  createAdminPool,
  roleDatabaseUrl,
  verifyTestInstance,
  type TestInstanceIdentity,
} from '../helpers/test-instance.js';

/**
 * M02：项目隔离。
 *
 * 断言口径：不同项目用不同的库/账号/schema，同一 slug 互不冲突；
 * 跨项目的令牌、路径、资源 ID 一律被拒；账号之间连不上对方的库。
 *
 * 管理连接必须显式指定（AIP_TEST_ADMIN_DATABASE_URL），并在启动时校验实例身份：
 * 用例要在实例上建角色建库，绝不能落到共享实例或既有数据库上。
 * 未配置时整组用例标记为 NOT RUN，不静默改用别的实例。
 */
describe.skipIf(!adminConfigured())('M02 项目隔离', () => {
  let projectA: Harness;
  let projectB: Harness;
  let tokenA: string;
  let tokenB: string;
  let identity: TestInstanceIdentity;

  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  const roleA = `aip_iso_a_${suffix}`;
  const roleB = `aip_iso_b_${suffix}`;
  const dbA = `aip_iso_a_db_${suffix}`;
  const dbB = `aip_iso_b_db_${suffix}`;
  const password = 'aip-isolation-only';

  beforeAll(async () => {
    // 实例身份校验：主机回环 + 专用管理库名 + 落库一致。
    identity = await verifyTestInstance();

    const admin = createAdminPool();
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

    // 两个项目各自用自己的应用角色连自己的库：API 真的以这两个角色运行。
    projectA = await createHarness({
      label: 'm02a',
      projectId: 'project-a',
      databaseUrl: roleDatabaseUrl(identity, roleA, dbA, password),
    });
    projectB = await createHarness({
      label: 'm02b',
      projectId: 'project-b',
      databaseUrl: roleDatabaseUrl(identity, roleB, dbB, password),
    });
    tokenA = await projectA.token({ permissions: ALL_PERMISSIONS });
    tokenB = await projectB.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    // 先关掉两个 API 的连接池，再回收角色与库：
    // 否则 terminate_backend 会打断仍在使用的连接。
    await projectA?.close();
    await projectB?.close();
    const admin = createAdminPool();
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
    const urlB = roleDatabaseUrl(identity, roleA, dbB, password);
    const pool = createAdminPool(urlB);
    try {
      await expect(pool.query('SELECT 1')).rejects.toThrow(/permission denied/i);
    } finally {
      await pool.end().catch(() => undefined);
    }
  });

  it('各自的账号能连自己的库', async () => {
    const urlA = roleDatabaseUrl(identity, roleA, dbA, password);
    const pool = createAdminPool(urlA);
    try {
      const result = await pool.query('SELECT current_database() AS name');
      expect(result.rows[0].name).toBe(dbA);
    } finally {
      await pool.end();
    }
  });

  it('两个项目的 API 确实各自跑在自己的应用角色与库上', async () => {
    const [a, b] = await Promise.all([
      projectA.pool.query<{ role: string; database: string }>(
        'SELECT current_user AS role, current_database() AS database',
      ),
      projectB.pool.query<{ role: string; database: string }>(
        'SELECT current_user AS role, current_database() AS database',
      ),
    ]);
    expect(a.rows[0]!.role).toBe(roleA);
    expect(a.rows[0]!.database).toBe(dbA);
    expect(b.rows[0]!.role).toBe(roleB);
    expect(b.rows[0]!.database).toBe(dbB);
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
