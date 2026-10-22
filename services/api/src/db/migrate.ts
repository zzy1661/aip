import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const MIGRATION_LOCK_KEY = 8_675_309_001n;
const LEDGER_TABLE = 'aip_schema_migration';

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * 迁移目录解析：源码运行时与构建产物运行时的路径不同，两处都要覆盖。
 */
export function resolveMigrationsDir(): string {
  const override = process.env.AIP_MIGRATIONS_DIR;
  if (override) return resolve(override);

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'migrations'),
    resolve(here, '../../src/db/migrations'),
    resolve(here, '../../../src/db/migrations'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('unable to locate migrations directory');
}

export function listMigrationFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

function checksum(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export async function migrate(pool: Pool, dir = resolveMigrationsDir()): Promise<MigrationResult> {
  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY.toString()]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
        filename text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ filename: string; checksum: string }>(
      `SELECT filename, checksum FROM ${LEDGER_TABLE}`,
    );
    const ledger = new Map(rows.map((row) => [row.filename, row.checksum]));

    for (const filename of listMigrationFiles(dir)) {
      const sql = readFileSync(join(dir, filename), 'utf8');
      const digest = checksum(sql);
      const recorded = ledger.get(filename);
      if (recorded !== undefined) {
        if (recorded !== digest) {
          throw new Error(`migration checksum mismatch for ${filename}`);
        }
        skipped.push(filename);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO ${LEDGER_TABLE} (filename, checksum) VALUES ($1, $2)`,
          [filename, digest],
        );
        await client.query('COMMIT');
        applied.push(filename);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY.toString()]).catch(() => undefined);
    client.release();
  }

  return { applied, skipped };
}
