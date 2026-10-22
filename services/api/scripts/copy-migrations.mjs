import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '../src/db/migrations');
const target = join(here, '../dist/src/db/migrations');

if (!existsSync(source)) {
  process.stderr.write(`migrations source not found: ${source}\n`);
  process.exit(1);
}

mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
