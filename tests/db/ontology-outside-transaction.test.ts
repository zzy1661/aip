import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConceptValidator } from '@aip/api';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { registerSkillRequest, skillPayload } from '../helpers/fixtures.js';

/**
 * M-7：本体网络调用不得发生在数据库事务内。
 *
 * 断言方式不是「看代码」，而是观测事实：本体校验执行的那一刻，
 * 数据库里不允许存在处于 `idle in transaction` 的连接。
 * 事务跨越网络调用时，连接正停在这个状态上。
 */
describe('M-7 本体调用在事务之外', () => {
  let harness: Harness;
  let token: string;
  let idleInTransaction: number[] = [];

  beforeAll(async () => {
    const observer: ConceptValidator = {
      async validate() {
        const { rows } = await harness.pool.query<{ count: number }>(
          `SELECT count(*)::int AS count
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND state = 'idle in transaction'`,
        );
        idleInTransaction.push(rows[0]!.count);
        return { ok: true };
      },
    };
    harness = await createHarness({ label: 'm7', conceptValidator: observer });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  function conceptSkill(slug: string): Record<string, unknown> {
    return registerSkillRequest({
      slug,
      payload: skillPayload({
        input_contract: [
          {
            name: 'amount',
            concept_ref: 'demo:Quantity',
            data_type: 'NUMBER',
            unit_ref: 'demo:unit:Celsius',
            ontology_version: 'demo-ontology-1.0.0',
            vocabulary_version: 'demo-vocab-1.0.0',
            required: true,
          },
        ],
        concept_validation: 'validated',
      }),
    });
  }

  it('注册含概念引用的技能时，本体调用期间没有挂起的数据库事务', async () => {
    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm7-register',
      json: conceptSkill('m7-register'),
    });
    expect(response.status).toBe(201);
    expect(idleInTransaction).toHaveLength(1);
    expect(idleInTransaction[0]).toBe(0);
  });

  it('创建新版本时，本体调用期间同样没有挂起的数据库事务', async () => {
    const created = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm7-parent',
      json: conceptSkill('m7-parent'),
    });
    const assetId = created.body.data.asset_id as string;
    idleInTransaction = [];

    const version = await harness.request({
      method: 'POST',
      path: `/assets/${assetId}/versions`,
      token,
      idempotencyKey: 'm7-new-version',
      json: {
        version: '1.0.1',
        title: 'M7 新版本',
        description: '带概念契约的新版本',
        payload: conceptSkill('m7-parent').payload,
      },
    });
    expect(version.status).toBe(201);
    expect(idleInTransaction).toHaveLength(1);
    expect(idleInTransaction[0]).toBe(0);
  });
});
