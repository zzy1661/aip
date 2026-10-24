import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveMigrationsDir, runMigrations } from '@aip/api';
import { createEmptyDatabase, type TestDatabase } from '../helpers/db.js';

/**
 * 迁移 010 的升级路径。
 *
 * 010 给已撤回的知识版本加了终态触发器，并放宽了 operation 的状态约束。
 * 升级路径必须证明：既有数据不丢、撤回确实变成终态、非撤回版本不受影响。
 */
describe('迁移 010 升级路径', () => {
  const opened: TestDatabase[] = [];
  const temporaries: string[] = [];

  afterEach(async () => {
    while (opened.length > 0) {
      await opened.pop()!.close();
    }
    while (temporaries.length > 0) {
      await rm(temporaries.pop()!, { recursive: true, force: true });
    }
  });

  /** 未迁移的 schema：升级路径必须从一个干净的库开始。 */
  async function openEmpty(label: string): Promise<TestDatabase> {
    const db = await createEmptyDatabase(label);
    opened.push(db);
    return db;
  }

  /** 把迁移目录复制一份，并只保留前 N 个文件。 */
  async function migrationsUpTo(count: number): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'aip-migrate-prefix-'));
    temporaries.push(dir);
    const source = resolveMigrationsDir();
    const files = (await readdir(source!)).filter((name) => name.endsWith('.sql')).sort();
    for (const name of files.slice(0, count)) {
      await copyFile(join(source!, name), join(dir, name));
    }
    return dir;
  }

  it('从 009 升到 010：既有数据保留，撤回变成终态', async () => {
    const db = await openEmpty('migrate010');
    const prefix = await migrationsUpTo(9);
    const before = await runMigrations(db.pool, prefix);
    expect(before.applied).toHaveLength(9);
    expect(
      before.applied.some((name) => name.startsWith('010_')),
      '009 这一批不应包含 010',
    ).toBe(false);

    // 既有数据：一条已撤回、一条未撤回。
    await db.pool.query(
      `INSERT INTO knowledge_base (scope_id, id, name, status)
       VALUES ('m010', gen_random_uuid(), '升级前知识库', 'ready')`,
    );
    const { rows: [kb] } = await db.pool.query<{ id: string }>(
      `SELECT id FROM knowledge_base WHERE scope_id = 'm010'`,
    );
    await db.pool.query(
      `INSERT INTO source_file_revision
         (scope_id, id, version, name, mime, size, sha256, storage_key, created_by)
       VALUES ('m010', gen_random_uuid(), '1.0.0', 'a.md', 'text/markdown', 1, 'sha', 'key', 'owner')`,
    );
    const { rows: [source] } = await db.pool.query<{ id: string }>(
      `SELECT id FROM source_file_revision WHERE scope_id = 'm010'`,
    );
    const withdrawnId = '11111111-1111-4111-8111-111111111111';
    const liveId = '22222222-2222-4222-8222-222222222222';
    await db.pool.query(
      `INSERT INTO knowledge_revision
         (scope_id, knowledge_id, version, kb_id, source_file_id, source_file_version,
          review_status, status, content_hash, created_by)
       VALUES
         ('m010', $1, '1.0.0', $2, $3, '1.0.0', 'approved', 'withdrawn', 'hash-1', 'owner'),
         ('m010', $4, '1.0.0', $2, $3, '1.0.0', 'approved', 'ready', 'hash-2', 'owner')`,
      [withdrawnId, kb!.id, source!.id, liveId],
    );

    // 升级：补齐 010。
    const after = await runMigrations(db.pool);
    expect(after.applied.map((name) => name.startsWith('010_'))).toEqual([true]);
    expect(after.skipped).toHaveLength(9);

    // 既有数据不丢。
    const { rows: revisions } = await db.pool.query<{ knowledge_id: string; status: string }>(
      `SELECT knowledge_id::text AS knowledge_id, status FROM knowledge_revision
        WHERE scope_id = 'm010' ORDER BY knowledge_id`,
    );
    expect(revisions).toHaveLength(2);
    expect(revisions.map((row) => row.status).sort()).toEqual(['ready', 'withdrawn']);

    // 撤回是终态：数据库层拒写。
    await expect(
      db.pool.query(
        `UPDATE knowledge_revision SET status = 'ready'
          WHERE scope_id = 'm010' AND knowledge_id = $1`,
        [withdrawnId],
      ),
    ).rejects.toThrow(/withdrawn is a terminal state/i);

    // 未撤回的版本不受影响。
    await expect(
      db.pool.query(
        `UPDATE knowledge_revision SET status = 'failed'
          WHERE scope_id = 'm010' AND knowledge_id = $1`,
        [liveId],
      ),
    ).resolves.toBeDefined();

    // operation 的状态约束放宽到 cancelled。
    await expect(
      db.pool.query(
        `INSERT INTO operation
           (scope_id, id, subject, kind, idempotency_key, request_hash, state)
         VALUES ('m010', gen_random_uuid(), 'owner', 'document.upload', 'k-010', 'h', 'cancelled')`,
      ),
    ).resolves.toBeDefined();
  });

  it('010 的台账 checksum 与文件内容一致', async () => {
    const db = await openEmpty('migrate010b');
    await runMigrations(db.pool);
    const dir = resolveMigrationsDir();
    const name = '010_withdrawn_terminal.sql';
    const content = await readFile(join(dir!, name), 'utf8');
    const { rows } = await db.pool.query<{ checksum: string }>(
      'SELECT checksum FROM aip_schema_migration WHERE filename = $1',
      [name],
    );
    expect(rows).toHaveLength(1);
    const { createHash } = await import('node:crypto');
    expect(rows[0]!.checksum).toBe(createHash('sha256').update(content, 'utf8').digest('hex'));
  });
});
