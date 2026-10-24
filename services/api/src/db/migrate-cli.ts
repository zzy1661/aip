import { loadMigrateConfig } from '../config.js';
import { migrate } from './migrate.js';
import { closePool, createPool } from './pool.js';

async function main(): Promise<void> {
  // 迁移只需要数据库连接：应用角色没有 DDL，迁移必须用迁移角色单独执行。
  const config = loadMigrateConfig();
  const pool = createPool({ connectionString: config.databaseUrl });
  try {
    const result = await migrate(pool);
    process.stdout.write(
      `migrations applied: ${result.applied.length}, already present: ${result.skipped.length}\n`,
    );
  } finally {
    await closePool(pool);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`migration failed: ${String(error)}\n`);
  process.exitCode = 1;
});
