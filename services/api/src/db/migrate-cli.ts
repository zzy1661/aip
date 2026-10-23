import { loadConfig } from '../config.js';
import { migrate } from './migrate.js';
import { closePool, createPool } from './pool.js';

async function main(): Promise<void> {
  const config = loadConfig();
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
