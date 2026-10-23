import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { knowledgeAuthorization, withTransaction } from '@aip/api';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { createReadyKnowledgeBase, prepareApprovedDocument } from '../helpers/flow.js';

/**
 * M20：下载授权被撤销后的行为。
 *
 * 断言口径：
 * - 撤销文档级授权后，来源下载必须被拒绝，且不得暴露资源是否存在；
 * - 撤销同时清掉可读与可下载两个权限位，并推进授权修订号。
 */
describe('M20 下载授权撤销', () => {
  let harness: Harness;
  let token: string;
  let kbId: string;
  let knowledgeRef: string;
  let version: string;
  let sourceRef: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'dlrevoke' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
    const kb = await createReadyKnowledgeBase(harness, token, 'M20 下载撤销');
    kbId = kb.kbId;
    const document = await prepareApprovedDocument(harness, token, kbId, {
      marker: 'M20-DOWNLOAD',
    });
    knowledgeRef = document.knowledgeRef;
    version = document.version;
    sourceRef = document.sourceRef;
  });

  afterAll(async () => {
    await harness.close();
  });

  async function download() {
    return harness.request({
      method: 'GET',
      path: `/sources/${sourceRef}/versions/${version}/download`,
      token,
    });
  }

  async function authzRevision(): Promise<number> {
    const { rows } = await harness.pool.query(
      `SELECT revision FROM authz_state WHERE scope_id = $1`,
      [harness.projectId],
    );
    return Number(rows[0]?.revision ?? 0);
  }

  it('撤销前可以下载原始文件', async () => {
    const response = await download();
    expect(response.status).toBe(200);
    expect(response.text).toContain('M20-DOWNLOAD');
  });

  it('撤销文档级授权后下载被拒绝', async () => {
    const revisionBefore = await authzRevision();
    await withTransaction(harness.pool, (client) =>
      knowledgeAuthorization.revokeDocument(client, {
        scopeId: harness.projectId,
        knowledgeId: knowledgeRef,
        knowledgeVersion: version,
        subject: 'user-1',
      }),
    );

    const response = await download();
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
    expect(response.body.message).toBe('source file not found');

    // 授权位必须同时失效，并且授权修订号被推进。
    const grants = await knowledgeAuthorization.listDocumentGrants(harness.pool, {
      scopeId: harness.projectId,
      knowledgeId: knowledgeRef,
      knowledgeVersion: version,
    });
    expect(grants).toHaveLength(1);
    expect(grants[0]!.can_read).toBe(false);
    expect(grants[0]!.can_download).toBe(false);
    expect(await authzRevision()).toBeGreaterThan(revisionBefore);
  });

  it('撤销后检索也不再召回该知识', async () => {
    const before = harness.ragflow.calls.length;
    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M20-DOWNLOAD', kb_ids: [kbId] },
    });
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('no_match');
    expect(response.body.data.evidence).toEqual([]);
    expect(harness.ragflow.calls.slice(before)).toHaveLength(0);
  });
});
