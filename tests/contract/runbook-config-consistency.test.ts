import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * DOC-01：运行手册与配置项一致性。
 *
 * 判据（双向、集合相等）：
 *   代码侧实际读取的环境变量集合  ==  文档侧环境变量集合
 * 文档侧 = `docs/runbook.md` 的「环境变量」小节里那张表的变量名
 *          ∪ 根 `.env.example` 里的 `KEY=` 行
 * 任一侧多一个或少一个都判失败（差集必须同时为空）。
 *
 * 代码侧的取法（静态扫描，不执行服务）：
 * - `services/api/src/config.ts` 里 requireEnv / optionalEnv / intEnv / floatEnv
 *   的**字面量变量名**（注意形状是 `requireEnv(env, 'AIP_PROJECT_ID')`，变量名是第二个参数）；
 * - `config.ts` 里直接以 `env.X` 形式读取的变量名（NODE_ENV / AUTH_MODE / RUN_REAL_RAGFLOW）；
 * - `services/api/src`、`services/api/scripts`、`services/worker/src` 下所有 `.ts`
 *   里直接读的 `process.env.X`（含 `services/api/src/db/migrate.ts` 的 `AIP_MIGRATIONS_DIR`）。
 *
 * 归一化：大小写归一、`__` 与 `_` 的写法差异归一（避免假阳性）；
 * 但 `AIP_X` 与 `AIP_X_Y` 是两个不同的变量名，不会互相吞掉。
 *
 * compose 专用变量（POSTGRES_* 与镜像名）不由产品代码读取，不参与上面的相等比较；
 * 它们单独放在 `deploy/.env.example`，本文件另外断言它们的归属没有丢失。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const RUNBOOK_PATH = 'docs/runbook.md';
const ENV_EXAMPLE_PATH = '.env.example';
const DEPLOY_ENV_EXAMPLE_PATH = 'deploy/.env.example';
const COMPOSE_PATH = 'deploy/compose.example.yaml';

const PRODUCT_CODE_ROOTS = ['services/api/src', 'services/api/scripts', 'services/worker/src'];

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

/** 变量名归一化：大小写归一 + 连续下划线折叠为一个。 */
function normalize(name: string): string {
  return name.trim().toUpperCase().replace(/_+/g, '_');
}

function collectMatches(source: string, pattern: RegExp): Set<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(pattern)) {
    const raw = match[1];
    if (raw) found.add(normalize(raw));
  }
  return found;
}

function listTypeScriptFiles(rootRelativePath: string): string[] {
  const files: string[] = [];
  const walk = (absoluteDir: string): void => {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const absolute = join(absoluteDir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name.endsWith('.ts')) files.push(absolute);
    }
  };
  walk(resolve(repoRoot, rootRelativePath));
  return files;
}

/** 代码侧：服务进程实际读取的环境变量集合。 */
function collectCodeEnvVars(): Set<string> {
  const names = new Set<string>();

  // config.ts 里的读取助手：requireEnv(env, 'X') / optionalEnv(env, 'X')
  // / intEnv(env, 'X', fallback) / floatEnv(env, 'X', fallback)。
  const configSource = readRepoFile('services/api/src/config.ts');
  collectMatches(
    configSource,
    /\b(?:requireEnv|optionalEnv|intEnv|floatEnv)\s*\(\s*[^,()]+,\s*'([^']+)'/g,
  ).forEach((name) => names.add(name));

  // config.ts 里直接读 env.X 的三处（NODE_ENV / AUTH_MODE / RUN_REAL_RAGFLOW）。
  collectMatches(configSource, /(?<!process\.)\benv\.([A-Z][A-Z0-9_]*)/g).forEach((name) =>
    names.add(name),
  );

  // 所有产品代码里直接读的 process.env.X。
  const directRead = /\bprocess\.env\.([A-Z][A-Z0-9_]*)/g;
  for (const root of PRODUCT_CODE_ROOTS) {
    for (const file of listTypeScriptFiles(root)) {
      collectMatches(readFileSync(file, 'utf8'), directRead).forEach((name) => names.add(name));
    }
  }

  return names;
}

/** 文档侧之一：运行手册「环境变量」小节里的变量名（表格第一列的反引号标识符）。 */
function collectRunbookEnvVars(): Set<string> {
  const markdown = readRepoFile(RUNBOOK_PATH);
  const section = /^##\s+2\.\s*环境变量[^\n]*\n([\s\S]*?)(?=^##\s)/m.exec(markdown);
  expect(section, `docs/runbook.md 里找不到「## 2. 环境变量」小节，无法读取变量表`).not.toBeNull();
  const body = section?.[1] ?? '';
  return collectMatches(body, /^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/gm);
}

/** 文档侧之二：根 .env.example 里的 KEY= 行。 */
function collectEnvExampleVars(): Set<string> {
  return collectMatches(readRepoFile(ENV_EXAMPLE_PATH), /^\s*([A-Z][A-Z0-9_]*)=/gm);
}

function difference(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((name) => !right.has(name)).sort();
}

describe('DOC-01 运行手册与配置项一致性', () => {
  it('扫描器本身有效：两侧都读到了非空的环境变量集合', () => {
    const code = collectCodeEnvVars();
    const runbook = collectRunbookEnvVars();
    const envExample = collectEnvExampleVars();

    expect(code.size).toBeGreaterThan(30);
    expect(runbook.size).toBeGreaterThan(30);
    expect(envExample.size).toBeGreaterThan(30);

    // 抽查若干已知读取点：助手函数、config.ts 的直接读取、两个 main.ts、迁移入口。
    for (const name of [
      'AIP_PROJECT_ID',
      'DATABASE_URL',
      'RAGFLOW_API_VERSION',
      'NODE_ENV',
      'AUTH_MODE',
      'RUN_REAL_RAGFLOW',
      'LOG_LEVEL',
      'PORT',
      'WORKER_POLL_INTERVAL_MS',
      'WORKER_BATCH_SIZE',
      'AIP_MIGRATIONS_DIR',
    ]) {
      expect(code.has(name), `代码侧扫描漏掉了 ${name}`).toBe(true);
    }
  });

  it('代码读取的环境变量与 .env.example 完全一致', () => {
    const code = collectCodeEnvVars();
    const envExample = collectEnvExampleVars();

    expect({
      missingFromEnvExample: difference(code, envExample),
      extraInEnvExample: difference(envExample, code),
    }).toEqual({
      missingFromEnvExample: [],
      extraInEnvExample: [],
    });
  });

  it('代码读取的环境变量与 docs/runbook.md 的变量表完全一致', () => {
    const code = collectCodeEnvVars();
    const runbook = collectRunbookEnvVars();

    expect({
      missingFromRunbook: difference(code, runbook),
      extraInRunbook: difference(runbook, code),
    }).toEqual({
      missingFromRunbook: [],
      extraInRunbook: [],
    });
  });

  it('文档侧（运行手册变量表 ∪ .env.example）与代码侧双向差集为空', () => {
    const code = collectCodeEnvVars();
    const runbook = collectRunbookEnvVars();
    const envExample = collectEnvExampleVars();

    const docs = new Set<string>([...runbook, ...envExample]);
    const missingFromDocs = difference(code, docs);
    const extraInDocs = difference(docs, code);

    console.log(
      `[DOC-01] 代码侧 ${code.size} 个：${[...code].sort().join(', ')}\n` +
        `[DOC-01] 文档侧 ${docs.size} 个：${[...docs].sort().join(', ')}\n` +
        `[DOC-01] 差集：代码有文档无 = [${missingFromDocs.join(', ')}]；` +
        `文档有代码无 = [${extraInDocs.join(', ')}]`,
    );

    expect({ missingFromDocs, extraInDocs }).toEqual({
      missingFromDocs: [],
      extraInDocs: [],
    });
  });

  it('compose 专用变量留在 deploy/.env.example，且仍被 compose 示例引用', () => {
    const rootKeys = collectEnvExampleVars();
    const deployKeys = collectMatches(
      readRepoFile(DEPLOY_ENV_EXAMPLE_PATH),
      /^\s*([A-Z][A-Z0-9_]*)=/gm,
    );
    const composeSource = readRepoFile(COMPOSE_PATH);
    const composeRefs = collectMatches(composeSource, /\$\{([A-Z][A-Z0-9_]*)/g);

    // 根 .env.example 只放产品代码会读的变量：与 compose 专用变量不重叠。
    const overlap = [...rootKeys].filter((name) => deployKeys.has(name));
    expect(overlap).toEqual([]);

    // compose 专用变量一个都不能丢。
    expect(deployKeys.size).toBeGreaterThan(0);
    for (const name of deployKeys) {
      expect(composeRefs.has(name), `deploy/.env.example 里的 ${name} 没有被 compose 示例引用`).toBe(
        true,
      );
    }
  });
});
