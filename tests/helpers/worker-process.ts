import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * 真实 worker 进程的操作器。
 *
 * 这里启动的是仓库里的真实入口 services/worker/src/main.ts：
 * loadConfig -> createPool -> createRagFlowAdapter -> FileStore -> createOperationsService，
 * 然后循环 listClaimableOperations + advance。用例要断言的是
 * 「进程真的被 kill 掉之后，租约与栅栏如何工作」，
 * 进程内替身模拟不出这件事。
 *
 * 跑的是源码而不是构建产物：tsx 的 ESM loader 认 tsconfig 的 paths，
 * 因此 worker-tsconfig.json 把 @aip/api / @aip/contracts 指回源码。
 */

const helperDir = dirname(fileURLToPath(import.meta.url));

/** 仓库根目录：测试进程与 worker 进程必须共用同一份源码。 */
export const REPO_ROOT = resolve(helperDir, '../..');

const WORKER_MAIN = join(REPO_ROOT, 'services/worker/src/main.ts');

/** 让 tsx 把 @aip/api / @aip/contracts 解析到源码的 tsconfig。 */
const WORKER_TSCONFIG = join(helperDir, 'worker-tsconfig.json');

/** tsx 的 ESM loader：单进程启动，spawn 出来的 pid 就是 worker 本体。 */
function resolveTsxLoader(): string {
  const require = createRequire(join(REPO_ROOT, 'services/worker/package.json'));
  return pathToFileURL(require.resolve('tsx')).href;
}

export interface WorkerProcessOptions {
  /** 项目 scope：worker 只处理这个 scope 的操作。 */
  projectId: string;
  /** 数据库连接串；需要带上 search_path 才能命中测试 schema。 */
  databaseUrl: string;
  /** 文件存储根目录：必须与 API 侧一致，否则 worker 读不到源文件。 */
  fileStoreRoot: string;
  /** 上游地址：指向替身上游的 HTTP 服务。 */
  ragflowBaseUrl: string;
  /** 操作租约时长（毫秒）。 */
  leaseMs: number;
  /** 单次上传超时（毫秒）：决定 worker 能在挂起的上传里待多久。 */
  uploadTimeoutMs: number;
  /** 只读调用总预算（毫秒）。 */
  readBudgetMs: number;
  /** 单次只读超时（毫秒）。 */
  readTimeoutMs?: number;
  /** 连接超时（毫秒）。 */
  connectTimeoutMs?: number;
  /** 轮询间隔（毫秒）。 */
  pollIntervalMs?: number;
  /** 单轮批量上限。 */
  batchSize?: number;
}

export interface WorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface WorkerProcess {
  /** 操作系统进程号：被 kill 的就是这个进程。 */
  readonly pid: number;
  /** 完整启动命令：失败时用于定位。 */
  readonly command: string;
  /** 进程是否还活着。 */
  alive(): boolean;
  /** 收集到的 stdout + stderr。 */
  output(): string;
  /** 等待日志里出现指定文本（用于确认 worker 已经起来）。 */
  waitForLog(pattern: string | RegExp, timeoutMs?: number): Promise<string>;
  /** 等待进程退出。 */
  waitForExit(timeoutMs?: number): Promise<WorkerExit>;
  /** 发信号（默认 SIGKILL）并等待进程真的消失。 */
  kill(signal?: NodeJS.Signals): Promise<void>;
  /** 优雅停止：先 SIGTERM，超时再 SIGKILL。 */
  stop(): Promise<void>;
}

const TSX_LOADER = resolveTsxLoader();

export async function startWorkerProcess(
  options: WorkerProcessOptions,
): Promise<WorkerProcess> {
  const args = ['--import', TSX_LOADER, WORKER_MAIN];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    AIP_PROJECT_ID: options.projectId,
    DATABASE_URL: options.databaseUrl,
    AIP_FILE_STORE_ROOT: options.fileStoreRoot,
    OIDC_ISSUER: 'https://worker.test.local',
    OIDC_AUDIENCE: 'aip-test',
    RAGFLOW_BASE_URL: options.ragflowBaseUrl,
    RAGFLOW_API_KEY: 'test-api-key',
    RAGFLOW_API_VERSION: 'v0.20.5',
    AIP_OPERATION_LEASE_MS: String(options.leaseMs),
    RAGFLOW_UPLOAD_TIMEOUT_MS: String(options.uploadTimeoutMs),
    RAGFLOW_READ_BUDGET_MS: String(options.readBudgetMs),
    RAGFLOW_READ_TIMEOUT_MS: String(options.readTimeoutMs ?? 2000),
    RAGFLOW_CONNECT_TIMEOUT_MS: String(options.connectTimeoutMs ?? 1000),
    WORKER_POLL_INTERVAL_MS: String(options.pollIntervalMs ?? 200),
    WORKER_BATCH_SIZE: String(options.batchSize ?? 10),
    TSX_TSCONFIG_PATH: WORKER_TSCONFIG,
    LOG_LEVEL: 'info',
  };

  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let outputBuffer = '';
  const append = (chunk: Buffer): void => {
    outputBuffer += chunk.toString('utf8');
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);

  let exited = false;
  let exit: WorkerExit = { code: null, signal: null };
  const exitedPromise = new Promise<WorkerExit>((resolve) => {
    child.on('exit', (code, signal) => {
      exited = true;
      exit = { code, signal };
      resolve(exit);
    });
  });

  const pid: number = child.pid ?? -1;
  if (pid < 0) {
    throw new Error('worker process did not start');
  }

  const command = `${process.execPath} ${args.join(' ')}`;

  function output(): string {
    return outputBuffer;
  }

  function alive(): boolean {
    if (exited) return false;
    try {
      // 信号 0 只做存在性检查，不投递信号。
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // EPERM：进程存在但当前用户无权发信号——它仍然活着。
      if (code === 'EPERM') return true;
      return false;
    }
  }

  async function waitForExit(timeoutMs = 10_000): Promise<WorkerExit> {
    if (exited) return exit;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`worker process ${pid} did not exit within ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([exitedPromise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function waitForLog(pattern: string | RegExp, timeoutMs = 20_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match =
        typeof pattern === 'string'
          ? outputBuffer.includes(pattern)
          : pattern.test(outputBuffer);
      if (match) return outputBuffer;
      if (exited) {
        throw new Error(
          `worker process ${pid} exited before logging ${String(pattern)}:\n${outputBuffer}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      `worker process ${pid} did not log ${String(pattern)} within ${timeoutMs}ms:\n${outputBuffer}`,
    );
  }

  async function kill(signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
    if (exited) return;
    try {
      process.kill(pid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') throw error;
    }
    await waitForExit(10_000);
    // 进程退出后必须确认它真的消失了：pid 不能仍然存在。
    const deadline = Date.now() + 5_000;
    while (alive() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (alive()) {
      throw new Error(`worker process ${pid} is still alive after ${signal}`);
    }
  }

  async function stop(): Promise<void> {
    if (exited) return;
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') throw error;
    }
    try {
      await waitForExit(5_000);
    } catch {
      await kill('SIGKILL');
    }
  }

  return { pid, command, alive, output, waitForLog, waitForExit, kill, stop };
}

/** 断言某个 pid 已经不存在（进程真的被 kill 掉了）。 */
export function assertProcessGone(pid: number): void {
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      alive = false;
    } else if (code !== 'EPERM') {
      throw error;
    }
  }
  if (alive) {
    throw new Error(`process ${pid} is still alive`);
  }
}
