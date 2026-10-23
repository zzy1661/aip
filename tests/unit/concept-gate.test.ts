import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConceptValidator } from '@aip/api';
import { apiError } from '@aip/api';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { registerSkillRequest, skillPayload } from '../helpers/fixtures.js';

/**
 * M23：概念契约校验门。
 *
 * 断言口径：本体不可用或概念不存在时必须拒绝注册，
 * 绝不把失败降级成「校验通过」；没有概念引用的字符串契约可以直接注册。
 */
describe('M23 概念契约校验门', () => {
  let harness: Harness;
  let token: string;
  let validatedRefs: unknown[];

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
        output_contract: [
          {
            name: 'summary',
            concept_ref: null,
            data_type: 'STRING',
            unit_ref: null,
            ontology_version: null,
            vocabulary_version: null,
            required: true,
          },
        ],
        concept_validation: 'validated',
      }),
    });
  }

  beforeAll(async () => {
    validatedRefs = [];
    const recorder: ConceptValidator = {
      async validate(refs) {
        validatedRefs.push(...refs);
        return { ok: true };
      },
    };
    harness = await createHarness({ label: 'm23', conceptValidator: recorder });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('本体校验通过的含概念契约可以注册', async () => {
    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm23-ok',
      json: conceptSkill('m23-ok'),
    });
    expect(response.status).toBe(201);
    expect(validatedRefs).toHaveLength(1);
    expect(validatedRefs[0]).toMatchObject({
      concept_ref: 'demo:Quantity',
      unit_ref: 'demo:unit:Celsius',
      ontology_version: 'demo-ontology-1.0.0',
      vocabulary_version: 'demo-vocab-1.0.0',
    });
  });

  it('本体不可用时拒绝注册，不降级为通过', async () => {
    const failing = await createHarness({
      label: 'm23-unavailable',
      conceptValidator: {
        async validate() {
          return {
            ok: false,
            reason: 'ontology service is not configured for this deployment',
            field_path: 'payload',
          };
        },
      },
    });
    try {
      const otherToken = await failing.token({ permissions: ALL_PERMISSIONS });
      const response = await failing.request({
        method: 'POST',
        path: '/assets',
        token: otherToken,
        idempotencyKey: 'm23-unavailable',
        json: conceptSkill('m23-unavailable'),
      });
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('CONTRACT_INVALID');

      const { rows } = await failing.pool.query(
        'SELECT count(*)::int AS count FROM asset_revision WHERE scope_id = $1',
        [failing.projectId],
      );
      expect(rows[0].count).toBe(0);
    } finally {
      await failing.close();
    }
  });

  it('本体概念不存在时拒绝注册并指出该引用', async () => {
    const failing = await createHarness({
      label: 'm23-missing-concept',
      conceptValidator: {
        async validate() {
          return {
            ok: false,
            reason: 'concept reference does not exist: demo:Quantity',
            field_path: 'payload',
          };
        },
      },
    });
    try {
      const otherToken = await failing.token({ permissions: ALL_PERMISSIONS });
      const response = await failing.request({
        method: 'POST',
        path: '/assets',
        token: otherToken,
        idempotencyKey: 'm23-missing-concept',
        json: conceptSkill('m23-missing-concept'),
      });
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('CONTRACT_INVALID');
      expect(response.body.details[0].reason).toContain('demo:Quantity');
    } finally {
      await failing.close();
    }
  });

  it('本体服务不可达时返回 ONTO_UNAVAILABLE，而不是伪装成校验通过', async () => {
    const failing = await createHarness({
      label: 'm23-onto-down',
      conceptValidator: {
        async validate() {
          throw apiError('ONTO_UNAVAILABLE', 'ontology service is unreachable');
        },
      },
    });
    try {
      const otherToken = await failing.token({ permissions: ALL_PERMISSIONS });
      const response = await failing.request({
        method: 'POST',
        path: '/assets',
        token: otherToken,
        idempotencyKey: 'm23-onto-down',
        json: conceptSkill('m23-onto-down'),
      });
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('ONTO_UNAVAILABLE');

      const { rows } = await failing.pool.query(
        'SELECT count(*)::int AS count FROM asset_revision WHERE scope_id = $1',
        [failing.projectId],
      );
      expect(rows[0].count).toBe(0);
    } finally {
      await failing.close();
    }
  });

  it('没有概念引用的字符串契约不需要本体校验即可注册', async () => {
    const before = validatedRefs.length;
    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm23-string-only',
      json: registerSkillRequest({
        slug: 'm23-string-only',
        payload: skillPayload({
          input_contract: [
            {
              name: 'query',
              concept_ref: null,
              data_type: 'STRING',
              unit_ref: null,
              ontology_version: null,
              vocabulary_version: null,
              required: true,
            },
          ],
        }),
      }),
    });
    expect(response.status).toBe(201);
    expect(validatedRefs.length).toBe(before);

    // 详情要标明「未作概念语义验证」，不能让人误以为已经过本体校验。
    const detail = await harness.request({
      method: 'GET',
      path: `/assets/${response.body.data.asset_id}/versions/1.0.0`,
      token,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.data.payload.concept_validation).toBe('not_requested');
  });

  it('数值契约缺少概念引用时直接拒绝', async () => {
    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm23-numeric-missing-concept',
      json: registerSkillRequest({
        slug: 'm23-numeric-missing-concept',
        payload: skillPayload({
          input_contract: [
            {
              name: 'amount',
              concept_ref: null,
              data_type: 'NUMBER',
              unit_ref: null,
              ontology_version: null,
              vocabulary_version: null,
              required: true,
            },
          ],
          concept_validation: 'not_requested',
        }),
      }),
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('CONTRACT_INVALID');
    expect(response.body.details[0].field_path).toContain('concept_ref');
  });

  it('含概念引用却声明不校验时被拒绝', async () => {
    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm23-mismatched-mode',
      json: registerSkillRequest({
        slug: 'm23-mismatched-mode',
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
          concept_validation: 'not_requested',
        }),
      }),
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('CONTRACT_INVALID');
    expect(response.body.details[0].field_path).toContain('concept_validation');
  });

  it('只校验接口在本体不可达时不得报「校验通过」', async () => {
    const failing = await createHarness({
      label: 'm23-validate-onto-down',
      conceptValidator: {
        async validate() {
          throw apiError('ONTO_UNAVAILABLE', 'ontology service is unreachable');
        },
      },
    });
    try {
      const otherToken = await failing.token({ permissions: ALL_PERMISSIONS });
      const response = await failing.request({
        method: 'POST',
        path: '/assets/validate',
        token: otherToken,
        json: conceptSkill('m23-validate-onto-down'),
      });
      expect(response.status).toBe(200);
      expect(response.body.data.passed).toBe(false);
      expect(response.body.data.issues.length).toBeGreaterThan(0);
      expect(response.body.data.issues[0].reason).toContain('ONTO_UNAVAILABLE');
    } finally {
      await failing.close();
    }
  });
});
