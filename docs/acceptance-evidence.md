# 跨仓验收总表：判据 → 证据 → 复跑命令

> 这份文档回答一个问题：**某条门到底在哪个 SHA 上、由谁、什么时候跑绿的，证据在哪，复跑命令是什么。**
>
> 它是**跨仓**的总表（aip + onto），覆盖 ZACH-8 冻结矩阵的 M01–M28，
> 以及落在 onto 仓的页面门 M24 / M25 与真实组合验收层。
>
> 与 `docs/acceptance.md` 的分工：
>
> | 文档 | 回答什么 | 谁维护 |
> | --- | --- | --- |
> | `docs/acceptance.md`（aip 仓） | **判据是什么**：每条矩阵行的判据摘要、断言在哪个 `file:line`、缺陷 → 修复 → 回归 | aip |
> | 本文档（aip 仓） | **记录链**：证据在哪条路径、怎么复跑、上次谁在哪次运行跑绿的（SHA / `commit` / `dirty`）、CI 怎么跑这道门 | 本 issue（ZACH-28） |
>
> 两份文档互不替代：矩阵说「这条门由哪个断言守着」，本文说「那个断言上次真的跑绿了吗，凭什么这么认为」。

## 0. 口径与读法

### 0.1 结论口径（不重判矩阵）

本表的**状态列**直接采用 ZACH-15 第十轮（2026-10-27）定稿的口径，本 issue 不重判矩阵：

| 范围 | 定稿结论 |
| --- | --- |
| aip M01–M28 | FULL 23 / PARTIAL 3（M09、M14、M27）/ NOT RUN 2（M24、M25；UI 门证据在 onto `console/real/`） |
| 页面 M25 | 10/10 FULL（真实栈） |
| 页面 M24 | 除「加载态」外 FULL；加载态 PARTIAL（骨架屏断言只覆盖知识库列表，资产列表只断言空态） |
| M26/M27 真实层 | 真实层 27 passed / 3 skipped；`SCREENSHOTS=1` 时 30/0/0 |

状态取值：

- `FULL` —— 该判据的全部必需项都有**真实执行**的自动化断言支撑。
- `PARTIAL` —— 有断言覆盖，但仍有判据缺覆盖或只覆盖替代路径；缺口逐条写在 §4。
- `NOT RUN` —— 该门在**该仓**没有可执行对象，或缺少必需环境；**不以替身结果顶替**。

> M24 / M25 在 aip 仓记 `NOT RUN` 是因为 aip 仓没有前端代码、没有 Playwright、没有 `test:platform` 脚本。
> 这不是降级：这两条门的交付物在 onto 仓，其页面级结论由 onto 仓的真实栈给出（下表两栏并列，不互相覆盖）。

### 0.2 复跑者代号

| 代号 | 谁 | 说明 |
| --- | --- | --- |
| `ZACH-28` | 本 issue 的执行者（全栈开发专家 agent） | 2026-10-29 在分支 `feat/zach-28-acceptance-evidence-ci` 上本地复跑；命令与输出见 §2 |
| `ZACH-25` | 上期独立复核 run | 产出 `reports/8c487c7…/` 那批报告的独立复核。那批报告**没有**入仓（`reports/` 被 `.gitignore` 覆盖），本表与 `docs/acceptance.md` §4 只把它当历史基线引用；**本表的「最近复跑」列不指向它** |

### 0.3 SHA 的读法

表中 `SHA · commit · dirty` 三件套来自报告产物 `summary.json` 的同名字段：

- `commit` = **被测代码的 SHA**（证据归属于哪个 head）；
- `dirty` = 运行时**已跟踪文件**是否有改动（`true` 表示当时的结论不能直接归属到那个 commit）；
- `changed_tracked` / `untracked` = 脏在哪里（本次复跑两者均为空）。

`commit` 与报告目录名（`reports/<sha>/`）**双重绑定**：目录名对不上就不要采信报告。

## 1. 本轮复跑的两个 head

| 仓 | 分支 | head | 相对 main | 工作树 |
| --- | --- | --- | --- | --- |
| aip | `feat/zach-28-acceptance-evidence-ci` | `4f1eb40f9ae2f0e7dc996571f6c0f1f3635df7f4` | `main` = `0a0775c`（+1：CI 配置） | clean（`dirty=false`） |
| onto | `feat/zach-28-acceptance-evidence-ci` | `30bf3dea812ad7c5f716a2701a4eeb0fb0df641b` | `main` = `f29d3ba`（+1：CI 配置） | clean（`dirty=false`） |

两仓的分支都已推送。**aip 的分支已按要求合入 `main`**（合并提交见 §8 变更记录），
所以 §2.1 里 aip 各道的运行记录**就是 `main` 上 CI 会跑的那几道**。
onto 的分支**未**合入 `main`——本轮只合了 aip。

真实组合验收层是**跨仓**的：它同时跑 onto 的页面与 aip 的后端，
所以 §2 的 G8 一行同时绑定两个 SHA。

## 2. 门清单（Gate）

「门」是**可独立跑、可独立判红绿**的一道检查。总表每一行都挂在下面某道门上。

| 门 | 仓 | 跑什么 | 复跑命令 | 需要 PG | 需要真实上游 | CI 位置 |
| --- | --- | --- | --- | --- | --- | --- |
| **G1** unit | aip | `tests/unit/**` | `pnpm test:unit` | **是** | 否 | `.github/workflows/ci.yml` → job `unit` |
| **G2** contract | aip | `tests/contract/**` | `pnpm test:contract` | **是** | 否（用仓内置替身） | 同上 → job `contract` |
| **G3** db | aip | `tests/db/**` | `pnpm test:db` | **是** | 否 | 不在最小 CI 内（见 §5） |
| **G4** e2e | aip | `tests/e2e/**` | `pnpm test:e2e` | **是** | 否 | 不在最小 CI 内（见 §5） |
| **G5** real-guard | aip | `tests/real/**`（**真实 RAGFlow**） | `pnpm test:ragflow:real:guard` | **是** | **是**（真实上游 8 个变量） | 同上 → job `real-guard` |
| **G5-b** real-guard 失败路径 | aip | 同 G5，但**故意不配上游** | `pnpm test:ragflow:real:guard`（清空 `RAGFLOW_*`） | 是（但用例会先因缺配置而退出） | 否（就是要缺） | 同上 → job `real-guard` 的第一步 |
| **G6** typecheck | onto | `tsc --noEmit` | `pnpm typecheck` | 否 | 否 | `onto/.github/workflows/ci.yml` → job `typecheck` |
| **G7** test | onto | `pnpm -r test`（platform-shared / server / console / studio） | `pnpm test` | 否 | 否 | 同上 → job `test` |
| **G8** real layer | onto | `console/real/**`（页面 × **真实 aip** × **真实 PG** × **真实 RAGFlow**） | `scripts/real-acceptance.sh up` → `pnpm --filter @onto/console test:platform:real` | **是** | **是**（完整起栈 + 凭据） | 不在最小 CI 内（见 §5） |

> **「需要 PG」这一列是第一轮 CI 跑出来的**：aip 的 `unit` / `contract` 层里都有用例会建隔离 schema
> （`tests/helpers/db.ts`），所以它们**也**需要 PostgreSQL，不只是 `db` / `e2e` / `real` 层。
> 本地跑绿时本机恰好有 `aip-test-postgres` 在跑，把这个依赖掩盖了。详见 §5.1。

### 2.1 本轮每道门的运行记录

时间取报告产物里的 `generated_at`（UTC）。onto 的真实层没有 `summary.json` 生成器，
它的运行记录在 `onto/docs/acceptance-evidence/<sha>/real-layer.json`。

| 门 | 运行时间（UTC） | 结果 | SHA · commit · dirty | 证据摘要（入仓路径） |
| --- | --- | --- | --- | --- |
| G1 unit | 2026-10-29T15:05:05Z | 14 文件 / 72 用例 **72 passed / 0 failed / 0 not_run** | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | `docs/acceptance-evidence/4f1eb40f9ae2f0e7dc996571f6c0f1f3635df7f4/unit/summary.json` |
| G2 contract | 2026-10-29T15:05:45Z | 24 文件 / 116 用例 **116 passed / 0 failed / 0 not_run** | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | `…/contract/summary.json` |
| G3 db | 2026-10-29T15:06:14Z | 22 文件 / 140 用例 **127 passed / 0 failed / 13 not_run** | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | `…/db/summary.json` |
| G4 e2e | 2026-10-29T15:06:24Z | 8 文件 / 45 用例 **45 passed / 0 failed / 0 not_run** | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | `…/e2e/summary.json` |
| G5 real-guard | 2026-10-29T15:07:15Z | 5 文件 / 15 用例 **15 passed / 0 failed / 0 not_run** | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | `…/real/summary.json` + `…/real/cases.json` |
| G5-b 失败路径 | 2026-10-29T14:51:05Z | **退出码 1**（缺 8 项上游配置，逐项列出） | `0a0775c` · `commit=0a0775c` · `dirty=false` | 见 §3.5「失败路径演示」 |
| G6 typecheck | 2026-10-29T15:07:51Z | **exit 0**（4 个 workspace 包） | `30bf3de` · `dirty=false` | `onto/docs/acceptance-evidence/30bf3dea812ad7c5f716a2701a4eeb0fb0df641b/ci-summary.json` |
| G7 test | 2026-10-29T15:07:51Z | **305 passed / 0 failed**（platform-shared 7 + server 138 + console 139 + studio 21） | `30bf3de` · `dirty=false` | 同上 |
| G8 real layer | 2026-10-29T15:00:30Z | **27 passed / 0 failed / 3 skipped**（30 = M24 17 + M25 10 + 截图 3） | onto `30bf3de` + aip `4f1eb40` · 两边均 `dirty=false` | `onto/docs/acceptance-evidence/30bf3dea812ad7c5f716a2701a4eeb0fb0df641b/real-layer.json` |
| G8 + `SCREENSHOTS=1` | 2026-10-29T15:03:59Z | **30 passed / 0 failed / 0 skipped** | 同上 | 同上 |

> G3 的 13 条 `not_run` 是**有意记 NOT RUN**：M01 / M02 的实例级用例需要显式的
> `AIP_TEST_ADMIN_DATABASE_URL`（专用实例），没配就不跑——宁可记 NOT RUN，
> 也不落到共享实例上伤人。缺口登记见 §4。

## 3. M01–M28 总表

**证据路径**列给的是**入仓路径**（不是 `.gitignore` 覆盖的目录）。
每行的断言 `file:line` 明细见 `docs/acceptance.md` §1（同样在仓内）。

**复跑命令**列给的是**逐条复跑**的命令（只跑这一条门里与该判据对应的文件），
整层跑的命令见 §2。

### 3.1 aip M01–M23（API 技术门）

| 编号 | 判据（矩阵摘要） | 门 | 证据路径（入仓） | 复跑命令 | 最近复跑 | SHA · commit · dirty | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M01 | 迁移台账 checksum；第 3 个迁移失败不留成功记录；复合 FK / 唯一约束真实存在于 `pg_constraint`；已写入版本载荷不可改写；应用角色无 DDL；009→010 升级路径 | G3 | `tests/db/migrations.test.ts`、`tests/db/revision-immutability.test.ts`、`tests/db/app-role-separation.test.ts`、`tests/db/migration-upgrade.test.ts` | `pnpm test:db tests/db/migrations.test.ts` | ZACH-28 · 2026-10-29 | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | FULL |
| M02 | 同名 slug 跨项目并存；A 令牌访问 B 路径 403 / B 资源 404；A 账号连不上 B 库；缓存 / 文件路径 / operation 不串用 | G3 | `tests/db/isolation.test.ts`、`tests/helpers/test-instance.ts` | `pnpm test:db tests/db/isolation.test.ts` | ZACH-28 · 2026-10-29 | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | FULL |
| M03 | Skill 注册 201 + 稳定哈希；重启后同载荷同哈希同状态；分页 `limit` + `next_cursor`；无发布 / 执行副作用 | G3 | `tests/db/registry.test.ts` | `pnpm test:db tests/db/registry.test.ts` | ZACH-28 · 2026-10-29 | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | FULL |
| M04 | 20 并发同 slug/version → 1×201 + 19×409；同键同体重放原资源，同键异体 409；不静默创建 1.0.1；同键跨资产各自成立 | G3 | `tests/db/registry-concurrency.test.ts`、`tests/db/idempotency-scope.test.ts` | `pnpm test:db tests/db/registry-concurrency.test.ts` | ZACH-28 · 2026-10-29 | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | FULL |
| M05 | 8 种非法版本 422 定位 `version`；缺正文 422；正文 >256KiB 413；载荷 >512KiB 413；非法请求不落库；正文外 URL 不被抓取；本机路径内容入口被拒 | G1 | `tests/unit/versions.test.ts`、`tests/unit/upload-boundaries.test.ts` | `pnpm test:unit tests/unit/versions.test.ts` | ZACH-28 · 2026-10-29 | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | FULL |
| M06 | 发布 1.0.1 后绑定仍指向 1.0.0；绑定两端 ≥2 个外键；依赖详情显示准确版本 / 哈希 | G3 | `tests/db/agent-binding.test.ts` | `pnpm test:db tests/db/agent-binding.test.ts` | ZACH-28 · 2026-10-29 | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | FULL |
| M07 | 缺版本 / 畸形版本 / 不存在 / Agent 当 Skill / 已撤回 / 重复引用 / 跨作用域错误全等；失败不留半截行 | G3 | `tests/db/agent-invalid-reference.test.ts` | `pnpm test:db tests/db/agent-invalid-reference.test.ts` | ZACH-28 · 2026-10-29 | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | FULL |
| M08 | 只有 `asset:write` → 403 指 `asset:bind`；不可下放权限 → `CONTRACT_INVALID`；config 中密钥 / URL / 嵌套 password → 拒绝；`execution_enabled=true` → 拒绝；注册不产生执行任务；秘密不入库 / 不入日志 / 不回显 | G3 | `tests/db/agent-permission.test.ts` | `pnpm test:db tests/db/agent-permission.test.ts` | ZACH-28 · 2026-10-29 | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | FULL |
| M09 | 注册与撤回线性化；撤回后新绑定被拒；旧 `state_revision` → 409；`revoked` 是终态 | G3 | `tests/db/status-race.test.ts` | `pnpm test:db tests/db/status-race.test.ts` | ZACH-28 · 2026-10-29 | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | **PARTIAL**（缺口见 §4） |
| M10 | 202 + 操作号；成功才落 dataset 映射；业务失败 / 缺 `data.id` / 上游 401 三类失败结论可区分；丢响应 → `unknown_outcome` 且只发一次 POST | G2 + G3 | `tests/contract/ragflow-dataset.test.ts`、`tests/contract/dataset-negative-cases.test.ts`、`tests/db/review-recovery.test.ts` | `pnpm test:contract tests/contract/ragflow-dataset.test.ts` | ZACH-28 · 2026-10-29 | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | FULL |
| M11 | 单个 `file` 字段 multipart；`data` 长度 1 且 dataset 匹配；来源 sha256 落库；协议错误即失败；丢响应 → `unknown_outcome` 且不盲重传；同名不同来源不得被认领 | G2 + G3 | `tests/contract/ragflow-upload.test.ts`、`tests/contract/upload-integrity.test.ts`、`tests/db/upload-identity.test.ts`、`tests/db/review-recovery.test.ts` | `pnpm test:contract tests/contract/ragflow-upload.test.ts` | ZACH-28 · 2026-10-29 | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | FULL |
| M12 | 20MiB 边界「恰好等于上限被接受」；超 1 字节 413；扩展名 / MIME / 伪 PDF / 损坏 UTF-8 / `../` 被拒；两文件、压缩包被拒；非法请求 RAG 全 HTTP 为 0；无目录穿越与残留未引用文件 | G1 + G2 + G4 | `tests/unit/upload-limits.test.ts`、`tests/unit/upload-boundaries.test.ts`、`tests/contract/upload-rejections.test.ts`、`tests/e2e/upload-security.test.ts`、`tests/e2e/upload-limit-real.test.ts` | `pnpm test:e2e tests/e2e/upload-limit-real.test.ts` | ZACH-28 · 2026-10-29 | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | FULL |
| M13 | `code 0` 不立即 ready；DONE + 进度完成 + chunk_count>0 才 ready 并登记 index_revision；FAIL / CANCEL 可见错误；DONE+0 → empty；`run` 各分支按实现判定 | G2 | `tests/contract/ragflow-parse.test.ts`、`tests/contract/parse-status-branches.test.ts` | `pnpm test:contract tests/contract/ragflow-parse.test.ts` | ZACH-28 · 2026-10-29 | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | FULL |
| M14 | Worker 解析中退出后重启续跑同一 doc、不得新上传；两个 worker 抢同一 operation 只有一个拿到租约；旧 epoch 迟到写入被拒；20 分钟未完成 → 终态 timeout；用户 GET 返回 stale 标记 | G2 + G3 + G4 | `tests/db/operation-fencing.test.ts`、`tests/db/crash-window-recovery.test.ts`、`tests/contract/parse-recovery.test.ts`、`tests/e2e/knowledge-stale.test.ts` | `pnpm test:db tests/db/operation-fencing.test.ts` | ZACH-28 · 2026-10-29 | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | **PARTIAL**（缺口见 §4） |
| M15 | 未审 / 拒绝 / 批准 / 撤回四态；审核记录落库；哈希不符 409；并发 CAS 409；无 `knowledge:review` → 403；拒绝态不可检索；撤回本地立即拒绝召回 / 下载；撤回登记操作并推进到终态 | G3 + G4 | `tests/e2e/knowledge-review.test.ts`、`tests/e2e/withdraw.test.ts`、`tests/db/knowledge-withdraw-terminal.test.ts`、`tests/db/delivery-boundary.test.ts` | `pnpm test:e2e tests/e2e/withdraw.test.ts` | ZACH-28 · 2026-10-29 | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | FULL |
| M16 | 401 / 403 语义正确；无 `knowledge:read` → 403 且上游 0 请求；文档详情按权限鉴权；请求体自带 actor 无效；越权回包整体失败；显式不可见资源 404 | G2 | `tests/contract/scope-limits.test.ts`、`tests/contract/ragflow-authorization.test.ts`、`tests/contract/retrieval-authz.test.ts`、`tests/contract/audit-and-log-hygiene.test.ts` | `pnpm test:contract tests/contract/scope-limits.test.ts` | ZACH-28 · 2026-10-29 | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | FULL |
| M17 | 有项目读权限但无文档授权 → `no_match` + `evidence=[]` + 全部 HTTP 调用数 0；缺上下文 → `needs_context` + 0 调用；授权集合只剩已撤回知识 → `no_match` + 0 调用 | G2 | `tests/contract/ragflow-empty-access.test.ts`、`tests/contract/withdrawn-access.test.ts` | `pnpm test:contract tests/contract/ragflow-empty-access.test.ts` | ZACH-28 · 2026-10-29 | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | FULL |
| M18 | 上游只允许精确 docA + 所属 dataset；客户端混传有权 / 无权引用 → 404 且不泄露；上游 200 但 `code != 0` → 整体失败；metadata 不能替代 ID 限制；越权回包整体 502 | G2 | `tests/contract/ragflow-authorization.test.ts`、`tests/contract/retrieval-authz.test.ts` | `pnpm test:contract tests/contract/ragflow-authorization.test.ts` | ZACH-28 · 2026-10-29 | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | FULL |
| M19 | 读最多 3 次、总预算 ≤ 生产默认 30s；最终 503/504；429 与 `Retry-After` 退避；连接被拒可安全重试；写响应丢失只发一次并进入 `unknown_outcome`；不泄漏 key / 上游原文 / 文件正文 | G1 + G2 + G3 | `tests/contract/ragflow-unavailable.test.ts`、`tests/contract/ragflow-retry.test.ts`、`tests/unit/ragflow-timeout.test.ts`、`tests/unit/config-defaults.test.ts` | `pnpm test:contract tests/contract/ragflow-retry.test.ts` | ZACH-28 · 2026-10-29 | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | FULL |
| M20 | 上游调用期间撤销 → 交付前重查后丢弃已失权内容；撤销提交后新请求也不可用旧 ACL；下载同查；不持 PG 锁跨网络；交付线性化点在授权行锁内 | G2 + G3 + G4 | `tests/contract/acl-revocation.test.ts`、`tests/contract/download-revocation.test.ts`、`tests/db/delivery-boundary.test.ts`、`tests/e2e/citations.test.ts` | `pnpm test:db tests/db/delivery-boundary.test.ts` | ZACH-28 · 2026-10-29 | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | FULL |
| M21 | 证据带 knowledge / index / source 版本 + `chunk_hash` + score；无页码标 `incomplete` 不伪造；索引重建后旧 evidence 仍可读；来源下载 sha256 与原文件实际哈希一致 | G2 + G3 + G4 | `tests/e2e/citations.test.ts`、`tests/e2e/index-rebuild.test.ts`、`tests/contract/upload-integrity.test.ts` | `pnpm test:e2e tests/e2e/citations.test.ts` | ZACH-28 · 2026-10-29 | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | FULL |
| M22 | 显式无权 → 404；有权但未 ready → 409 `INDEX_NOT_READY`；授权文档数超上限 → 422 且 0 上游请求；201 个可授权文档按真实阈值拒绝；多 dataset 越界 → 422；`top_n` 越界 → 422 | G1 + G2 | `tests/contract/scope-limits.test.ts`、`tests/contract/ragflow-whitelist.test.ts`、`tests/contract/retrieval-document-count.test.ts`、`tests/contract/retrieval-limits.test.ts` | `pnpm test:contract tests/contract/retrieval-limits.test.ts` | ZACH-28 · 2026-10-29 | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | FULL |
| M23 | 无概念引用的字符串契约注册成功且校验器未被调用；数值契约缺概念引用 → 422；本体不可达 → 503 `ONTO_UNAVAILABLE` 且不降级成功；概念不存在 → 422 并指出引用；详情标 `concept_validation='not_requested'` | G1 + G2 | `tests/unit/concept-gate.test.ts`、`tests/contract/retrieval-limits.test.ts` | `pnpm test:unit tests/unit/concept-gate.test.ts` | ZACH-28 · 2026-10-29 | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | FULL |

### 3.2 M24 / M25（UI 门 —— 交付物在 onto 仓）

| 编号 | 判据（矩阵摘要） | 门 | 证据路径（入仓） | 复跑命令 | 最近复跑 | SHA · commit · dirty | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **M24** | 列表空 / 加载 / 错误 / 403；直接深链；表单 `field_path`；注册 409；版本选择；binding 失效明显可见 | **G8** | aip：**无**（本仓无前端代码、无 Playwright、无 `test:platform` 脚本）<br>onto：`console/real/m24-registration.spec.ts`（17 例）<br>onto：`console/real/README.md`、`console/real/STACK.md` | aip：不适用<br>onto：`scripts/real-acceptance.sh up` → `pnpm --filter @onto/console test:platform:real m24-registration` | ZACH-28 · 2026-10-29T15:00:30Z | onto `30bf3de` + aip `4f1eb40` · 两边均 `dirty=false` | **aip：NOT RUN**（UI 门不在本仓）<br>**onto：PARTIAL**（加载态一项，见 §4） |
| **M25** | pending / parsing / failed / ready 四态；审核；`no_match` / `needs_context` / 503；来源缺定位；密钥不入浏览器请求 / storage / bundle；401 / 切项目清理结果 | **G8** | aip：**无**（同上）<br>onto：`console/real/m25-knowledge.spec.ts`（10 例）<br>onto：`console/real/README.md`、`console/real/STACK.md` | aip：不适用<br>onto：`scripts/real-acceptance.sh up` → `pnpm --filter @onto/console test:platform:real m25-knowledge` | ZACH-28 · 2026-10-29T15:00:30Z | onto `30bf3de` + aip `4f1eb40` · 两边均 `dirty=false` | **aip：NOT RUN**（UI 门不在本仓）<br>**onto：FULL 10/10** |

### 3.3 M26 / M27（真实集成门）

| 编号 | 判据（矩阵摘要） | 门 | 证据路径（入仓） | 复跑命令 | 最近复跑 | SHA · commit · dirty | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **M26** | 全步骤真实可追踪，引用指向上传原文并有可核验摘要；真实报告含版本 / digest / 来源证据；任何 mock 替代判失败 | **G5**（平台侧）<br>**G8**（页面侧） | aip：`docs/acceptance-evidence/4f1eb40f9ae2f0e7dc996571f6c0f1f3635df7f4/real/summary.json`（`ragflow.source_sha` / `image_digest` / `embedding_revision` / `counts`）+ 同目录 `cases.json`<br>aip：`tests/real/closed-loop.test.ts`、`tests/real/anti-substitute.test.ts`<br>onto：`console/real/m24-registration.spec.ts`、`console/real/m25-knowledge.spec.ts` | aip：`pnpm test:ragflow:real:guard`<br>onto：`scripts/real-acceptance.sh up` → `pnpm --filter @onto/console test:platform:real` | ZACH-28 · 2026-10-29T15:00:30Z | aip `4f1eb40` · `commit=4f1eb40` · `dirty=false`<br>onto `30bf3de` · `dirty=false` | FULL |
| **M27** | 真实检索不返回未授权文档；无授权请求 0；真实不可达 503/504；解析失败保持 failed；目标解析失败不可稳定复现时明确 NOT RUN 而非用 mock 记真实通过 | **G5**（平台侧）<br>**G8**（页面侧） | aip：`docs/acceptance-evidence/4f1eb40f9ae2f0e7dc996571f6c0f1f3635df7f4/real/cases.json`（逐用例）<br>aip：`tests/real/isolation-failure.test.ts`、`tests/real/upstream-unreachable.test.ts`、`tests/real/parse-failure.test.ts`<br>onto：`console/real/m25-knowledge.spec.ts:453`（空授权零上游请求） | aip：`pnpm test:ragflow:real tests/real/isolation-failure.test.ts`<br>onto：`pnpm --filter @onto/console test:platform:real m25-knowledge` | ZACH-28 · 2026-10-29T15:00:30Z | aip `4f1eb40` · `commit=4f1eb40` · `dirty=false`<br>onto `30bf3de` · `dirty=false` | **PARTIAL**（三条子判据仍是 NOT RUN，见 §4） |

### 3.4 M28

| 编号 | 判据（矩阵摘要） | 门 | 证据路径（入仓） | 复跑命令 | 最近复跑 | SHA · commit · dirty | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M28 | 8 张持久化表内无上游 key / DB URL / token；带 `api_key` 的 config 被拒；嵌套 password 与 URL 被拒；上游错误原文不回显；构建产物扫描无密钥形态；日志快照不含敏感内容；动态出口 `base_url` 被拒；重定向不泄漏 key；审计 subject 来自可信 principal | G1 + G2 + G3 | `tests/unit/security-no-secret.test.ts`、`tests/unit/secret-scan.test.ts`、`tests/unit/redirect-key-leak.test.ts`、`tests/contract/audit-and-log-hygiene.test.ts`、`tests/db/config-policy.test.ts` | `pnpm test:unit tests/unit/secret-scan.test.ts` | ZACH-28 · 2026-10-29 | `4f1eb40` · `commit=4f1eb40` · `dirty=false` | FULL |

### 3.5 失败路径演示：缺上游配置时 real-guard 必须红

`tools/real-guard.mjs` 的设计（**不要改**）：缺真实配置时它**必须**以非零退出，
并把缺失项逐个列出来；只有「配置齐备且真实联调通过」才允许 0。
它的存在就是为了让「只看退出码的 CI」不会把「没跑」判成「跑通」。

本轮实测（2026-10-29T14:51:05Z，`RUN_REAL_RAGFLOW` 未开、8 个 `RAGFLOW_*` 变量全部未设）：

```
$ pnpm test:ragflow:real:guard
...
Error: RUN_REAL_RAGFLOW=1 but required configuration is missing: RAGFLOW_BASE_URL,
  RAGFLOW_API_KEY, RAGFLOW_API_VERSION, RAGFLOW_TEST_PROJECT_ID,
  RAGFLOW_EMBEDDING_MODEL, RAGFLOW_EMBEDDING_REVISION, RAGFLOW_IMAGE_DIGEST,
  RAGFLOW_SOURCE_SHA
real layer exits non-zero without configuration (missing: RAGFLOW_BASE_URL, ...)
ELIFECYCLE  Command failed with exit code 1.
$ echo $?
1
```

- **退出码 1**（红），不是 0，也不是「跳过」。
- 该次运行的报告产物**已入仓**：`docs/acceptance-evidence/0a0775c781db1826f2d3c26d077234cc61b98742/real/summary.json`
  —— `counts = {cases: 15, pass: 0, fail: 0, not_run: 15}`，
  `run_end_reason: "failed"`，`ragflow.source_sha = null`（**没有**上游事实，因为根本没连上）。
  这份「跑绿」的反面证据同样能自证：**没有上游事实 = 没有真的跑过**。
  同目录 `cases.json` 是逐用例记录。
- CI 里这道自检固化成 job `real-guard` 的第一步（`fail-closed 自检`）：
  断言退出码非零 **且** 失败原因确实是 `required configuration is missing`，
  然后才用仓库 secret 真跑一遍。**任何一步都不允许 `skip` 冒充通过。**

## 4. 缺口登记（PARTIAL / NOT RUN 逐条）

定稿口径里的 PARTIAL / NOT RUN **不因为本轮复跑而改变**。逐条列在这里，
每条都写清楚「缺什么、为什么没补、怎么才能补」。

| 编号 | 缺口 | 为什么是 PARTIAL / NOT RUN | 怎么才能补 |
| --- | --- | --- | --- |
| M09 | 缺**确定性 barrier** 覆盖两个提交顺序 | 并发用 `Promise.all` 发起，覆盖到的是「并发提交后旧修订号被拒」，不是「两种提交顺序各自成立」 | 加一个强制提交顺序的 barrier（先提交 A 拿到锁再提交 B），补一条独立断言 |
| M14 | **没有真的 kill 进程** | 崩溃窗口是用持久状态重建（租约接管）模拟的；杀进程引入不可复现时序 | 引入真实进程级故障注入（子进程 + SIGKILL） |
| M24（加载态） | 骨架屏断言**只覆盖知识库列表**；资产列表只断言空态 | `console/real/m25-knowledge.spec.ts:433` 断言了 `.ant-skeleton` 出现并让位；`console/real/m24-registration.spec.ts:83` 只断言空态文案与注册按钮 | 给资产列表补一条「请求在途时出现骨架屏」的断言（真实栈下打一次延迟即可） |
| M27 ① | **真实 504 / 读超时** | 真实层只覆盖到 503（连接被内核拒绝 `ECONNREFUSED`）；本机到不可路由地址的连接被拦成空回包，拿不到真正的 connect timeout | 造一个「接受连接但永不回包」的真实上游进程；读超时路径目前只有替身层证据（`tests/contract/ragflow-unavailable.test.ts:89`） |
| M27 ② | **真实撤回** | `tests/real/` 没有撤回用例；撤回链路只在替身与端到端层验证，真实上游的删文档未被触发 | 在 `tests/real/` 补撤回用例，触发上游删索引 |
| M27 ③ | **真实 A/B 同库混排** | 真实层只做到「一个文档 + 两个主体 + 请求层 404」，没有覆盖同一知识库里多份来源、多个主体交叉命中的混排 | 补一条「同库多来源 × 多主体交叉命中」的真实用例 |
| M24 / M25（aip 侧） | aip 仓 `NOT RUN` | aip 仓没有前端代码、没有 Playwright、没有 `test:platform` 脚本；UI 门由 onto 仓交付 | 不必在 aip 仓补；本表的 onto 两行就是它们的页面级结论 |

> **G3 的 13 条 `not_run`**：M01 / M02 的实例级用例需要显式的 `AIP_TEST_ADMIN_DATABASE_URL`
> （专用实例 + 角色隔离）。没配就整组记 NOT RUN——**宁可缺证据，也不落到共享实例上伤人**。
> 复核者按 `docs/runbook.md` 第 6 节起一个一次性实例后复跑即可补上。

## 5. 最小 CI 与本表的边界

本 issue 只加**文档与 CI 配置**，不改产品行为、不改任何断言口径。CI 落地情况：

| 仓 | workflow | 门 | 状态 |
| --- | --- | --- | --- |
| aip | `.github/workflows/ci.yml` | `unit`、`contract`、`real-guard` | **已合入 `main` 并真实跑过**；`unit`/`contract` 已绿，`real-guard` 因仓库未配上游 secret 而红（按设计，详见 §5.1） |
| onto | `.github/workflows/ci.yml` | `typecheck`、`test` | workflow 文件已随分支提交并推送；onto 未合入 `main`（本轮只合了 aip） |

### 5.1 CI 的实际状态：已跑起来，而且第一轮就抓到了真问题

workflow 合入 `main` 之后，CI **真的跑起来了**（`push: branches: [main]` 触发）。
第一轮运行就抓到一处**真问题**，已修：

| 轮次 | unit | contract | real-guard |
| --- | --- | --- | --- |
| 第 1 轮 | ❌ 红 | ❌ 红 | ❌ 红（**按设计**） |
| 原因 | `connect ECONNREFUSED 127.0.0.1:55433` | 同左 | 缺 8 项上游配置 → fail-closed |

**unit / contract 也需要 PostgreSQL。** 本地跑绿是因为本机恰好有 `aip-test-postgres`
在 `127.0.0.1:55433`；GitHub 的 runner 上没有这个库，两层里凡是会建隔离 schema 的用例
（`tests/unit/` 的 4 个文件、`tests/contract/` 的 24 个文件）全部 `ECONNREFUSED`。
**这不是产品缺陷，是 CI 配置漏了依赖**：三个 job 现在都起 `postgres:16-alpine` service
并注入 `AIP_TEST_DATABASE_URL`。

> 这条经验值得留在文档里：**「本地绿」不等于「CI 绿」**。
> 判断某层需不需要外部依赖，要看它有没有落到 `tests/helpers/db.ts` 那条建 schema 的路径上，
> 而不是看它被放在哪个目录。

**real-guard 的红是设计如此**：仓库里一个 Actions secret 都没配（`GET /actions/secrets`
返回 `total_count: 0`），所以第二个 step 必然红——这正是 fail-closed。
同一个 job 的第一个 step（**fail-closed 自检**）是**绿的**：它确认了 guard 在缺配置时
以非零退出、并明确列出缺失的 8 项。一道门同时给出「该红时红」和「红的原因正确」两个事实。

**要让它变绿需要什么**（只差这一件事了）：

1. **配 8 个仓库 secret**（Settings → Secrets and variables → Actions）：
   `RAGFLOW_BASE_URL` / `RAGFLOW_API_KEY` / `RAGFLOW_API_VERSION` / `RAGFLOW_TEST_PROJECT_ID` /
   `RAGFLOW_EMBEDDING_MODEL` / `RAGFLOW_EMBEDDING_REVISION` / `RAGFLOW_IMAGE_DIGEST` / `RAGFLOW_SOURCE_SHA`。
   **不配它就红**——那不是可以忽略的噪声，正是这道门要拦的「把没跑记成跑通」。
2. **token 权限**：推 workflow 需要 `workflow` scope（本机 token 已具备：
   `read:user, repo, user:email, workflow`）。

**在本机也按同样命令复跑过一遍**（`pnpm install --frozen-lockfile` + 各 job 的 `run` 命令，
见 §2.1）。唯一的差异是 PostgreSQL：CI 里用 `services.postgres` 容器
（`postgres:16-alpine`，`aip_test` / `aip_test_pw` / `aip_test`，映射到 `localhost:5432`），
本地跑的是同镜像的既有容器 `aip-test-postgres`（`127.0.0.1:55433`，同名角色与同名库）。
**连接串的端口不同，库结构、角色与用例行为一致**——每个用例自建 schema、结束即删。

`real-guard` job 里那段 fail-closed 自检的 bash 是**逐字从 workflow 里抽出来执行的**：

| 场景 | 期望 | 实测 |
| --- | --- | --- |
| 真 guard，缺 8 项上游配置 | 自检**绿**（因为它正确地红了） | `STEP EXIT=0`，输出「fail-closed 自检通过：缺配置时以非零退出（exit=1）并明确列出缺失项。」 |
| 反向对照：把 `pnpm` 换成恒退 0 的假命令 | 自检必须**红** | `STEP EXIT=1`，输出 `::error::real-guard 在缺上游配置时以 0 退出——CI 会把「没跑」判成「跑通」，违反 fail-closed 约定。` |

即：**这份自检确实能抓住「假绿」**，不是只测了顺风路径。

**为什么 G3 / G4 / G8 不在最小 CI 里**：

- **G3 / G4**（db / e2e 层）除了 PostgreSQL 之外，还要**角色隔离**：
  M01 / M02 的实例级用例需要显式的 `AIP_TEST_ADMIN_DATABASE_URL`（专用实例 + 建角色建库），
  没配就整组记 NOT RUN。把「有时会整组 NOT RUN」的门放进最小 CI，会让 CI 的红绿含义变模糊。
  （注意：**PG 本身不是排除理由**——`unit` / `contract` 也需要 PG，它们同样在 CI 里带了 service。）
  本轮已在本地把它们跑绿并落了摘要（`docs/acceptance-evidence/<sha>/db/summary.json`、`e2e/summary.json`）。
- **G8**（onto 真实组合验收层）需要完整起栈（PostgreSQL + 三个 aip 实例 + worker + 路由代理 +
  正式构建预览）与真实 RAGFlow 凭据，是**一次性的人工 / 专用环境门**，不是 PR 门。
  它由 `scripts/real-acceptance.sh` 一条命令起栈，复跑记录在
  `onto/docs/acceptance-evidence/<sha>/real-layer.json` 与 `onto/console/real/STACK.md`。

**fail-closed 是硬约束**：`real-guard` job 里不允许出现
`if: secrets.X != ''` 这类条件跳过。上游 secret 没配 → 这道门红。
这是设计如此，不是可以忽略的噪声。

**仓库里不写任何密钥与上游地址**：8 个 `RAGFLOW_*` 变量全部从 GitHub 仓库 secret 读，
workflow 里只留变量名。

## 6. 证据摘要入仓：路径与口径

### 6.1 为什么要有这一节

`reports/` 在 aip 的 `.gitignore` 里（`aip/.gitignore` 第 8 行），
所以 `reports/<sha>/<mode>/summary.json` 里的 `commit` / `dirty` / `counts`
**复核者拿不到**——这正是本 issue 要补的记录链。

### 6.2 入仓路径

| 仓 | 路径 | 内容 |
| --- | --- | --- |
| aip | `docs/acceptance-evidence/<sha>/{unit,contract,db,e2e,real}/summary.json` | 每次运行的元数据：`commit`、`dirty`、`changed_tracked`、`untracked`、`dependency_lock_hash`、逐迁移文件 sha256 与 `migration_set_hash`、RAGFlow tag / `source_sha` / `image_digest`、`embedding_revision`、`parser_digest`、部署环境、用例计数、`run_end_reason`、哈希口径说明 |
| aip | `docs/acceptance-evidence/<sha>/real/cases.json` | 真实层的**逐用例**记录（状态、文件、断言条数、主体角色、trace_id、失败原因） |
| onto | `docs/acceptance-evidence/<sha>/real-layer.json` | 页面真实层的运行记录（命令、次数、结果、两个仓的 SHA、起栈参数） |
| onto | `docs/acceptance-evidence/<sha>/ci-summary.json` | `typecheck` / `test` 两道门的运行记录 |

`<sha>` = **被测代码的 SHA**，与 `summary.json` 里的 `commit` 字段相等。
目录名对不上就不要采信。

### 6.3 留在仓外的东西（及其去处）

| 产物 | 为什么留仓外 | 去处 |
| --- | --- | --- |
| `reports/<sha>/<mode>/.trace.jsonl` | 运行期原始事实流，体积大（单层 44KB–324KB） | 本机 `reports/`；CI 里作为 artifact 上传（`reports-unit` / `reports-contract` / `reports-real`） |
| `console/real/.artifacts/`、`console/real/screenshots/` | Playwright 调试产物与交付截图 | 随交付走附件；CI 不上传 |
| `var/real-acceptance/` | 起栈脚本写的 env 文件含本轮数据库口令与 PID | 本机，`.gitignore` 已忽略 |

> **结论与命令必须可追溯**（进仓），**大体积原始日志可以留在仓外**（artifact / 附件）。

### 6.4 怎么重新生成

```bash
# aip：每层跑完就产出 reports/<sha>/<mode>/summary.json
pnpm test:unit
pnpm test:contract
pnpm test:db          # 需要 AIP_TEST_DATABASE_URL
pnpm test:e2e         # 需要 AIP_TEST_DATABASE_URL
pnpm test:ragflow:real:guard   # 需要 8 个 RAGFLOW_* 变量；缺配置时**红**（见 §3.5）

# 把摘要复制到入仓路径（<sha> 换成这次运行的 commit）
mkdir -p docs/acceptance-evidence/<sha>
cp -R reports/<sha>/<mode> docs/acceptance-evidence/<sha>/<mode>
# 只留 summary.json 与 real/cases.json；.trace.jsonl 不入仓
```

## 7. 怎么查「某条门上次跑绿是什么时候」

1. 打开本表 → 找到判据编号（M01–M28）。
2. 看「门」列 → 知道它挂在 G1–G8 哪一道上。
3. 看「证据路径」列 → 打开那个入仓路径（测试文件 / 摘要 JSON）。
4. 看「最近复跑 / SHA · commit · dirty」列 → 拿到复跑者、时间、SHA、`commit`、`dirty`。
5. 要自己复跑 → 用「复跑命令」列的命令；整层跑用 §2 的命令。

## 8. 变更记录

| 日期 | 变更 | 出处 |
| --- | --- | --- |
| 2026-10-29 | 首版：建立跨仓总表；证据摘要从 gitignore 的 `reports/` 迁到 `docs/acceptance-evidence/<sha>/`；两仓各加最小 CI | ZACH-28 |
| 2026-10-29 | aip 分支合入 `main`（合并提交 `ff4ac58`）。CI **真实跑起来**，第一轮即暴露「`unit` / `contract` 也需要 PostgreSQL」——本机有 `aip-test-postgres` 把这个依赖掩盖了。三个 job 补上 `postgres:16-alpine` service 与 `AIP_TEST_DATABASE_URL`；总表 §2 / §5.1 同步更正 | ZACH-28（按需求方指示合入 main） |
