#!/usr/bin/env node
/**
 * 空授权零上游请求的取证脚本（**只读**：不创建、不修改、不删除任何数据）。
 *
 * 它证明两件事，两边都要有：
 *
 * 1. **上游侧**：未授权主体发起检索时，RAGFlow **一次都没有**收到检索请求。
 *    计的是 RAGFlow 服务端自己的访问日志里 `"POST /api/v1/retrieval` 的行数
 *    ——这是**上游收到的请求数**，不是平台自己的说法。
 *
 *    计数必须只覆盖**本轮时间窗**（从脚本开始的日志行往后数），
 *    不能拿全局累计行数相减：别的任务同时打上游会让累计数乱跳。
 *
 * 2. **后端侧**：未授权主体在真实接口上确实拿不到那个文档（404）。
 *
 * 为什么要有正向对照
 * ------------------
 *
 * 早先这里的 grep 模式写成 `'" /api/v1/'`（引号后带一个空格），而真实
 * werkzeug 日志是 `"POST /api/v1/retrieval`——**永远 0 匹配**。
 * 于是"上游一次都没被调用"这条断言恒真，看起来绿，其实什么都没测。
 *
 * 所以这个脚本先做一次**有权**检索（它真的会打上游），断言计数**涨了**；
 * 再做一次**空授权**检索，断言计数**没涨**。
 * 前者是反向对照：把计数换成那个坏模式，这一步立刻失败，恒真被堵死。
 *
 * 用法
 * ----
 *
 *   # 需要真实栈在跑（真实 aip API + 真实 RAGFlow）
 *   AIP_REAL_TARGET=http://127.0.0.1:18092 \
 *   AUTH_HS256_SECRET=... OIDC_ISSUER=... OIDC_AUDIENCE=... \
 *   node tools/zero-request-evidence.mjs
 *
 * 环境变量：
 *   - `AIP_REAL_TARGET`   真实 aip API 根地址（默认 `http://127.0.0.1:18092`）
 *   - `AIP_REAL_PROJECT`  项目作用域（默认 `zach20-real`）
 *   - `AIP_RAGFLOW_CONTAINER` RAGFlow 容器名（默认 `aip-ragflow-ragflow-1`）
 *   - `AUTH_HS256_SECRET` / `OIDC_ISSUER` / `OIDC_AUDIENCE`  签发参数（必填）
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const API = process.env.AIP_REAL_TARGET ?? 'http://127.0.0.1:18092';
const PROJECT = process.env.AIP_REAL_PROJECT ?? 'zach20-real';
const CONTAINER = process.env.AIP_RAGFLOW_CONTAINER ?? 'aip-ragflow-ragflow-1';
const LOG_PATH = process.env.AIP_RAGFLOW_LOG ?? '/ragflow/logs/ragflow_server.log';

/**
 * 检索请求的日志模式。
 *
 * 必须是 `"POST /api/v1/retrieval`（引号紧跟 POST）。
 * 早先的 `'" /api/v1/'` 永远 0 匹配，让整条断言恒真。
 * 也不用全量 `/api/v1/`：那会把 datasets/documents/chunks 的几千行噪声算进来。
 */
const RETRIEVAL_PATTERN = '"POST /api/v1/retrieval';

const ALL_PERMISSIONS = [
  'asset:read',
  'asset:write',
  'asset:manage',
  'asset:bind',
  'knowledge:read',
  'knowledge:write',
  'knowledge:review',
  'knowledge:manage',
  'source:read',
  'operations:read',
];

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 未设置：必须用真实部署的签名参数签发令牌`);
  return value;
}

/** 数上游日志里检索请求的行数；`fromLine` 起算，只覆盖本轮时间窗。 */
async function countUpstreamRetrievals(fromLine) {
  const tail = fromLine > 0 ? `tail -n +${fromLine + 1}` : 'cat';
  const { stdout } = await run('docker', [
    'exec', CONTAINER, 'sh', '-c',
    `${tail} ${LOG_PATH} | grep -c '${RETRIEVAL_PATTERN}' || true`,
  ]);
  return Number.parseInt(stdout.trim(), 10) || 0;
}

/** 上游日志的总行数（用来切出本轮时间窗）。 */
async function upstreamLogLineCount() {
  const { stdout } = await run('docker', [
    'exec', CONTAINER, 'sh', '-c', `wc -l < ${LOG_PATH} || true`,
  ]);
  return Number.parseInt(stdout.trim(), 10) || 0;
}

async function mint(subject) {
  const { SignJWT } = await import('jose');
  return new SignJWT({ scope: PROJECT, permissions: ALL_PERMISSIONS })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(requiredEnv('OIDC_ISSUER'))
    .setAudience(requiredEnv('OIDC_AUDIENCE'))
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode(requiredEnv('AUTH_HS256_SECRET')));
}

async function api(path, { token, method = 'GET', body } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${API}/api/v1/projects/${PROJECT}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

/**
 * 候选主体：真实层里上传并审核过文档的那些主体。
 *
 * 文档的读取权是**按主体授予**的（上传者自动获得该版本的读与下载权），
 * 所以只有上传者的令牌看得到那个文档。这里按候选列表逐个试，
 * 找到第一个看得到已审核、已就绪文档的主体。
 */
const CANDIDATE_OWNERS = (process.env.AIP_EVIDENCE_OWNERS ??
  'zach20-real-reader,zach20-real-writer,zach20-evidence-owner').split(',');

/** 找一个真实存在、已审核通过、已就绪的知识版本。 */
async function findApprovedReadyDocument(token) {
  const bases = await api('/knowledge-bases', { token });
  for (const kb of bases.body?.data ?? []) {
    const docs = await api(`/knowledge-bases/${kb.kb_id}/documents`, { token });
    const hit = (docs.body?.data ?? []).find(
      (d) => d.review_status === 'approved' && d.status === 'ready',
    );
    if (hit) return { kb, hit };
  }
  return null;
}

let owner = null;
let target = null;
for (const candidate of CANDIDATE_OWNERS) {
  const token = await mint(candidate.trim());
  const found = await findApprovedReadyDocument(token);
  if (found) {
    owner = token;
    target = found;
    break;
  }
}
if (!target) {
  console.log(
    JSON.stringify(
      {
        error: 'NO_APPROVED_READY_DOC',
        hint: '先跑一轮真实层（造出已审核、已就绪的文档），或用 AIP_EVIDENCE_OWNERS 指定上传者主体',
        candidates: CANDIDATE_OWNERS,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}
const { kb, hit } = target;
const reader = await mint('zach20-evidence-unauthorized');

// 本轮时间窗：从这里开始数。
const windowStart = await upstreamLogLineCount();

// ---- 正向对照：有权主体检索，上游**必须**收到请求 ----
const authorized = await api('/retrieval', {
  token: owner,
  method: 'POST',
  body: { query: '零上游请求取证', kb_ids: [kb.kb_id], top_n: 20 },
});
const afterAuthorized = await countUpstreamRetrievals(windowStart);

// ---- 空授权主体检索：上游**不得**再收到请求 ----
const unauthorized = await api('/retrieval', {
  token: reader,
  method: 'POST',
  body: { query: '零上游请求取证', kb_ids: [kb.kb_id], top_n: 20 },
});
const afterUnauthorized = await countUpstreamRetrievals(windowStart);

// 后端拒绝证据：未授权主体读不到那个文档。
const denied = await api(`/knowledge/${hit.knowledge_id}/versions/${hit.version}`, { token: reader });

const report = {
  knowledge_id: hit.knowledge_id,
  version: hit.version,
  kb_id: kb.kb_id,
  authorized_retrieval_status: authorized.status,
  authorized_evidence_count: (authorized.body?.data?.evidence ?? []).length,
  unauthorized_retrieval_status: unauthorized.status,
  unauthorized_retrieval_data_status: unauthorized.body?.data?.status ?? null,
  unauthorized_evidence_count: (unauthorized.body?.data?.evidence ?? []).length,
  upstream_retrieval_count_after_authorized: afterAuthorized,
  upstream_retrieval_count_after_unauthorized: afterUnauthorized,
  upstream_retrieval_delta_for_unauthorized: afterUnauthorized - afterAuthorized,
  backend_denied_status: denied.status,
  backend_denied_code: denied.body?.code ?? null,
};

// 判定：正向对照必须涨（否则计数器本身有问题，断言是恒真的）；
// 空授权那一次不得再涨。
const positiveControlOk = afterAuthorized > 0;
const unauthorizedDidNotCallUpstream = afterUnauthorized === afterAuthorized;

console.log(JSON.stringify({ ...report, positive_control_ok: positiveControlOk, unauthorized_did_not_call_upstream: unauthorizedDidNotCallUpstream }, null, 2));

if (!positiveControlOk || !unauthorizedDidNotCallUpstream) {
  process.exit(1);
}
