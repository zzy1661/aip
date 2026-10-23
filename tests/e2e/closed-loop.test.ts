import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';
import {
  createReadyKnowledgeBase,
  prepareApprovedDocument,
  seedRetrievalChunk,
} from '../helpers/flow.js';

/**
 * M26（模拟上游）：端到端最小闭环。
 *
 * 流程：注册 Skill -> 注册 Agent 并绑定该 Skill 版本 -> 建知识库 -> 上传 -> 解析 ->
 * 审核 -> 检索拿到带来源引用的证据。
 *
 * 说明：RAGFlow 上游是替身，因此这是「接口与状态机闭环」的证据，
 * 真实上游闭环由 tests/real/ 单独验证，两者分开报告。
 */
describe('M26 最小闭环（模拟上游）', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm26' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('注册 Skill、绑定 Agent、审核知识后可以检索到带来源的证据', async () => {
    // 1. 注册 Skill（内联 Markdown + 字符串契约，无概念引用）。
    const skill = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm26-skill',
      json: {
        type: 'Skill',
        slug: 'm26-skill',
        version: '1.0.0',
        title: 'M26 技能',
        description: '闭环用技能',
        payload: {
          content: { kind: 'inline_markdown', body: '# M26 技能\n\n用于闭环验证。\n' },
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
          output_contract: [
            {
              name: 'answer',
              concept_ref: null,
              data_type: 'STRING',
              unit_ref: null,
              ontology_version: null,
              vocabulary_version: null,
              required: true,
            },
          ],
          concept_validation: 'not_requested',
          tags: ['m26'],
        },
      },
    });
    expect(skill.status).toBe(201);
    const skillId = skill.body.data.asset_id as string;
    expect(skill.body.data.version).toBe('1.0.0');

    // 2. 注册 Agent，并绑定到具体的 Skill 版本。
    const agent = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm26-agent',
      json: {
        type: 'Agent',
        slug: 'm26-agent',
        version: '1.0.0',
        title: 'M26 智能体',
        description: '闭环用智能体',
        payload: {
          instructions: '回答用户问题。',
          skill_refs: [{ asset_id: skillId, version: '1.0.0' }],
          model_profile_ref: 'default-profile',
          requested_permissions: ['asset:read', 'knowledge:read'],
          config: { temperature: 0 },
          execution_enabled: false,
        },
      },
    });
    expect(agent.status).toBe(201);
    const agentId = agent.body.data.asset_id as string;

    const agentDetail = await harness.request({
      method: 'GET',
      path: `/assets/${agentId}/versions/1.0.0`,
      token,
    });
    expect(agentDetail.status).toBe(200);
    expect(agentDetail.body.data.bindings).toHaveLength(1);
    expect(agentDetail.body.data.bindings[0].skill_id).toBe(skillId);
    expect(agentDetail.body.data.bindings[0].skill_version).toBe('1.0.0');
    expect(agentDetail.body.data.bindings[0].binding_valid).toBe(true);

    // 3. 建知识库、上传、解析、审核。
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M26 知识库');
    const document = await prepareApprovedDocument(harness, token, kbId, { marker: 'M26-LOOP' });

    // 4. 检索并拿到带来源引用的证据。
    seedRetrievalChunk(harness, {
      documentId: document.documentId,
      datasetId: document.datasetId,
      content: 'M26-LOOP',
    });

    const retrieval = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M26-LOOP', kb_ids: [kbId] },
    });
    expect(retrieval.status).toBe(200);
    expect(retrieval.body.data.status).toBe('authorized_evidence');
    const evidence = retrieval.body.data.evidence as any[];
    expect(evidence).toHaveLength(1);
    expect(evidence[0].knowledge_ref).toBe(document.knowledgeRef);
    expect(evidence[0].source_locator.source_file_id).toBe(document.sourceRef);
    expect(evidence[0].source_locator.source_file_version).toBe(document.version);
  });

  it('Agent 绑定到不存在的 Skill 版本时被拒绝', async () => {
    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm26-agent-bad-binding',
      json: {
        type: 'Agent',
        slug: 'm26-agent-bad-binding',
        version: '1.0.0',
        title: 'M26 无效绑定',
        description: '绑定不存在的技能版本',
        payload: {
          instructions: '无效绑定',
          skill_refs: [{ asset_id: '3f1b7f0e-1f2a-4a1e-9c3d-000000000000', version: '9.9.9' }],
          model_profile_ref: 'default-profile',
          requested_permissions: [],
          config: {},
          execution_enabled: false,
        },
      },
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('REF_NOT_AVAILABLE');
  });

  it('Agent 绑定的 Skill 标识格式非法时被拒绝而不是落到数据库错误', async () => {
    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm26-agent-malformed-binding',
      json: {
        type: 'Agent',
        slug: 'm26-agent-malformed-binding',
        version: '1.0.0',
        title: 'M26 非法标识',
        description: '绑定标识格式非法',
        payload: {
          instructions: '非法标识',
          skill_refs: [{ asset_id: 'not-a-uuid', version: '1.0.0' }],
          model_profile_ref: 'default-profile',
          requested_permissions: [],
          config: {},
          execution_enabled: false,
        },
      },
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('CONTRACT_INVALID');
  });
});
