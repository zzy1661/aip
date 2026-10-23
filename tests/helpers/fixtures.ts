import { randomUUID } from 'node:crypto';
import type { AgentPayload, SkillPayload } from '@aip/contracts';

export function uniqueSuffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

export function uniqueSlug(prefix = 'skill'): string {
  return `${prefix}-${uniqueSuffix()}`;
}

export function sampleMarkdown(marker?: string): string {
  const id = marker ?? `AIP-SAMPLE-${uniqueSuffix()}`;
  return [
    `# 知识样本 ${id}`,
    '',
    `标记：${id}`,
    '',
    '本文件用于验证知识库的解析、审核与引用闭环。',
    `唯一标记是 ${id}，断言必须命中该标记。`,
    '',
  ].join('\n');
}

export function sampleText(marker?: string): string {
  const id = marker ?? `AIP-SAMPLE-${uniqueSuffix()}`;
  return `文本样本 ${id}\n唯一标记是 ${id}。\n`;
}

export function skillPayload(overrides: Partial<SkillPayload> = {}): SkillPayload {
  return {
    content: {
      kind: 'inline_markdown',
      body: '# 技能说明\n\n这是一个用于测试的技能。\n',
    },
    input_contract: [],
    output_contract: [],
    concept_validation: 'not_requested',
    tags: ['test'],
    ...overrides,
  };
}

export function agentPayload(overrides: Partial<AgentPayload> = {}): AgentPayload {
  return {
    instructions: '这是一个用于测试的 Agent。',
    skill_refs: [],
    model_profile_ref: 'default-model-profile',
    requested_permissions: [],
    config: {},
    execution_enabled: false,
    ...overrides,
  };
}

export function registerSkillRequest(
  overrides: Partial<{
    slug: string;
    version: string;
    title: string;
    description: string;
    payload: SkillPayload;
  }> = {},
): Record<string, unknown> {
  return {
    type: 'Skill',
    slug: overrides.slug ?? uniqueSlug('skill'),
    version: overrides.version ?? '1.0.0',
    title: overrides.title ?? '测试技能',
    description: overrides.description ?? '用于自动化测试的技能',
    payload: overrides.payload ?? skillPayload(),
  };
}

export function registerAgentRequest(
  overrides: Partial<{
    slug: string;
    version: string;
    title: string;
    description: string;
    payload: AgentPayload;
  }> = {},
): Record<string, unknown> {
  return {
    type: 'Agent',
    slug: overrides.slug ?? uniqueSlug('agent'),
    version: overrides.version ?? '1.0.0',
    title: overrides.title ?? '测试 Agent',
    description: overrides.description ?? '用于自动化测试的 Agent',
    payload: overrides.payload ?? agentPayload(),
  };
}

/** 通用适用条件（无条件适用）。 */
export const UNCONDITIONAL_APPLIES_TO = { mode: 'unconditional' as const };

/** 条件适用：只有上下文里 region=cn 时才适用。 */
export function conditionalAppliesTo(region = 'cn'): string {
  return JSON.stringify({ mode: 'conditional', conditions: { region } });
}
