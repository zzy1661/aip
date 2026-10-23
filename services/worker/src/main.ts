import { pino } from 'pino';
import {
  closePool,
  createOperationsService,
  createPool,
  createRagFlowAdapter,
  createRagFlowHttpClient,
  FileStore,
  loadConfig,
  operationsRepository,
} from '@aip/api';
import { withTransaction } from '@aip/api';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const POLL_INTERVAL_MS = Number.parseInt(process.env.WORKER_POLL_INTERVAL_MS ?? '2000', 10);
const BATCH_SIZE = Number.parseInt(process.env.WORKER_BATCH_SIZE ?? '10', 10);

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool({ connectionString: config.databaseUrl, max: 5 });
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

  logger.info({ project: config.projectId }, 'aip worker started');

  let running = true;
  const stop = (): void => {
    running = false;
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  while (running) {
    try {
      const claimable = await withTransaction(pool, (client) =>
        operationsRepository.listClaimableOperations(
          client,
          config.projectId,
          BATCH_SIZE,
        ),
      );
      for (const operation of claimable) {
        if (!running) break;
        const result = await operations.advance(operation.id, config.projectId);
        logger.info(
          {
            operation_id: operation.id,
            kind: operation.kind,
            state: result.state,
            attempt: operation.attempt,
          },
          'operation advanced',
        );
      }
    } catch (error) {
      logger.error({ err: error }, 'worker iteration failed');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  await closePool(pool);
  logger.info('aip worker stopped');
}

main().catch((error: unknown) => {
  logger.error({ err: error }, 'worker failed to start');
  process.exit(1);
});
