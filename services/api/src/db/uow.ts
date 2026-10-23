import type { Pool, PoolClient } from 'pg';
import type { QueryClient } from './pool.js';

/**
 * 事务边界：所有涉及多表写入的仓储调用都必须显式传入事务客户端，
 * 避免在连接池模式下产生非原子写入。
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** 要求显式事务客户端，避免误用连接池直接写入。 */
export function assertTransactional(client: QueryClient): void {
  if (!('release' in client)) {
    throw new Error('this repository call requires an explicit transaction client');
  }
}
