import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createOntoConceptValidator } from '@aip/api';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { registerSkillRequest, skillPayload, uniqueSlug } from '../helpers/fixtures.js';

/**
 * 真实本体联调（ZACH-30）。
 *
 * 这一层打的是**真的 onto**，不是替身：概念校验门的两条证据都在这里取，
 *
 *   ① 概念存在且已发布 → 注册通过（正向一侧，本轮之前拿不到的那条证据）；
 *   ② 概念不存在 → 422，且精确指出是哪个引用。
 *
 * 口径与 RAGFlow 的真实层一致：
 *   - 没有 `RUN_REAL_ONTO=1` 时整层跳过（退出码 0）；
 *   - 设了 `RUN_REAL_ONTO=1` 但配置不齐时**必须失败**，绝不把「没跑」记成「跑通」。
 *
 * 需要的环境：
 *   - `ONTO_BASE_URL`：真实 onto 的地址；
 *   - `ONTO_REAL_CONCEPT_REF`：真实存在的已发布概念，默认取夹具里的 `demo:amount`；
 *   - `ONTO_REAL_MISSING_CONCEPT_REF`：一定不存在的概念，默认 `demo:__no_such_concept__`；
 *   - aip 的测试库（`AIP_TEST_DATABASE_URL`，默认本机一次性测试容器）。
 *
 * onto 侧的数据用 `onto` 仓的 `scripts/seed-concept-demo.mjs` 按共享夹具种出来。
 */

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/onto-concept-query.v1.json', import.meta.url)), 'utf8'),
) as { success_case: { concept_ref: string } };

const enabled = process.env.RUN_REAL_ONTO === '1';
const baseUrl = process.env.ONTO_BASE_URL ?? '';
const conceptRef = process.env.ONTO_REAL_CONCEPT_REF ?? FIXTURE.success_case.concept_ref;
const missingConceptRef = process.env.ONTO_REAL_MISSING_CONCEPT_REF ?? 'demo:nosuchproperty';

function skillWithConcept(concept: string, slug: string) {
  return registerSkillRequest({
    slug,
    payload: skillPayload({
      input_contract: [
        {
          name: 'amount',
          concept_ref: concept,
          data_type: 'NUMBER',
          unit_ref: 'mm',
          ontology_version: '1',
          vocabulary_version: 'onto-units-v1',
          required: true,
        },
      ],
      concept_validation: 'validated',
    }),
  });
}

describe.skipIf(!enabled)('真实本体联调：概念校验门', () => {
  let harness: Harness;
  let token: string;

  it('配置不齐时必须失败，而不是跳过', () => {
    if (!baseUrl) {
      throw new Error('RUN_REAL_ONTO=1 需要 ONTO_BASE_URL：没有真实 onto 就无法取证');
    }
  });

  it('概念存在且已发布 → 注册通过（正向证据）', async () => {
    harness = await createHarness({
      label: 'zach30-positive',
      conceptValidator: createOntoConceptValidator({ baseUrl, audience: null }),
    });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'zach30-positive',
      json: skillWithConcept(conceptRef, uniqueSlug('zach30-ok')),
    });
    expect(response.status).toBe(201);
    // 注册响应是摘要，载荷在详情里；断言落在真正被写进去的那一份上。
    const detail = await harness.request({
      method: 'GET',
      path: `/assets/${response.body.data.asset_id}/versions/1.0.0`,
      token,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.data.payload.input_contract[0].concept_ref).toBe(conceptRef);
    expect(detail.body.data.payload.concept_validation).toBe('validated');
  });

  it('概念不存在 → 422，并精确指出该引用', async () => {
    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'zach30-missing',
      json: skillWithConcept(missingConceptRef, uniqueSlug('zach30-missing')),
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('CONTRACT_INVALID');
    expect(response.body.details[0].reason).toContain(missingConceptRef);
    // 字段路径要指到真正出问题的那一项，而不是笼统的 payload。
    expect(response.body.details[0].field_path).toContain('concept_ref');
  });

  it('本体服务不可达时返回 ONTO_UNAVAILABLE，而不是伪装成校验通过', async () => {
    const unreachable = await createHarness({
      label: 'zach30-unreachable',
      conceptValidator: createOntoConceptValidator({
        baseUrl: 'http://127.0.0.1:1',
        audience: null,
      }),
    });
    try {
      const otherToken = await unreachable.token({ permissions: ALL_PERMISSIONS });
      const response = await unreachable.request({
        method: 'POST',
        path: '/assets',
        token: otherToken,
        idempotencyKey: 'zach30-unreachable',
        json: skillWithConcept(conceptRef, uniqueSlug('zach30-unreachable')),
      });
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('ONTO_UNAVAILABLE');
    } finally {
      await unreachable.close();
    }
  });
});
