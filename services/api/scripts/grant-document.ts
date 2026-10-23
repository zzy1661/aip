import { createPool, closePool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/uow.js';
import { grantDocument, revokeDocument } from '../src/knowledge/authorization.js';

/**
 * 运维命令：为某个主体授予或撤销某个知识版本的文档级读取/下载授权。
 * 只读取环境变量，不接受命令行传入的凭据。
 */

interface Args {
  scope: string;
  knowledgeId: string;
  version: string;
  subject: string;
  revoke: boolean;
  canDownload: boolean;
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  let revoke = false;
  let canDownload = true;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--revoke') {
      revoke = true;
      continue;
    }
    if (token === '--no-download') {
      canDownload = false;
      continue;
    }
    const key = token.replace(/^--/, '');
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for ${token}`);
    }
    values.set(key, value);
    index += 1;
  }
  const required = ['scope', 'knowledge-id', 'version', 'subject'] as const;
  for (const key of required) {
    if (!values.has(key)) {
      throw new Error(`missing required argument --${key}`);
    }
  }
  return {
    scope: values.get('scope')!,
    knowledgeId: values.get('knowledge-id')!,
    version: values.get('version')!,
    subject: values.get('subject')!,
    revoke,
    canDownload,
  };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  const args = parseArgs(process.argv.slice(2));
  const pool = createPool({ connectionString: databaseUrl, max: 2 });
  try {
    const revision = await withTransaction(pool, (client) =>
      args.revoke
        ? revokeDocument(client, {
            scopeId: args.scope,
            knowledgeId: args.knowledgeId,
            knowledgeVersion: args.version,
            subject: args.subject,
          })
        : grantDocument(client, {
            scopeId: args.scope,
            knowledgeId: args.knowledgeId,
            knowledgeVersion: args.version,
            subject: args.subject,
            canRead: true,
            canDownload: args.canDownload,
          }),
    );
    process.stdout.write(
      `${JSON.stringify({ action: args.revoke ? 'revoked' : 'granted', authz_revision: revision })}\n`,
    );
  } finally {
    await closePool(pool);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
