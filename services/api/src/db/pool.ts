import pg from 'pg';
import type { Pool, PoolClient } from 'pg';

const { Pool: PgPool } = pg;

export interface DbOptions {
  connectionString: string;
  max?: number;
}

export function createPool(options: DbOptions): Pool {
  return new PgPool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    // 应用账号不应持有 DDL 权限，这里也不隐式提升。
    statement_timeout: 30_000,
    idleTimeoutMillis: 10_000,
  });
}

/** 仓储层统一接受的查询句柄：连接池（只读）或事务客户端。 */
export type QueryClient = Pool | PoolClient;

export async function closePool(pool: Pool): Promise<void> {
  await pool.end();
}
