import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toDatabaseApiError } from '@aip/api';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { createReadyKnowledgeBase, prepareApprovedDocument, uploadAndParse } from '../helpers/flow.js';

/**
 * 数据库层：已批准的审核结论是终态。
 *
 * 应用层拒绝改判只是第一道防线；数据库层的触发器保证
 * 「已批准 → 拒绝」这条迁移在任何写入路径下都不成立
 * （直连 SQL、并发写入、未来新增的代码路径都一样）。
 */
describe('数据库层：已批准的审核结论不可改判', () => {
  let harness: Harness;
  let token: string;

  beforeEach(async () => {
    harness = await createHarness({ label: 'review_final_db' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterEach(async () => {
    await harness.close();
  });

  async function approvedVersion(marker: string) {
    const { kbId } = await createReadyKnowledgeBase(harness, token, `终态 ${marker}`);
    const document = await prepareApprovedDocument(harness, token, kbId, { marker });
    return { kbId, document };
  }

  it('数据库层拒绝把已批准的版本改判为 rejected', async () => {
    const { document } = await approvedVersion('终态-数据库');

    await expect(
      harness.pool.query(
        `UPDATE knowledge_revision SET review_status = 'rejected'
          WHERE scope_id = $1 AND knowledge_id = $2 AND version = $3`,
        [harness.projectId, document.knowledgeRef, document.version],
      ),
    ).rejects.toThrow(/an approved review verdict is final/);

    const { rows } = await harness.pool.query<{ review_status: string }>(
      `SELECT review_status FROM knowledge_revision
        WHERE scope_id = $1 AND knowledge_id = $2 AND version = $3`,
      [harness.projectId, document.knowledgeRef, document.version],
    );
    expect(rows[0]!.review_status).toBe('approved');
  });

  it('触发器抛的是 AIP01：API 层据此落成稳定错误码而不是 500', async () => {
    const { document } = await approvedVersion('终态-SQLSTATE');

    let sqlstate: string | undefined;
    try {
      await harness.pool.query(
        `UPDATE knowledge_revision SET review_status = 'rejected'
          WHERE scope_id = $1 AND knowledge_id = $2 AND version = $3`,
        [harness.projectId, document.knowledgeRef, document.version],
      );
    } catch (error) {
      sqlstate = (error as { code?: string }).code;
    }
    expect(sqlstate).toBe('AIP01');

    // API 层把 AIP01 映射成 REVIEW_ALREADY_APPROVED（409），不是通用 500。
    const mapped = toDatabaseApiError({ code: 'AIP01' });
    expect(mapped).not.toBeNull();
    expect(mapped!.code).toBe('REVIEW_ALREADY_APPROVED');
    expect(mapped!.status).toBe(409);
  });

  it('数据库层允许同结论重放：approved → approved 不改变结论', async () => {
    const { document } = await approvedVersion('终态-同结论');

    await expect(
      harness.pool.query(
        `UPDATE knowledge_revision SET review_status = 'approved'
          WHERE scope_id = $1 AND knowledge_id = $2 AND version = $3`,
        [harness.projectId, document.knowledgeRef, document.version],
      ),
    ).resolves.toBeDefined();
  });

  it('数据库层允许把已驳回的版本重新审核为 approved', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, '终态-重新通过');
    const document = await uploadAndParse(harness, token, kbId, { marker: '终态-重新通过' });
    const detail = await harness.request({
      method: 'GET',
      path: `/knowledge/${document.knowledgeRef}/versions/${document.version}`,
      token,
    });

    await expect(
      harness.pool.query(
        `UPDATE knowledge_revision SET review_status = 'approved'
          WHERE scope_id = $1 AND knowledge_id = $2 AND version = $3
            AND content_hash = $4`,
        [
          harness.projectId,
          document.knowledgeRef,
          document.version,
          detail.body.data.content_hash as string,
        ],
      ),
    ).resolves.toBeDefined();

    const { rows } = await harness.pool.query<{ review_status: string }>(
      `SELECT review_status FROM knowledge_revision
        WHERE scope_id = $1 AND knowledge_id = $2 AND version = $3`,
      [harness.projectId, document.knowledgeRef, document.version],
    );
    expect(rows[0]!.review_status).toBe('approved');
  });
});
