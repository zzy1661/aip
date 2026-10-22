import { pino } from 'pino';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createPool, closePool } from './db/pool.js';
import { Validator } from './http/validate.js';
import { createTokenVerifier } from './auth/verify.js';
import { createOntoConceptValidator } from './ontology/client.js';
import { createRagFlowHttpClient } from './ragflow/client.js';
import { createRagFlowAdapter } from './ragflow/adapter.js';
import { FileStore } from './files/store.js';
import { createOperationsService } from './operations/service.js';
import { createRegistryService } from './registry/service.js';
import { createKnowledgeService } from './knowledge/service.js';
import { isDenied } from './knowledge/authorization.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool({ connectionString: config.databaseUrl });
  const validator = new Validator();
  const verifier = createTokenVerifier(config);
  const concepts = createOntoConceptValidator({
    baseUrl: config.onto.baseUrl,
    audience: config.onto.audience,
  });

  const ragflowHttp = createRagFlowHttpClient({
    baseUrl: config.ragflow.baseUrl,
    apiKey: config.ragflow.apiKey,
    connectTimeoutMs: config.ragflow.connectTimeoutMs,
    readTimeoutMs: config.ragflow.readTimeoutMs,
    uploadTimeoutMs: config.ragflow.uploadTimeoutMs,
    readBudgetMs: config.ragflow.readBudgetMs,
    maxReadAttempts: config.ragflow.maxReadAttempts,
  });
  const ragflow = createRagFlowAdapter({
    http: ragflowHttp,
    embeddingModel: config.ragflow.embeddingModel,
    parserConfig: config.ragflow.parserConfig,
    chunkMethod: config.ragflow.chunkMethod,
    similarityThreshold: config.retrieval.similarityThreshold,
    vectorSimilarityWeight: config.retrieval.vectorSimilarityWeight,
    topK: config.retrieval.topK,
  });

  const files = new FileStore(config.fileStoreRoot);
  const operations = createOperationsService({
    pool,
    ragflow,
    files,
    parseDeadlineMs: config.limits.parseDeadlineMs,
    parserHash: config.ragflow.sourceSha ?? 'unpinned',
    embeddingRevision: config.ragflow.embeddingRevision || 'unversioned',
  });

  const registry = createRegistryService({ pool, validator, concepts });
  const knowledge = createKnowledgeService({
    pool,
    validator,
    ragflow,
    operations,
    files,
    limits: config.limits,
    parserHash: config.ragflow.sourceSha ?? 'unpinned',
    embeddingRevision: config.ragflow.embeddingRevision || 'unversioned',
  });

  const app = createApp({
    projectId: config.projectId,
    verifier,
    isDenied: async (scope, subject) => isDenied(pool, scope, subject),
    registry,
    knowledge,
  });

  const port = Number.parseInt(process.env.PORT ?? '8080', 10);
  const server = app.listen(port, () => {
    logger.info({ port, project: config.projectId }, 'aip api listening');
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    server.close();
    await closePool(pool);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    logger.error({ message: error.message }, 'invalid configuration');
  } else {
    logger.error({ err: error }, 'failed to start');
  }
  process.exit(1);
});
