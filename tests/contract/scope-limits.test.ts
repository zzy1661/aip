import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { knowledgeAuthorization, withTransaction } from '@aip/api';
import { createHarness, type Harness } from '../helpers/app.js';
import { ALL_PERMISSIONS, mintToken } from '../helpers/auth.js';
import { createReadyKnowledgeBase, uploadAndParse } from '../helpers/flow.js';

/**
 * M22：作用域与访问限制。
 *
 * 断言口径：令牌作用域必须与部署作用域一致；无令牌、过期令牌、错误签名的令牌
 * 一律 401；作用域不符、缺少权限、被本地拒绝一律 403；
 * 显式引用无权访问的知识按 404 处理（不泄露存在性），
 * 显式引用未审核或未就绪的知识返回 409 INDEX_NOT_READY；
 * 来源下载需要 source:read 且要有文档级下载授权。
 */
describe('M22 作用域与访问限制', () => {
  let harness: Harness;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness({ label: 'm22' });
    token = await harness.token({ permissions: ALL_PERMISSIONS });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('缺少令牌时返回 401', async () => {
    const response = await harness.request({ method: 'GET', path: '/assets' });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  it('过期令牌返回 401', async () => {
    const token = await harness.token({
      permissions: ALL_PERMISSIONS,
      expiresInSeconds: -60,
    });
    const response = await harness.request({ method: 'GET', path: '/assets', token });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  it('签名密钥不对的令牌返回 401', async () => {
    const token = await harness.token({
      permissions: ALL_PERMISSIONS,
      signedWith: 'aip-test-wrong-secret',
    });
    const response = await harness.request({ method: 'GET', path: '/assets', token });
    expect(response.status).toBe(401);
  });

  it('作用域与部署不一致时返回 403', async () => {
    const token = await mintToken({
      subject: 'user-1',
      scope: 'another-project',
      permissions: ALL_PERMISSIONS,
    });
    const response = await harness.request({ method: 'GET', path: '/assets', token });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('缺少所需权限时返回 403 并指明缺哪个权限', async () => {
    const token = await harness.token({ permissions: ['knowledge:read'] });
    const response = await harness.request({
      method: 'POST',
      path: '/assets',
      token,
      idempotencyKey: 'm22-no-permission',
      json: { type: 'Skill', slug: 'm22-skill', version: '1.0.0', payload: {} },
    });
    expect(response.status).toBe(403);
    expect(response.body.message).toContain('asset:write');
  });

  it('被本地拒绝的主体返回 403', async () => {
    const token = await harness.token({
      subject: 'user-denied',
      permissions: ALL_PERMISSIONS,
    });
    await harness.pool.query(
      `INSERT INTO local_deny (scope_id, subject) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [harness.projectId, 'user-denied'],
    );
    const response = await harness.request({ method: 'GET', path: '/assets', token });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('显式引用无权访问的知识按 404 处理，不泄露存在性', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M22 显式引用');
    const document = await uploadAndParse(harness, token, kbId, { marker: 'M22-REF' });
    const otherToken = await harness.token({
      subject: 'user-other',
      permissions: ALL_PERMISSIONS,
    });

    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token: otherToken,
      json: { query: 'M22-REF', kb_ids: [kbId], knowledge_refs: [document.knowledgeRef] },
    });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('显式引用不存在的知识同样按 404 处理', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M22 显式引用缺失');
    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: {
        query: 'M22-REF',
        kb_ids: [kbId],
        knowledge_refs: ['3f1b7f0e-1f2a-4a1e-9c3d-000000000000'],
      },
    });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('显式引用未审核通过的知识返回 409 INDEX_NOT_READY', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M22 未审核');
    const document = await uploadAndParse(harness, token, kbId, { marker: 'M22-PENDING' });

    const response = await harness.request({
      method: 'POST',
      path: '/retrieval',
      token,
      json: { query: 'M22-PENDING', kb_ids: [kbId], knowledge_refs: [document.knowledgeRef] },
    });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('INDEX_NOT_READY');
  });

  it('下载来源文件需要 source:read 与文档级下载授权', async () => {
    const { kbId } = await createReadyKnowledgeBase(harness, token, 'M22 下载');
    const document = await uploadAndParse(harness, token, kbId, { marker: 'M22-DL' });
    const path = `/sources/${document.sourceRef}/versions/${document.version}/download`;

    // 上传者有 source:read 且有文档级下载授权。
    const allowed = await harness.request({ method: 'GET', path, token });
    expect(allowed.status).toBe(200);

    // 没有 source:read 的主体拿不到。
    const noReadToken = await harness.token({ permissions: ['knowledge:read'] });
    const noRead = await harness.request({ method: 'GET', path, token: noReadToken });
    expect(noRead.status).toBe(403);

    // 有 source:read 但只有读取授权、没有下载授权的主体拿不到原文。
    await withTransaction(harness.pool, (client) =>
      knowledgeAuthorization.grantDocument(client, {
        scopeId: harness.projectId,
        knowledgeId: document.knowledgeRef,
        knowledgeVersion: document.version,
        subject: 'user-no-download',
        canRead: true,
        canDownload: false,
      }),
    );
    const noGrantToken = await harness.token({
      subject: 'user-no-download',
      permissions: ['source:read'],
    });
    const noGrant = await harness.request({ method: 'GET', path, token: noGrantToken });
    expect(noGrant.status).toBe(403);
    expect(noGrant.body.code).toBe('FORBIDDEN');

    // 完全没有读取授权的主体按 404 处理，不泄露该来源是否存在。
    const noReadGrantToken = await harness.token({
      subject: 'user-no-grant',
      permissions: ['source:read'],
    });
    const noReadGrant = await harness.request({
      method: 'GET',
      path,
      token: noReadGrantToken,
    });
    expect(noReadGrant.status).toBe(404);
  });
});
