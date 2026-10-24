import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import {
  createReadyKnowledgeBase,
  prepareApprovedDocument,
  seedRetrievalChunk,
} from '../helpers/flow.js';

/**
 * 交付边界：末次授权判定与响应交付必须落在同一个序列化边界内。
 *
 * 两条反例分别打在这条边界的两侧：
 * - 授权判定事务提交之后、HTTP 正文发出之前提交的撤权/撤回，必须被拒；
 * - 交付事务仍然持有授权行锁时，并发的撤权必须阻塞到交付事务提交之后。
 *
 * 注入点是真实 PostgreSQL：SQL、检查、撤权/撤回 API 与 Express 发送都照常执行，
 * 只挡住 COMMIT 的时机（执行前或确认返回前）。不是把授权函数替成固定成功，
 * 也不是只改 fixture 状态。
 */
let h: Harness;
let token: string;

beforeEach(async () => {
  h = await createHarness({ label: 'commit_gate' });
  token = await h.token({ permissions: ALL_PERMISSIONS });
});

afterEach(async () => {
  await h.close();
});

interface CommitGate {
  /** 从这一刻开始计数 COMMIT。 */
  arm(): void;
  /** 目标 COMMIT 到达时的信号。 */
  reached: Promise<void>;
  /** 放行被挡住的 COMMIT。 */
  release(): void;
  /** 还原连接池。 */
  restore(): void;
}

/**
 * 在连接池上装一个 COMMIT 闸门。
 *
 * @param mode `before-exec` 在 COMMIT 执行前挡住（事务仍然持锁）；
 *             `after-ack` 在 COMMIT 已执行、确认返回前挡住（锁已释放）。
 * @param target 从布防起第几个 COMMIT 被挡住。
 */
function installCommitGate(
  harness: Harness,
  mode: 'before-exec' | 'after-ack',
  target = 1,
): CommitGate {
  const connect = harness.pool.connect.bind(harness.pool);
  let armed = false;
  let count = 0;
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => {
    entered = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });

  const wrap = (client: any) => {
    if (client.__zach14Wrapped) return;
    client.__zach14Wrapped = true;
    const query = client.query.bind(client);
    client.query = (...queryArgs: any[]) => {
      const last = queryArgs[queryArgs.length - 1];
      if (typeof last === 'function') {
        // 回调形式是连接池内部查询在用，原样透传。
        return query(...queryArgs);
      }
      return (async () => {
        if (armed && queryArgs[0] === 'COMMIT') {
          count += 1;
          if (count === target) {
            entered();
            if (mode === 'before-exec') {
              await gate;
              return query(...queryArgs);
            }
            const result = await query(...queryArgs);
            await gate;
            return result;
          }
        }
        return query(...queryArgs);
      })();
    };
  };

  (harness.pool as any).connect = (...args: any[]) => {
    if (typeof args[0] === 'function') {
      const callback = args[0];
      args[0] = (err: unknown, client: any) => {
        wrap(client);
        callback(err, client);
      };
      return (connect as any)(...args);
    }
    return (connect as any)(...args).then((client: any) => {
      wrap(client);
      return client;
    });
  };

  return {
    arm: () => {
      armed = true;
    },
    reached,
    release: () => release(),
    restore: () => {
      (harness.pool as any).connect = connect;
    },
  };
}

/** 给等待加上上限：闸门没被触发时快速失败，而不是把测试拖到超时。 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 等到上游确实收到了检索请求。 */
async function waitForUpstreamRetrieval(harness: Harness): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (
      harness.ragflow.calls.some(
        (call) => call.method === 'POST' && call.path === '/api/v1/retrieval',
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the upstream retrieval call was not observed');
}

for (const mode of ['revoke', 'withdraw'] as const) {
  it(`授权事务提交后、HTTP 交付前提交的${mode === 'revoke' ? '撤权' : '撤回'}必须被拒`, async () => {
    const kb = await createReadyKnowledgeBase(h, token);
    const d = await prepareApprovedDocument(h, token, kb.kbId, { marker: 'AFTER-FINAL-CHECK' });
    const detail = await h.request({
      path: `/knowledge/${d.knowledgeRef}/versions/${d.version}`,
      token,
    });
    const gate = installCommitGate(h, 'after-ack');
    // 只在文件读完时布防：被挡住的必须是末次授权事务，
    // 而不是更早的授权读取。
    const read = h.files.read.bind(h.files);
    h.files.read = async (key: string) => {
      const bytes = await read(key);
      gate.arm();
      return bytes;
    };
    const pending = h.request({
      path: `/sources/${d.sourceRef}/versions/${d.version}/download`,
      token,
    });
    await gate.reached;
    let changed;
    try {
      changed =
        mode === 'revoke'
          ? await h.request({
              method: 'DELETE',
              path: `/knowledge/${d.knowledgeRef}/versions/${d.version}/grants/user-1`,
              token,
            })
          : await h.request({
              method: 'POST',
              path: `/knowledge/${d.knowledgeRef}/versions/${d.version}/withdraw`,
              token,
              json: {
                expected_state_revision: detail.body.data.state_revision,
                reason: 'before HTTP delivery',
              },
            });
      expect(changed.status).toBe(200);
    } finally {
      gate.release();
      gate.restore();
    }
    const delivered = await pending;
    expect(
      delivered.status,
      'revocation committed after final DB check but before HTTP send',
    ).toBe(404);
    expect(delivered.text).not.toContain('AFTER-FINAL-CHECK');
  });
}

it('下载交付在授权锁内完成：并发撤权必须等交付事务提交后才提交', async () => {
  const kb = await createReadyKnowledgeBase(h, token);
  const d = await prepareApprovedDocument(h, token, kb.kbId, { marker: 'INSIDE-LOCK' });
  const gate = installCommitGate(h, 'before-exec', 2);
  const read = h.files.read.bind(h.files);
  h.files.read = async (key: string) => {
    const bytes = await read(key);
    gate.arm();
    return bytes;
  };

  const pending = h.request({
    path: `/sources/${d.sourceRef}/versions/${d.version}/download`,
    token,
  });
  // 第一个 COMMIT 是读取窗口判定，第二个才是交付事务。
  const reached = await Promise.race([
    gate.reached.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  expect(reached, '交付必须在事务提交之前完成').toBe(true);
  const delivered = await withTimeout(pending, 5000, '下载交付');
  expect(delivered.status).toBe(200);
  expect(delivered.text).toContain('INSIDE-LOCK');

  // 交付事务仍然持有授权行锁：并发撤权必须阻塞到它提交之后。
  let revokeSettled = false;
  const revoke = h
    .request({
      method: 'DELETE',
      path: `/knowledge/${d.knowledgeRef}/versions/${d.version}/grants/user-1`,
      token,
    })
    .then((result) => {
      revokeSettled = true;
      return result;
    });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(revokeSettled, '撤权必须阻塞在交付事务持有的授权行锁上').toBe(false);

  gate.release();
  const revoked = await revoke;
  expect(revoked.status).toBe(200);
  gate.restore();
});

it('检索交付在授权锁内完成：并发撤权必须等交付事务提交后才提交', async () => {
  const kb = await createReadyKnowledgeBase(h, token);
  const d = await prepareApprovedDocument(h, token, kb.kbId, { marker: 'RETRIEVAL-LOCK' });
  seedRetrievalChunk(h, {
    documentId: d.documentId,
    datasetId: d.datasetId,
    content: 'RETRIEVAL-LOCK',
  });
  // 上游响应延迟：给布防留出窗口，交付事务一定在它之后开始。
  h.ragflow.enqueue(
    (call) => call.method === 'POST' && call.path === '/api/v1/retrieval',
    {
      status: 200,
      delayMs: 400,
      body: {
        code: 0,
        message: 'success',
        data: {
          chunks: [
            {
              id: 'chunk-retrieval-lock',
              content: 'RETRIEVAL-LOCK',
              document_id: d.documentId,
              dataset_id: d.datasetId,
              similarity: 0.9,
            },
          ],
        },
      },
    },
  );
  const gate = installCommitGate(h, 'before-exec');
  const pending = h.request({
    method: 'POST',
    path: '/retrieval',
    token,
    json: { query: 'RETRIEVAL-LOCK', kb_ids: [kb.kbId] },
  });
  await waitForUpstreamRetrieval(h);
  gate.arm();
  const reached = await Promise.race([
    gate.reached.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  expect(reached, '检索交付必须在事务提交之前完成').toBe(true);
  const delivered = await withTimeout(pending, 5000, '检索交付');
  expect(delivered.status).toBe(200);
  expect(delivered.body.data.evidence).toHaveLength(1);

  let revokeSettled = false;
  const revoke = h
    .request({
      method: 'DELETE',
      path: `/knowledge/${d.knowledgeRef}/versions/${d.version}/grants/user-1`,
      token,
    })
    .then((result) => {
      revokeSettled = true;
      return result;
    });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(revokeSettled, '撤权必须阻塞在交付事务持有的授权行锁上').toBe(false);

  gate.release();
  const revoked = await revoke;
  expect(revoked.status).toBe(200);
  gate.restore();
});

it('证据交付在授权锁内完成：并发撤权必须等交付事务提交后才提交', async () => {
  const kb = await createReadyKnowledgeBase(h, token);
  const d = await prepareApprovedDocument(h, token, kb.kbId, { marker: 'EVIDENCE-LOCK' });
  seedRetrievalChunk(h, {
    documentId: d.documentId,
    datasetId: d.datasetId,
    content: 'EVIDENCE-LOCK',
  });
  const retrieval = await h.request({
    method: 'POST',
    path: '/retrieval',
    token,
    json: { query: 'EVIDENCE-LOCK', kb_ids: [kb.kbId] },
  });
  expect(retrieval.status).toBe(200);
  const evidenceId = retrieval.body.data.evidence[0].evidence_id as string;

  const gate = installCommitGate(h, 'before-exec');
  gate.arm();
  const pending = h.request({ path: `/evidence/${evidenceId}`, token });
  const reached = await Promise.race([
    gate.reached.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  expect(reached, '证据交付必须在事务提交之前完成').toBe(true);
  const delivered = await withTimeout(pending, 5000, '证据交付');
  expect(delivered.status).toBe(200);
  expect(delivered.body.data.content).toBe('EVIDENCE-LOCK');

  let revokeSettled = false;
  const revoke = h
    .request({
      method: 'DELETE',
      path: `/knowledge/${d.knowledgeRef}/versions/${d.version}/grants/user-1`,
      token,
    })
    .then((result) => {
      revokeSettled = true;
      return result;
    });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(revokeSettled, '撤权必须阻塞在交付事务持有的授权行锁上').toBe(false);

  gate.release();
  const revoked = await revoke;
  expect(revoked.status).toBe(200);
  gate.restore();
});
