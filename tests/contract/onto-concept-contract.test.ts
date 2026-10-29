import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CONCEPT_QUERY_CONTRACT_VERSION,
  CONCEPT_TYPE_COMPATIBILITY,
  createOntoConceptValidator,
  type ConceptReference,
} from '@aip/api';
import { ApiError } from '@aip/api';
import { createHarness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import { registerSkillRequest, skillPayload } from '../helpers/fixtures.js';

/**
 * 概念查询契约的契约门（ZACH-30）。
 *
 * onto 是提供方，aip 是调用方。这一节用**两仓共享的同一份夹具**驱动 aip 的客户端，
 * 断言两件事：
 *
 *   1. aip 按冻结契约解释 onto 的回答：成功的回答通过，失败的引用被拒并指出引用；
 *   2. **能证伪**：夹具里的字段被改名或改值时，aip 侧必须变红。
 *
 * onto 那一边跑的是同一份夹具（`onto` 仓的 `server/src/verify.ts` 第 35 节），
 * 所以任何一侧单方面改动契约，两个仓库里各有一盏红灯。
 */

const FIXTURE_PATH = fileURLToPath(
  new URL('../fixtures/onto-concept-query.v1.json', import.meta.url),
);
const CONTRACT_DOC_PATH = fileURLToPath(
  new URL('../../docs/ontology-concept-query-contract.md', import.meta.url),
);

/** 契约文档与共享夹具的 sha256：改动它们必须同时改两仓。 */
const CONTRACT_DOC_SHA256 = '5cb3332fe350be409ee1428713138d8c8674727e8dbc90f92a887817809da5c2';
const FIXTURE_SHA256 = 'e0fc5a6caec5e36b8f506e7b4c0160d7394f0d47b27e9d0e89d9db431b0772d0';

interface Fixture {
  contract_version: string;
  vocabulary_version: string;
  request: { method: string; path_template: string; query_params: string[] };
  type_compatibility: Record<string, string[]>;
  success_case: {
    concept_ref: string;
    query: Record<string, string>;
    response: Record<string, unknown>;
    aip_expectation: {
      outcome: string;
      declared_data_type: string;
      declared_unit_ref: string;
      declared_ontology_version: string;
      declared_vocabulary_version: string;
    };
  };
  error_cases: Array<{
    name: string;
    concept_ref: string;
    query: Record<string, string>;
    error: { http_status: number; error_code: string };
    aip_expectation: { outcome: string; http_status: number; error_code: string };
  }>;
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** A fetch that answers with a fixed body, and remembers what it was asked. */
function fakeFetch(
  body: unknown,
  status = 200,
): { fetchImpl: typeof fetch; calls: URL[] } {
  const calls: URL[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(new URL(String(input)));
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** The reference the fixture's success case describes. */
function successReference(): ConceptReference {
  return {
    concept_ref: fixture.success_case.concept_ref,
    data_type: fixture.success_case.aip_expectation.declared_data_type as ConceptReference['data_type'],
    unit_ref: fixture.success_case.aip_expectation.declared_unit_ref,
    ontology_version: fixture.success_case.aip_expectation.declared_ontology_version,
    vocabulary_version: fixture.success_case.aip_expectation.declared_vocabulary_version,
  };
}

describe('契约产物是钉死的', () => {
  it('共享夹具的 sha256 与记录一致', () => {
    expect(sha256Of(FIXTURE_PATH)).toBe(FIXTURE_SHA256);
  });

  it('契约文档的 sha256 与记录一致', () => {
    expect(sha256Of(CONTRACT_DOC_PATH)).toBe(CONTRACT_DOC_SHA256);
  });

  it('契约文档写明了夹具的 sha256，两份产物对得上', () => {
    const doc = readFileSync(CONTRACT_DOC_PATH, 'utf8');
    expect(doc).toContain(FIXTURE_SHA256);
    expect(doc).toContain(fixture.contract_version);
  });

  it('实现的类型兼容表与夹具一致', () => {
    expect(CONCEPT_TYPE_COMPATIBILITY).toEqual(fixture.type_compatibility);
  });

  it('实现的契约版本与夹具一致', () => {
    expect(CONCEPT_QUERY_CONTRACT_VERSION).toBe(fixture.contract_version);
  });
});

describe('aip 按冻结契约发起查询', () => {
  it('请求的路径与方法与夹具一致', async () => {
    const { fetchImpl, calls } = fakeFetch(fixture.success_case.response);
    const validator = createOntoConceptValidator({
      baseUrl: 'http://onto.test',
      audience: null,
      fetchImpl,
    });
    await validator.validate([successReference()]);
    expect(calls).toHaveLength(1);
    const url = calls[0]!;
    expect(url.pathname).toBe(
      fixture.request.path_template.replace(
        '{concept_ref}',
        encodeURIComponent(fixture.success_case.concept_ref),
      ),
    );
    expect(url.searchParams.get('ontology_version')).toBe(
      fixture.success_case.query.ontology_version,
    );
    expect(url.searchParams.get('vocabulary_version')).toBe(
      fixture.success_case.query.vocabulary_version,
    );
    expect(url.searchParams.get('unit_ref')).toBe(fixture.success_case.query.unit_ref);
  });
});

describe('aip 解释 onto 的成功回答', () => {
  it('契约里的成功用例通过', async () => {
    const { fetchImpl } = fakeFetch(fixture.success_case.response);
    const validator = createOntoConceptValidator({
      baseUrl: 'http://onto.test',
      audience: null,
      fetchImpl,
    });
    const outcome = await validator.validate([successReference()]);
    expect(outcome).toEqual({ ok: true });
  });
});

describe('aip 解释 onto 的失败回答', () => {
  it.each(fixture.error_cases.map((c) => [c.name, c] as const))(
    '%s 被拒绝，并指出该引用',
    async (_name, c) => {
      const { fetchImpl } = fakeFetch(
        {
          code: c.error.http_status,
          message: `fixture: ${c.name}`,
          result: null,
          error_code: c.error.error_code,
        },
        c.error.http_status,
      );
      const validator = createOntoConceptValidator({
        baseUrl: 'http://onto.test',
        audience: null,
        fetchImpl,
      });
      const outcome = await validator.validate([
        {
          concept_ref: c.concept_ref,
          data_type: 'NUMBER',
          unit_ref: null,
          ontology_version: null,
          vocabulary_version: null,
        },
      ]);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('应当被拒绝');
      expect(outcome.reason).toContain(c.concept_ref);
      expect(outcome.reason).toContain(c.error.error_code);
      expect(outcome.concept_ref).toBe(c.concept_ref);
      // 契约规定：这些失败都是「引用不成立」，由注册链路映射成 422。
      expect(c.aip_expectation.http_status).toBe(422);
      expect(c.aip_expectation.error_code).toBe('CONTRACT_INVALID');
    },
  );

  it('凭据被拒与上游故障是 503，不是「校验通过」', async () => {
    for (const status of [401, 403, 500, 503]) {
      const { fetchImpl } = fakeFetch({ code: status, message: 'nope', result: null }, status);
      const validator = createOntoConceptValidator({
        baseUrl: 'http://onto.test',
        audience: null,
        fetchImpl,
      });
      await expect(validator.validate([successReference()])).rejects.toBeInstanceOf(ApiError);
    }
  });

  it('本体服务不可达时抛 ONTO_UNAVAILABLE，而不是伪装成校验通过', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const validator = createOntoConceptValidator({
      baseUrl: 'http://onto.test',
      audience: null,
      fetchImpl,
    });
    await expect(validator.validate([successReference()])).rejects.toMatchObject({
      code: 'ONTO_UNAVAILABLE',
    });
  });
});

describe('能证伪：夹具改了，aip 侧必须变红', () => {
  /** A deep copy of the success response, so each case can break one field. */
  function responseWith(change: (r: Record<string, any>) => void): Record<string, unknown> {
    const copy = JSON.parse(JSON.stringify(fixture.success_case.response));
    change(copy.result);
    return copy;
  }

  const breaks: Array<[string, (r: Record<string, any>) => void]> = [
    ['契约版本标识被改', (r) => {
      r.contract_version = 'onto-concept-query/v2';
    }],
    ['概念字段被改名', (r) => {
      r.concept.datatype = r.concept.data_type;
      delete r.concept.data_type;
    }],
    ['本体字段被改名', (r) => {
      r.ontology.ontologyCode = r.ontology.code;
      delete r.ontology.code;
    }],
    ['单位字段被改名', (r) => {
      r.unit.symbol = r.unit.unit;
      delete r.unit.unit;
    }],
    ['版本号被改名', (r) => {
      r.ontology.snapshotVersion = r.ontology.version;
      delete r.ontology.version;
    }],
    ['是否已发布被改名', (r) => {
      r.ontology.isPublished = r.ontology.published;
      delete r.ontology.published;
    }],
  ];

  it.each(breaks)('%s：不得判为通过', async (_name, change) => {
    const { fetchImpl } = fakeFetch(responseWith(change));
    const validator = createOntoConceptValidator({
      baseUrl: 'http://onto.test',
      audience: null,
      fetchImpl,
    });
    let passed = false;
    try {
      const outcome = await validator.validate([successReference()]);
      passed = outcome.ok;
    } catch (e) {
      // 契约不符按服务故障处理（ONTO_UNAVAILABLE），同样不是「通过」。
      expect((e as ApiError).code).toBe('ONTO_UNAVAILABLE');
    }
    expect(passed).toBe(false);
  });

  it('类型的取值变了：不得判为通过', async () => {
    const { fetchImpl } = fakeFetch(
      responseWith((r) => {
        r.concept.data_type = 'STRING';
      }),
    );
    const validator = createOntoConceptValidator({
      baseUrl: 'http://onto.test',
      audience: null,
      fetchImpl,
    });
    const outcome = await validator.validate([successReference()]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('应当被拒绝');
    expect(outcome.reason).toContain('NUMBER');
  });

  it('本体版本被顶替了：不得判为通过', async () => {
    const { fetchImpl } = fakeFetch(
      responseWith((r) => {
        r.ontology.version = 2;
      }),
    );
    const validator = createOntoConceptValidator({
      baseUrl: 'http://onto.test',
      audience: null,
      fetchImpl,
    });
    const outcome = await validator.validate([successReference()]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('应当被拒绝');
    expect(outcome.reason).toContain('1');
  });

  it('本体未发布：不得判为通过', async () => {
    const { fetchImpl } = fakeFetch(
      responseWith((r) => {
        r.ontology.published = false;
      }),
    );
    const validator = createOntoConceptValidator({
      baseUrl: 'http://onto.test',
      audience: null,
      fetchImpl,
    });
    const outcome = await validator.validate([successReference()]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('应当被拒绝');
    expect(outcome.reason).toContain('not published');
  });
});

describe('注册链路按契约解释失败', () => {
  it('概念不存在 → 422，字段路径指到真正出问题的那一项', async () => {
    const conceptRef = 'demo:nosuchproperty';
    const { fetchImpl } = fakeFetch(
      {
        code: 404,
        message: '概念不存在: demo:nosuchproperty',
        result: null,
        error_code: 'CONCEPT_NOT_FOUND',
      },
      404,
    );
    const harness = await createHarness({
      label: 'zach30-contract',
      conceptValidator: createOntoConceptValidator({
        baseUrl: 'http://onto.test',
        audience: null,
        fetchImpl,
      }),
    });
    try {
      const token = await harness.token({ permissions: ALL_PERMISSIONS });
      const response = await harness.request({
        method: 'POST',
        path: '/assets',
        token,
        idempotencyKey: 'zach30-contract-missing',
        json: registerSkillRequest({
          slug: 'zach30-contract-missing',
          payload: skillPayload({
            input_contract: [
              {
                name: 'amount',
                concept_ref: conceptRef,
                data_type: 'NUMBER',
                unit_ref: 'mm',
                ontology_version: '1',
                vocabulary_version: 'onto-units-v1',
                required: true,
              },
            ],
            concept_validation: 'validated',
          }),
        }),
      });
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('CONTRACT_INVALID');
      expect(response.body.details[0].field_path).toBe('payload.input_contract[0].concept_ref');
      expect(response.body.details[0].reason).toContain(conceptRef);
      expect(response.body.details[0].reason).toContain('CONCEPT_NOT_FOUND');
    } finally {
      await harness.close();
    }
  });
});
