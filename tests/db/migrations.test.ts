import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveMigrationsDir, runMigrations } from '@aip/api';
import { createEmptyDatabase, createTestDatabase, type TestDatabase } from '../helpers/db.js';

/**
 * M01：迁移台账、失败回滚、约束与不可变载荷。
 */
describe('M01 迁移与约束', () => {
  const opened: TestDatabase[] = [];

  afterEach(async () => {
    while (opened.length > 0) {
      await opened.pop()!.close();
    }
  });

  async function openEmpty(label: string): Promise<TestDatabase> {
    const db = await createEmptyDatabase(label);
    opened.push(db);
    return db;
  }

  it('全部迁移成功写入台账，重跑只跳过且不重复', async () => {
    const db = await openEmpty('m01a');
    const first = await runMigrations(db.pool);
    expect(first.applied.length).toBeGreaterThan(0);
    expect(first.skipped).toHaveLength(0);

    const ledger = await db.pool.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM aip_schema_migration ORDER BY filename',
    );
    expect(ledger.rows).toHaveLength(first.applied.length);

    const second = await runMigrations(db.pool);
    expect(second.applied).toHaveLength(0);
    expect(second.skipped.length).toBe(first.applied.length);

    const after = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM aip_schema_migration',
    );
    expect(after.rows[0]!.count).toBe(String(first.applied.length));
  });

  it('台账 checksum 与文件内容一致，改动文件会被拒绝', async () => {
    const db = await openEmpty('m01b');
    await runMigrations(db.pool);

    const dir = await mkdtemp(join(tmpdir(), 'aip-migrations-'));
    const source = resolveMigrationsDir();
    expect(source).toBeTruthy();

    const files = (await readdir(source!)).filter((name) => name.endsWith('.sql')).sort();
    for (const name of files) {
      await copyFile(join(source!, name), join(dir, name));
    }
    const target = join(dir, files[0]!);
    const original = await readFile(target, 'utf8');
    await writeFile(target, `${original}\n-- tampered\n`, 'utf8');

    await expect(runMigrations(db.pool, dir)).rejects.toThrow(/checksum mismatch/);
  });

  it('第 3 个迁移失败时不留成功记录，修复后可重跑且不重复建表', async () => {
    const db = await openEmpty('m01c');
    const dir = await mkdtemp(join(tmpdir(), 'aip-migrations-'));
    const source = resolveMigrationsDir();
    const files = (await readdir(source!)).filter((name) => name.endsWith('.sql')).sort();
    for (const name of files) {
      await copyFile(join(source!, name), join(dir, name));
    }

    const broken = join(dir, files[2]!);
    await writeFile(broken, 'CREATE TABLE broken_migration (id int);\nSELECT 1/0;\n', 'utf8');

    await expect(runMigrations(db.pool, dir)).rejects.toThrow();

    const ledger = await db.pool.query<{ filename: string }>(
      'SELECT filename FROM aip_schema_migration ORDER BY filename',
    );
    expect(ledger.rows.map((row) => row.filename)).toEqual(files.slice(0, 2));

    // 失败文件里的表没有建出来：整个文件在一个事务里。
    const brokenTable = await db.pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'broken_migration'`,
    );
    expect(brokenTable.rowCount).toBe(0);

    // 修复后重跑：失败文件被补上，且不重复执行已成功的文件。
    await copyFile(join(source!, files[2]!), broken);
    const retry = await runMigrations(db.pool, dir);
    expect(retry.applied).toEqual(files.slice(2));
    expect(retry.skipped).toEqual(files.slice(0, 2));

    const finalLedger = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM aip_schema_migration',
    );
    expect(finalLedger.rows[0]!.count).toBe(String(files.length));
  });

  it('复合外键与唯一约束真实存在于 pg_constraint', async () => {
    const db = await createTestDatabase('m01d');
    opened.push(db);

    const composite = await db.pool.query<{ conname: string; contype: string }>(
      `SELECT conname, contype FROM pg_constraint
        WHERE conrelid = 'agent_skill_binding'::regclass`,
    );
    const foreignKeys = composite.rows.filter((row) => row.contype === 'f');
    expect(foreignKeys.length).toBeGreaterThanOrEqual(2);

    const unique = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_constraint
        WHERE conrelid = 'agent_skill_binding'::regclass AND contype = 'p'`,
    );
    expect(Number(unique.rows[0]!.count)).toBe(1);

    const assetUnique = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_constraint
        WHERE conrelid = 'asset'::regclass AND contype = 'u'`,
    );
    expect(Number(assetUnique.rows[0]!.count)).toBeGreaterThanOrEqual(1);
  });

  it('已写入的版本载荷与哈希不可被改写', async () => {
    const db = await createTestDatabase('m01e');
    opened.push(db);

    await db.pool.query(
      `INSERT INTO asset (scope_id, id, type, slug, owner)
       VALUES ('m01e', gen_random_uuid(), 'Skill', 'immutable-skill', 'owner')`,
    );
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO asset_revision
         (scope_id, asset_id, version, title, payload, content_hash, created_by)
       SELECT scope_id, id, '1.0.0', 't', '{"body":"v1"}'::jsonb, 'hash-1', 'owner'
         FROM asset WHERE scope_id = 'm01e'
       RETURNING asset_id::text AS id`,
    );
    const assetId = rows[0]!.id;

    await expect(
      db.pool.query(
        `UPDATE asset_revision SET payload = '{"body":"v2"}'::jsonb
          WHERE scope_id = 'm01e' AND asset_id = $1`,
        [assetId],
      ),
    ).rejects.toThrow(/immutable/);

    await expect(
      db.pool.query(
        `DELETE FROM asset_revision WHERE scope_id = 'm01e' AND asset_id = $1`,
        [assetId],
      ),
    ).rejects.toThrow(/immutable/);
  });

  it('台账 checksum 为文件内容的 sha256', async () => {
    const db = await openEmpty('m01f');
    await runMigrations(db.pool);
    const dir = resolveMigrationsDir();
    const rows = await db.pool.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM aip_schema_migration',
    );
    for (const row of rows.rows) {
      const content = await readFile(join(dir, row.filename), 'utf8');
      expect(row.checksum).toBe(createHash('sha256').update(content, 'utf8').digest('hex'));
    }
  });
});
