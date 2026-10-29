import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { operationsRepository, withTransaction } from '@aip/api';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { TEST_DATABASE_URL } from '../helpers/db.js';
import { sampleMarkdown, UNCONDITIONAL_APPLIES_TO } from '../helpers/fixtures.js';
import {
  assertProcessGone,
  startWorkerProcess,
  type WorkerProcess,
} from '../helpers/worker-process.js';

/**
 * M14：解析恢复与栅栏 —— 真实 worker 进程级别的崩溃恢复。
 *
 * 既有用例（operation-fencing / crash-window-recovery）用「持久状态重建」
 * 模拟崩溃窗口：进程没死，只是把数据库里的状态改回去。
 * 这里起的是真的 worker 进程（services/worker/src/main.ts），
 * 真的用 SIGKILL 把它杀掉，再起一个新进程接管。
 *
 * 判据：
 * 1. kill 掉持有租约的进程后，接管者认领同一个上游文档，上游只被上传一次；
 * 2. 接管后 epoch 变大，旧 epoch 的迟到写入被数据库拒绝；
 * 3. 两个 worker 进程同时抢同一个操作，只有一个拿到租约。
 *
 * 全部等待都靠轮询数据库状态或轮询上游调用计数，不靠固定 sleep。
 */

/** 短租约：租约必须大于「一次上传 + 一次只读」的最坏耗时。 */
const LEASE_MS = 6000;
const UPLOAD_TIMEOUT_MS = 4000;
const READ_BUDGET_MS = 1000;
/** 长租约：让持有租约的进程可以一直挂在挂起的上传里。 */
const LONG_LEASE_MS = 62_000;
const LONG_UPLOAD_TIMEOUT_MS = 60_000;

interface PollOptions {
  timeoutMs: number;
  intervalMs?: number;
  what: string;
}

/** 轮询直到条件成立；超时抛错，不靠固定 sleep 猜时间。 */
async function waitFor<T>(
  probe: () => Promise<T | null>,
  options: PollOptions,
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  const interval = options.intervalMs ?? 25;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== null && value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`timed out after ${options.timeoutMs}ms waiting for ${options.what}`);
}

function uploadCalls(harness: Harness) {
  return harness.ragflow.calls.filter(
    (call) => call.method === 'POST' && call.path.endsWith('/documents'),
  );
}

/** 在途状态：上传响应还没回来时操作仍是 pending，响应回来后才转 in_progress。 */
const IN_FLIGHT_STATES = ['pending', 'in_progress'];

function readOperation(harness: Harness, operationId: string) {
  return withTransaction(harness.pool, (client) =>
    operationsRepository.findOperation(client, harness.projectId, operationId),
  );
}

/** 指向同一个测试 schema 的 worker 连接串。 */
function workerDatabaseUrl(harness: Harness): string {
  return `${TEST_DATABASE_URL}?options=-c%20search_path%3D${harness.db.schema}`;
}

interface Scenario {
  harness: Harness;
  /** 第一个 worker 进程：稍后会被真的 kill 掉。 */
  worker: WorkerProcess;
  operationId: string;
  kbId: string;
  knowledgeRef: string;
  /** worker 起来之前上游的连接数：进程死后必须回到这个基线。 */
  baselineConnections: number;
}

async function startWorker(harness: Harness, overrides: {
  leaseMs?: number;
  uploadTimeoutMs?: number;
} = {}): Promise<WorkerProcess> {
  const worker = await startWorkerProcess({
    projectId: harness.projectId,
    databaseUrl: workerDatabaseUrl(harness),
    fileStoreRoot: harness.fileStoreRoot,
    ragflowBaseUrl: harness.ragflow.url,
    leaseMs: overrides.leaseMs ?? LEASE_MS,
    uploadTimeoutMs: overrides.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS,
    readBudgetMs: READ_BUDGET_MS,
    pollIntervalMs: 200,
  });
  await worker.waitForLog('aip worker started');
  return worker;
}

/**
 * 构造崩溃窗口：
 * 知识库建好、文档上传接口已受理，worker 进程正卡在上游的上传请求里。
 */
async function startUploadScenario(label: string): Promise<Scenario> {
  const fileStoreRoot = await mkdtemp(join(tmpdir(), `aip-worker-${label}-`));
  const harness = await createHarness({ label, fileStoreRoot });
  const token = await harness.token({ permissions: ALL_PERMISSIONS });

  const created = await harness.request({
    method: 'POST',
    path: '/knowledge-bases',
    token,
    idempotencyKey: `kb-${label}`,
    json: { name: `崩溃恢复 ${label}`, description: '' },
  });
  expect(created.status).toBe(202);
  const kbId = created.body.data.kb_id as string;

  const baselineConnections = harness.ragflow.openConnections();
  const worker = await startWorker(harness);

  // 知识库由 worker 进程创建上游数据集后才会 ready。
  await waitFor(
    async () => {
      const result = await harness.pool.query<{
        status: string;
        ragflow_dataset_id: string | null;
      }>(
        'SELECT status, ragflow_dataset_id FROM knowledge_base WHERE scope_id = $1 AND id = $2',
        [harness.projectId, kbId],
      );
      const row = result.rows[0];
      return row && row.status === 'ready' && row.ragflow_dataset_id ? row : null;
    },
    { timeoutMs: 30_000, what: 'knowledge base ready' },
  );

  // 上游的上传请求挂住：请求已送达（文档已登记），响应永不回来。
  harness.ragflow.enqueue(
    (call) => call.method === 'POST' && /^\/api\/v1\/datasets\/[^/]+\/documents$/.test(call.path),
    { status: 200, hang: true },
  );

  const uploaded = await harness.request({
    method: 'POST',
    path: `/knowledge-bases/${kbId}/documents`,
    token,
    idempotencyKey: `doc-${label}`,
    fields: {
      version: '1.0.0',
      applies_to: JSON.stringify(UNCONDITIONAL_APPLIES_TO),
    },
    file: {
      filename: `${label}.md`,
      contentType: 'text/markdown',
      content: sampleMarkdown(`M14-${label}`),
    },
  });
  expect(uploaded.status).toBe(202);
  const operationId = uploaded.body.data.operation_id as string;
  const knowledgeRef = uploaded.body.data.knowledge_ref as string;

  // 等上游真的收到这次上传：此时 worker 正持有租约卡在请求里。
  await waitFor(
    async () => (uploadCalls(harness).length >= 1 ? true : null),
    { timeoutMs: 30_000, intervalMs: 10, what: 'upstream upload request' },
  );

  return { harness, worker, operationId, kbId, knowledgeRef, baselineConnections };
}

async function cleanup(scenario: Scenario, extra: WorkerProcess[] = []): Promise<void> {
  for (const worker of [...extra, scenario.worker]) {
    try {
      await worker.stop();
    } catch {
      // 清理失败不能掩盖用例本身的结论。
    }
  }
  await scenario.harness.close();
}

describe('M14 真实 worker 进程的解析恢复与栅栏', () => {
  it('kill 掉持有租约的 worker 进程后，接管者认领同一个上游文档，上游只被上传一次', async () => {
    const scenario = await startUploadScenario('crash-kill');
    const { harness, worker, operationId } = scenario;
    let takeover: WorkerProcess | undefined;
    try {
      // 上游只收到过一次上传，文档也已经登记：worker 卡在「请求已送达、响应未回」。
      expect(uploadCalls(harness)).toHaveLength(1);
      expect(harness.ragflow.documents.size).toBe(1);
      const upstreamDocument = [...harness.ragflow.documents.values()][0]!;

      // 被 kill 的 worker 此刻正持有租约。
      const held = await readOperation(harness, operationId);
      expect(held).not.toBeNull();
      expect(IN_FLIGHT_STATES).toContain(held!.state);
      expect(Number(held!.attempt)).toBe(1);
      expect(held!.lease_until).not.toBeNull();
      const killedEpoch = Number(held!.epoch);
      // 崩溃窗口成立：发送意图已落库（stage=upload_attempted + 远端唯一名），
      // 但上游响应没回来，远端文档 ID 还没落库。
      expect(held!.remote_id).toBeNull();
      const heldProgress = held!.result as { stage?: string; remoteName?: string };
      expect(heldProgress.stage).toBe('upload_attempted');
      expect(heldProgress.remoteName).toBeTruthy();

      // 真的 kill 掉这个进程，并确认它真的死了。
      await worker.kill('SIGKILL');
      assertProcessGone(worker.pid);
      expect(worker.alive()).toBe(false);
      // 进程没了，它挂在上游的那条连接也必须一起消失：
      // 这从上游的角度证明「那个进程真的没了」，而不只是「pid 被回收了」。
      await waitFor(
        async () =>
          harness.ragflow.openConnections() === scenario.baselineConnections ? true : null,
        {
          timeoutMs: 10_000,
          intervalMs: 25,
          what: 'upstream connection closed together with the dead worker',
        },
      );

      // 进程死了，租约没人释放：操作仍然在途，等租约自然到期。
      // 活着的 worker 在失败分支里会释放租约并改写状态，
      // 所以「租约与状态原封不动」本身就是「它确实是被 kill 掉的」的证据。
      const afterKill = await readOperation(harness, operationId);
      expect(afterKill!.state).toBe(held!.state);
      expect(afterKill!.lease_until!.getTime()).toBe(held!.lease_until!.getTime());
      expect(Number(afterKill!.epoch)).toBe(killedEpoch);
      expect(Number(afterKill!.attempt)).toBe(Number(held!.attempt));

      await waitFor(
        async () => {
          const row = await readOperation(harness, operationId);
          // 死掉的进程不会再写任何东西：租约到期之前，操作行必须完全静止。
          // 活着的 worker 会在上传超时后改写状态并释放租约——那一行一动就说明进程还活着。
          expect(row!.state).toBe(held!.state);
          expect(row!.lease_until?.getTime() ?? null).toBe(held!.lease_until!.getTime());
          expect(Number(row!.epoch)).toBe(killedEpoch);
          expect(Number(row!.attempt)).toBe(Number(held!.attempt));
          return row!.lease_until && row!.lease_until.getTime() <= Date.now() ? true : null;
        },
        { timeoutMs: 30_000, intervalMs: 50, what: 'lease expiry' },
      );

      // 新进程接管。
      takeover = await startWorker(harness);
      const final = await waitFor(
        async () => {
          const row = await readOperation(harness, operationId);
          return row!.state === 'succeeded' ? row : null;
        },
        { timeoutMs: 40_000, intervalMs: 50, what: 'upload operation succeeded' },
      );

      // 判据 1：接管没有产生第二次上传，用的还是同一个上游文档。
      expect(uploadCalls(harness)).toHaveLength(1);
      expect(harness.ragflow.documents.size).toBe(1);
      expect(final!.remote_id).toBe(upstreamDocument.id);
      // epoch 与 attempt 单调递增：接管是新一轮，不是复用旧的一轮。
      expect(Number(final!.epoch)).toBeGreaterThan(killedEpoch);
      expect(Number(final!.attempt)).toBeGreaterThan(Number(held!.attempt));

      const revision = await harness.pool.query<{ status: string }>(
        'SELECT status FROM knowledge_revision WHERE scope_id = $1 AND knowledge_id = $2',
        [harness.projectId, scenario.knowledgeRef],
      );
      expect(revision.rows[0]!.status).toBe('parsing');
    } finally {
      await cleanup(scenario, takeover ? [takeover] : []);
    }
  });

  it('接管之后，旧 epoch 的迟到写入被数据库拒绝', async () => {
    const scenario = await startUploadScenario('crash-fence');
    const { harness, worker, operationId } = scenario;
    let takeover: WorkerProcess | undefined;
    try {
      const held = await readOperation(harness, operationId);
      const killedEpoch = Number(held!.epoch);
      expect(killedEpoch).toBeGreaterThan(0);
      // 崩溃窗口成立：远端文档 ID 还没落库，接管者只能靠只读核对认领。
      expect(held!.remote_id).toBeNull();
      expect((held!.result as { stage?: string }).stage).toBe('upload_attempted');

      await worker.kill('SIGKILL');
      assertProcessGone(worker.pid);
      expect(worker.alive()).toBe(false);
      // 进程没了，它挂在上游的那条连接也必须一起消失：
      // 这从上游的角度证明「那个进程真的没了」，而不只是「pid 被回收了」。
      await waitFor(
        async () =>
          harness.ragflow.openConnections() === scenario.baselineConnections ? true : null,
        {
          timeoutMs: 10_000,
          intervalMs: 25,
          what: 'upstream connection closed together with the dead worker',
        },
      );

      await waitFor(
        async () => {
          const row = await readOperation(harness, operationId);
          // 死掉的进程不会再写任何东西：租约到期之前，操作行必须完全静止。
          // 活着的 worker 会在上传超时后改写状态并释放租约——那一行一动就说明进程还活着。
          expect(row!.state).toBe(held!.state);
          expect(row!.lease_until?.getTime() ?? null).toBe(held!.lease_until!.getTime());
          expect(Number(row!.epoch)).toBe(killedEpoch);
          expect(Number(row!.attempt)).toBe(Number(held!.attempt));
          return row!.lease_until && row!.lease_until.getTime() <= Date.now() ? true : null;
        },
        { timeoutMs: 30_000, intervalMs: 50, what: 'lease expiry' },
      );

      takeover = await startWorker(harness);
      const final = await waitFor(
        async () => {
          const row = await readOperation(harness, operationId);
          return row!.state === 'succeeded' ? row : null;
        },
        { timeoutMs: 40_000, intervalMs: 50, what: 'upload operation succeeded' },
      );
      const takeoverEpoch = Number(final!.epoch);

      // 接管者的 epoch 必须更大。
      expect(takeoverEpoch).toBeGreaterThan(killedEpoch);

      // 死掉的那个 worker 的迟到写入：旧 epoch 必须被数据库拒绝。
      const staleWrite = await withTransaction(harness.pool, (client) =>
        operationsRepository.setOperationState(
          client,
          harness.projectId,
          operationId,
          'succeeded',
          null,
          killedEpoch,
        ),
      );
      expect(staleWrite).toBe(false);

      // 对照：同一个写入用当前 epoch 必须成功——拒绝的原因只能是 epoch 不匹配。
      const freshWrite = await withTransaction(harness.pool, (client) =>
        operationsRepository.setOperationState(
          client,
          harness.projectId,
          operationId,
          'succeeded',
          null,
          takeoverEpoch,
        ),
      );
      expect(freshWrite).toBe(true);
    } finally {
      await cleanup(scenario, takeover ? [takeover] : []);
    }
  });

  it('两个 worker 进程同时抢同一个操作，只有一个拿到租约', async () => {
    const fileStoreRoot = await mkdtemp(join(tmpdir(), 'aip-worker-race-'));
    const harness = await createHarness({ label: 'race', fileStoreRoot });
    const token = await harness.token({ permissions: ALL_PERMISSIONS });
    const workers: WorkerProcess[] = [];
    try {
      const created = await harness.request({
        method: 'POST',
        path: '/knowledge-bases',
        token,
        idempotencyKey: 'kb-race',
        json: { name: '并发领取', description: '' },
      });
      expect(created.status).toBe(202);
      const kbId = created.body.data.kb_id as string;

      // 两个真实的 OS 进程，同时指向同一个 schema。
      const first = await startWorker(harness, {
        leaseMs: LONG_LEASE_MS,
        uploadTimeoutMs: LONG_UPLOAD_TIMEOUT_MS,
      });
      workers.push(first);
      const second = await startWorker(harness, {
        leaseMs: LONG_LEASE_MS,
        uploadTimeoutMs: LONG_UPLOAD_TIMEOUT_MS,
      });
      workers.push(second);
      expect(second.pid).not.toBe(first.pid);
      expect(first.alive()).toBe(true);
      expect(second.alive()).toBe(true);

      await waitFor(
        async () => {
          const result = await harness.pool.query<{ status: string }>(
            'SELECT status FROM knowledge_base WHERE scope_id = $1 AND id = $2',
            [harness.projectId, kbId],
          );
          return result.rows[0]!.status === 'ready' ? true : null;
        },
        { timeoutMs: 30_000, what: 'knowledge base ready' },
      );

      // 上传请求挂住：拿到租约的那个进程会一直卡在请求里，租约不会提前释放。
      harness.ragflow.enqueue(
        (call) => call.method === 'POST' && /^\/api\/v1\/datasets\/[^/]+\/documents$/.test(call.path),
        { status: 200, hang: true },
      );

      const uploaded = await harness.request({
        method: 'POST',
        path: `/knowledge-bases/${kbId}/documents`,
        token,
        idempotencyKey: 'doc-race',
        fields: {
          version: '1.0.0',
          applies_to: JSON.stringify(UNCONDITIONAL_APPLIES_TO),
        },
        file: {
          filename: 'race.md',
          contentType: 'text/markdown',
          content: sampleMarkdown('M14-race'),
        },
      });
      expect(uploaded.status).toBe(202);
      const operationId = uploaded.body.data.operation_id as string;

      await waitFor(
        async () => (uploadCalls(harness).length >= 1 ? true : null),
        { timeoutMs: 30_000, intervalMs: 10, what: 'upstream upload request' },
      );

      // 观察窗口：租约被持有期间，领取次数必须恒为 1。
      // claimOperationLease 每次成功领取都会 attempt+1 / epoch+1，
      // 所以 attempt 恒为 1 就等于「只被领取过一次」。
      const windowMs = 5000;
      const deadline = Date.now() + windowMs;
      while (Date.now() < deadline) {
        const row = await readOperation(harness, operationId);
        expect(Number(row!.attempt)).toBe(1);
        expect(Number(row!.epoch)).toBe(2);
        expect(IN_FLIGHT_STATES).toContain(row!.state);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      // 上游也只发生了一次上传：另一个进程没有抢到，也没有重发。
      expect(uploadCalls(harness)).toHaveLength(1);
      expect(harness.ragflow.documents.size).toBe(1);
      // 两个进程此刻都还活着：这确实是两个进程在抢。
      expect(first.alive()).toBe(true);
      expect(second.alive()).toBe(true);
    } finally {
      for (const worker of workers) {
        try {
          await worker.stop();
        } catch {
          // 清理失败不能掩盖用例本身的结论。
        }
      }
      await harness.close();
    }
  });
});
