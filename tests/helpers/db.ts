import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Pool } from 'pg';
import { runMigrations } from '@aip/api';

const { Pool: PgPool } = pg;

/**
 * 隔离测试库连接串。
 *
 * 默认指向本机一次性测试容器（aip-test-postgres，127.0.0.1:55433），
 * 该容器只服务本仓库测试，与 onto / Multica 的库完全无关。
 * 需要换实例时用 AIP_TEST_DATABASE_URL 覆盖。
 */
export const TEST_DATABASE_URL =
  process.env.AIP_TEST_DATABASE_URL ??
  'postgres://aip_test:aip_test_pw@127.0.0.1:55433/aip_test';

export interface TestDatabase {
  pool: Pool;
  schema: string;
  close(): Promise<void>;
}

async function createSchema(
  label: string,
  databaseUrl: string = TEST_DATABASE_URL,
): Promise<{ pool: Pool; schema: string }> {
  const safeLabel = label.replace(/[^a-z0-9_]/gi, '').slice(0, 16).toLowerCase();
  const schema = `aip_t_${safeLabel}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  const admin = new PgPool({ connectionString: databaseUrl, max: 2 });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    await admin.end();
  }

  const pool = new PgPool({
    connectionString: databaseUrl,
    application_name: schema,
    max: 6,
    options: `-c search_path=${schema}`,
  });

  return { pool, schema };
}

async function dropSchema(schema: string, databaseUrl: string = TEST_DATABASE_URL): Promise<void> {
  const cleanup = new PgPool({ connectionString: databaseUrl, max: 2 });
  try {
    await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await cleanup.end();
  }
}

/** 建一个未迁移的隔离 schema，用于验证迁移本身的行为。 */
export async function createEmptyDatabase(
  label = 'empty',
  databaseUrl: string = TEST_DATABASE_URL,
): Promise<TestDatabase> {
  const { pool, schema } = await createSchema(label, databaseUrl);
  return {
    pool,
    schema,
    async close(): Promise<void> {
      await pool.end();
      await dropSchema(schema, databaseUrl);
    },
  };
}

/**
 * 每个测试用例建独立 schema，迁移在 schema 内执行。
 * 用例之间不共享任何表，清理只删除自己创建的 schema。
 */
export async function createTestDatabase(
  label = 'case',
  databaseUrl: string = TEST_DATABASE_URL,
): Promise<TestDatabase> {
  const { pool, schema } = await createSchema(label, databaseUrl);
  await runMigrations(pool);
  return {
    pool,
    schema,
    async close(): Promise<void> {
      await pool.end();
      await dropSchema(schema, databaseUrl);
    },
  };
}
