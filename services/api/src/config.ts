import { UPLOAD_MAX_BYTES } from '@aip/contracts';

/**
 * 服务端配置只从环境变量读取，任何密钥都不会进入前端产物。
 * 缺失的必填项在启动时直接失败，不做静默降级。
 */

export const SUPPORTED_RAGFLOW_API_VERSION = 'v0.20.5';

export type AuthMode = 'jwks' | 'hs256';

export interface Config {
  nodeEnv: string;
  isProduction: boolean;
  projectId: string;
  databaseUrl: string;
  fileStoreRoot: string;
  auth: {
    mode: AuthMode;
    issuer: string;
    audience: string;
    jwksUri: string;
    hs256Secret: string | null;
  };
  ragflow: {
    baseUrl: string;
    apiKey: string;
    apiVersion: string;
    embeddingModel: string;
    embeddingRevision: string;
    parserConfig: Record<string, unknown>;
    connectTimeoutMs: number;
    readTimeoutMs: number;
    uploadTimeoutMs: number;
    /** 只读调用的总预算，含连接、单次超时、退避与 Retry-After。 */
    readBudgetMs: number;
    maxReadAttempts: number;
    chunkMethod: string;
    imageDigest: string | null;
    sourceSha: string | null;
  };
  retrieval: {
    similarityThreshold: number;
    vectorSimilarityWeight: number;
    topK: number;
  };
  limits: {
    uploadMaxBytes: number;
    parseDeadlineMs: number;
    retrievalMaxDocuments: number;
  };
  onto: {
    baseUrl: string | null;
    audience: string | null;
  };
  realRagflow: {
    enabled: boolean;
    testProjectId: string | null;
  };
  trustedProxy: string | null;
}

export class ConfigError extends Error {}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new ConfigError(`missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  return value === undefined || value === '' ? null : value;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`environment variable ${name} must be a positive integer`);
  }
  return parsed;
}

function floatEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) {
    throw new ConfigError(`environment variable ${name} must be a number`);
  }
  return parsed;
}

function stripApiSuffix(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';

  const authMode = (env.AUTH_MODE ?? 'jwks') as AuthMode;
  if (authMode !== 'jwks' && authMode !== 'hs256') {
    throw new ConfigError(`unsupported AUTH_MODE: ${authMode}`);
  }
  if (isProduction && authMode !== 'jwks') {
    throw new ConfigError('AUTH_MODE must be jwks in production');
  }

  const ragflowApiVersion = requireEnv(env, 'RAGFLOW_API_VERSION');
  if (ragflowApiVersion !== SUPPORTED_RAGFLOW_API_VERSION) {
    throw new ConfigError(
      `RAGFLOW_API_VERSION must be ${SUPPORTED_RAGFLOW_API_VERSION}; other targets require a dedicated adapter configuration`,
    );
  }

  let parserConfig: Record<string, unknown> = {};
  const rawParserConfig = optionalEnv(env, 'RAGFLOW_PARSER_CONFIG_JSON');
  if (rawParserConfig) {
    try {
      const parsed: unknown = JSON.parse(rawParserConfig);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      parserConfig = parsed as Record<string, unknown>;
    } catch {
      throw new ConfigError('RAGFLOW_PARSER_CONFIG_JSON must be a JSON object');
    }
  }

  return {
    nodeEnv,
    isProduction,
    projectId: requireEnv(env, 'AIP_PROJECT_ID'),
    databaseUrl: requireEnv(env, 'DATABASE_URL'),
    fileStoreRoot: requireEnv(env, 'AIP_FILE_STORE_ROOT'),
    auth: {
      mode: authMode,
      issuer: requireEnv(env, 'OIDC_ISSUER'),
      audience: requireEnv(env, 'OIDC_AUDIENCE'),
      jwksUri: optionalEnv(env, 'OIDC_JWKS_URI') ?? '',
      hs256Secret: optionalEnv(env, 'AUTH_HS256_SECRET'),
    },
    ragflow: {
      baseUrl: stripApiSuffix(requireEnv(env, 'RAGFLOW_BASE_URL')),
      apiKey: requireEnv(env, 'RAGFLOW_API_KEY'),
      apiVersion: ragflowApiVersion,
      embeddingModel: optionalEnv(env, 'RAGFLOW_EMBEDDING_MODEL') ?? '',
      embeddingRevision: optionalEnv(env, 'RAGFLOW_EMBEDDING_REVISION') ?? '',
      parserConfig,
      connectTimeoutMs: intEnv(env, 'RAGFLOW_CONNECT_TIMEOUT_MS', 3000),
      readTimeoutMs: intEnv(env, 'RAGFLOW_READ_TIMEOUT_MS', 10000),
      uploadTimeoutMs: intEnv(env, 'RAGFLOW_UPLOAD_TIMEOUT_MS', 60000),
      readBudgetMs: intEnv(env, 'RAGFLOW_READ_BUDGET_MS', 30000),
      maxReadAttempts: intEnv(env, 'RAGFLOW_READ_MAX_ATTEMPTS', 3),
      chunkMethod: optionalEnv(env, 'RAGFLOW_CHUNK_METHOD') ?? 'naive',
      imageDigest: optionalEnv(env, 'RAGFLOW_IMAGE_DIGEST'),
      sourceSha: optionalEnv(env, 'RAGFLOW_SOURCE_SHA'),
    },
    retrieval: {
      similarityThreshold: floatEnv(env, 'RAGFLOW_SIMILARITY_THRESHOLD', 0.2),
      vectorSimilarityWeight: floatEnv(env, 'RAGFLOW_VECTOR_SIMILARITY_WEIGHT', 0.3),
      topK: intEnv(env, 'RAGFLOW_TOP_K', 1024),
    },
    limits: {
      uploadMaxBytes: intEnv(env, 'AIP_UPLOAD_MAX_BYTES', UPLOAD_MAX_BYTES),
      parseDeadlineMs: intEnv(env, 'AIP_PARSE_DEADLINE_MS', 1200000),
      retrievalMaxDocuments: intEnv(env, 'AIP_RETRIEVAL_MAX_DOCUMENTS', 200),
    },
    onto: {
      baseUrl: optionalEnv(env, 'ONTO_BASE_URL'),
      audience: optionalEnv(env, 'ONTO_API_AUDIENCE'),
    },
    realRagflow: {
      enabled: env.RUN_REAL_RAGFLOW === '1',
      testProjectId: optionalEnv(env, 'RAGFLOW_TEST_PROJECT_ID'),
    },
    trustedProxy: optionalEnv(env, 'AIP_TRUSTED_PROXY'),
  };
}
