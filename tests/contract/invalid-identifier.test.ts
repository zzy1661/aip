import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS } from '../helpers/auth.js';

/**
 * M-5：非法 UUID 入参必须返回规范 4xx，不得退化成数据库层的 500。
 *
 * 这些标识符最终会进入 uuid 列或 uuid[] 强制转换；
 * 边界不拦截时 PostgreSQL 抛 22P02，调用方看到的是 INTERNAL_ERROR。
 */
describe('M-5 非法标识符入参', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm5' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  it.each([
    ['GET', '/knowledge-bases/not-a-uuid'],
    ['GET', '/knowledge/not-a-uuid/versions/1.0.0'],
    ['GET', '/evidence/not-a-uuid'],
    ['GET', '/operations/not-a-uuid'],
    ['GET', '/sources/not-a-uuid/versions/1.0.0/download'],
    ['GET', '/assets/not-a-uuid/versions/1.0.0'],
    ['GET', '/knowledge-bases/not-a-uuid/documents'],
  ])('%s %s 返回 400 而不是 500', async (method, path) => {
    const response = await harness.request({ method, path, token });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('BAD_REQUEST');
  });

  it('POST /retrieval 的非法 kb_ids 返回 422 而不是 500', async () => {
    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: '任意查询', kb_ids: ['not-a-uuid'] },
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('CONTRACT_INVALID');
  });

  it('POST /retrieval 的非法 knowledge_refs 返回 422 而不是 500', async () => {
    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: {
        query: '任意查询',
        kb_ids: ['0f7c1c34-9a52-4f8b-9a1d-2b6c4e5f7a81'],
        knowledge_refs: ['not-a-uuid'],
      },
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('CONTRACT_INVALID');
  });

  it('格式合法但不存在的 uuid 仍按资源缺失处理', async () => {
    const missing = '0f7c1c34-9a52-4f8b-9a1d-2b6c4e5f7a81';
    const kb = await harness.request({ method: 'GET', path: `/knowledge-bases/${missing}`, token });
    expect(kb.status).toBe(404);
    const knowledge = await harness.request({
      method: 'GET',
      path: `/knowledge/${missing}/versions/1.0.0`,
      token,
    });
    expect(knowledge.status).toBe(404);
  });
});
