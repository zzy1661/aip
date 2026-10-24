import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '@aip/api';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { registerSkillRequest } from '../helpers/fixtures.js';
import {
  adminConfigured,
  adminDatabaseUrl,
  createAdminPool,
  roleDatabaseUrl,
  verifyTestInstance,
  type TestInstanceIdentity,
} from '../helpers/test-instance.js';

const { Pool: PgPool } = pg;

/**
 * M01：应用角色与迁移角色分离。
 *
 * 原设计要求：应用账号没有 DDL 权限，迁移由独立的迁移账号执行。
 * 「属主 / 超级用户跑完迁移」不等于「应用账号没有 DDL」，
 * 所以这里让 API 真的以一个无 DDL 的应用角色运行，并逐条断言它的权限边界。
 *
 * 与 M02 一样，管理连接必须显式指定（AIP_TEST_ADMIN_DATABASE_URL），
 * 未配置时整组用例标记为 NOT RUN。
 */
describe.skipIf(!adminConfigured())('M01 应用角色与迁移角色分离', () => {
  let identity: TestInstanceIdentity;
  let harness: Harness;
  let token: string;

  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  const migrationRole = `aip_m01_mig_${suffix}`;
  const appRole = `aip_m01_app_${suffix}`;
  const database = `aip_m01_db_${suffix}`;
  const schema = `aip_m01_schema_${suffix}`;
  const password = 'aip-role-separation-only';

  beforeAll(async () => {
    identity = await verifyTestInstance();

    const admin = createAdminPool();
    try {
      await admin.query(`CREATE ROLE "${migrationRole}" LOGIN PASSWORD '${password}'`);
      await admin.query(`CREATE ROLE "${appRole}" LOGIN PASSWORD '${password}'`);
      await admin.query(`CREATE DATABASE "${database}" OWNER "${migrationRole}"`);
      // 应用角色只给连接权限，库里没有任何属主级别的权限。
      await admin.query(`GRANT CONNECT ON DATABASE "${database}" TO "${appRole}"`);
    } finally {
      await admin.end();
    }

    // 迁移角色建 schema 并执行迁移。
    const migrationPool = new PgPool({
      connectionString: roleDatabaseUrl(identity, migrationRole, database, password),
      max: 2,
    });
    try {
      await migrationPool.query(`CREATE SCHEMA "${schema}"`);
      await migrationPool.end();
      const scoped = new PgPool({
        connectionString: roleDatabaseUrl(identity, migrationRole, database, password),
        max: 2,
        options: `-c search_path=${schema}`,
      });
      try {
        const result = await runMigrations(scoped);
        expect(result.applied.length).toBeGreaterThan(0);
      } finally {
        await scoped.end();
      }
    } catch (error) {
      await migrationPool.end().catch(() => undefined);
      throw error;
    }

    // 只给业务所需的 DML：应用角色拿不到任何 DDL 权限。
    // 授权必须在目标库里执行，不能落在管理库上。
    const grant = createAdminPool(adminDatabaseUrl(identity, database));
    try {
      await grant.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${appRole}"`);
      await grant.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${appRole}"`,
      );
    } finally {
      await grant.end();
    }

    harness = await createHarness({
      label: 'm01app',
      projectId: 'm01-app-role',
      databaseUrl: roleDatabaseUrl(identity, appRole, database, password),
      databaseSchema: schema,
    });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness?.close();
    const admin = createAdminPool();
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
        [database],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
      await admin.query(`DROP ROLE IF EXISTS "${migrationRole}"`);
      await admin.query(`DROP ROLE IF EXISTS "${appRole}"`);
    } finally {
      await admin.end();
    }
  });

  it('API 确实以应用角色连接', async () => {
    const { rows } = await harness.pool.query<{ role: string; database: string }>(
      'SELECT current_user AS role, current_database() AS database',
    );
    expect(rows[0]!.role).toBe(appRole);
    expect(rows[0]!.database).toBe(database);
  });

  it('应用角色可以读写业务表', async () => {
    const created = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: `m01-dml-${suffix}`,
      json: registerSkillRequest({ slug: `m01-dml-${suffix}` }),
    });
    expect(created.status).toBe(201);
    const { rows } = await harness.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM asset WHERE scope_id = $1`,
      [harness.projectId],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it('应用角色没有 DDL 权限：建表、改表、删表都被拒', async () => {
    await expect(
      harness.pool.query('CREATE TABLE app_role_ddl_probe (id int)'),
    ).rejects.toThrow(/permission denied|must be owner/i);
    await expect(
      harness.pool.query('ALTER TABLE asset ADD COLUMN app_role_ddl_probe int'),
    ).rejects.toThrow(/permission denied|must be owner/i);
    await expect(
      harness.pool.query('DROP TABLE asset'),
    ).rejects.toThrow(/permission denied|must be owner/i);
    await expect(
      harness.pool.query(`CREATE TRIGGER app_role_ddl_probe BEFORE UPDATE ON asset FOR EACH ROW EXECUTE FUNCTION aip_knowledge_revision_withdrawn_terminal()`),
    ).rejects.toThrow(/permission denied|must be owner/i);
  });

  it('应用角色不能建 schema，也不能跑迁移', async () => {
    await expect(
      harness.pool.query('CREATE SCHEMA app_role_schema_probe'),
    ).rejects.toThrow(/permission denied/i);
    // 迁移需要建表：应用角色连建表都不允许，迁移对它天然不可执行。
    await expect(
      harness.pool.query(
        `CREATE TABLE IF NOT EXISTS aip_schema_migration (
           filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
      ),
    ).rejects.toThrow(/permission denied|must be owner/i);
  });

  it('迁移角色仍然可以改结构：迁移与应用是两个账号', async () => {
    const migrationPool = new PgPool({
      connectionString: roleDatabaseUrl(identity, migrationRole, database, password),
      max: 1,
      options: `-c search_path=${schema}`,
    });
    try {
      await migrationPool.query('CREATE TABLE migration_role_probe (id int)');
      const { rows } = await migrationPool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM information_schema.tables
          WHERE table_schema = $1 AND table_name = 'migration_role_probe'`,
        [schema],
      );
      expect(rows[0]!.count).toBe('1');
    } finally {
      await migrationPool.end();
    }
  });
});
