import pg from 'pg';
import type { Pool } from 'pg';

const { Pool: PgPool } = pg;

/**
 * 显式的测试实例配置。
 *
 * 项目隔离这类用例需要「管理连接」：它要在实例上建角色、建库。
 * 这类操作绝不能落到别的实例上，因此这里没有默认地址：
 * 必须用 AIP_TEST_ADMIN_DATABASE_URL 显式指定一个专用的测试实例，
 * 并在连接后校验实例身份（回环地址 + 专用管理库名）。
 *
 * 身份校验不通过就直接失败，而不是「换个库继续」——
 * 校验的 purpose 就是阻止用例误伤既有数据库。
 */

export const ADMIN_DATABASE_URL = process.env.AIP_TEST_ADMIN_DATABASE_URL ?? '';

/** 专用管理库名：与共享的应用测试库区分开，避免在共享实例上建角色建库。 */
const ADMIN_DATABASE_PATTERN = /^aip_test_(admin|isolation)$/;

export interface TestInstanceIdentity {
  database: string;
  host: string;
  port: string;
  serverAddress: string;
  version: string;
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

export function adminConfigured(): boolean {
  return ADMIN_DATABASE_URL.length > 0;
}

/**
 * 校验管理连接指向的是本任务的专用测试实例。
 *
 * 判据：
 * - 主机是回环地址：绝不连远端实例；
 * - 目标库名匹配专用管理库名：不复用共享的应用测试库；
 * - 连接后 current_database() 与 URL 里的库名一致；
 * - 实例里不存在共享的应用测试库：共享实例上建角色建库会伤到别的任务。
 */
export async function verifyTestInstance(
  adminUrl: string = ADMIN_DATABASE_URL,
): Promise<TestInstanceIdentity> {
  const url = new URL(adminUrl);
  if (!isLoopback(url.hostname)) {
    throw new Error(
      `the test instance must be on the loopback interface, got host=${url.hostname}`,
    );
  }
  const expectedDatabase = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!ADMIN_DATABASE_PATTERN.test(expectedDatabase)) {
    throw new Error(
      `the admin database must be a dedicated test database (${ADMIN_DATABASE_PATTERN.source}), got ${expectedDatabase}`,
    );
  }

  const pool: Pool = new PgPool({ connectionString: adminUrl, max: 1 });
  try {
    const { rows } = await pool.query<{
      database: string;
      server_address: string | null;
      version: string;
    }>(
      `SELECT current_database() AS database,
              inet_server_addr()::text AS server_address,
              current_setting('server_version') AS version`,
    );
    const row = rows[0]!;
    if (row.database !== expectedDatabase) {
      throw new Error(
        `the admin connection landed on database ${row.database}, expected ${expectedDatabase}`,
      );
    }
    const { rows: databases } = await pool.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datistemplate = false`,
    );
    const shared = databases.map((entry) => entry.datname).filter((name) => name === 'aip_test');
    if (shared.length > 0) {
      throw new Error(
        'this instance still hosts the shared application test database; use a dedicated instance',
      );
    }
    return {
      database: row.database,
      host: url.hostname,
      port: url.port || '5432',
      serverAddress: row.server_address ?? '127.0.0.1',
      version: row.version,
    };
  } finally {
    await pool.end();
  }
}

/** 由管理连接派生某个角色的连接串：同实例、同主机端口，只是换角色与库。 */
export function roleDatabaseUrl(
  identity: TestInstanceIdentity,
  role: string,
  database: string,
  password: string,
): string {
  return `postgres://${role}:${encodeURIComponent(password)}@${identity.host}:${identity.port}/${database}`;
}

/** 管理员连接池：只在用例内部创建角色与库。 */
export function createAdminPool(adminUrl: string = ADMIN_DATABASE_URL): Pool {
  return new PgPool({ connectionString: adminUrl, max: 2 });
}

/** 把管理连接指向同一实例上的另一个库：授权必须发生在目标库里。 */
export function adminDatabaseUrl(
  identity: TestInstanceIdentity,
  database: string,
): string {
  const url = new URL(ADMIN_DATABASE_URL);
  url.pathname = `/${database}`;
  if (identity.port) url.port = identity.port;
  return url.toString();
}
