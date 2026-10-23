# M01–M28 验收对照表

本表是 ZACH-9「Skill/Agent 注册与 RAGFlow 知识库闭环」首批交付的验收索引。
每一条都给出判据、证据位置与状态；**状态不描述工作量，只描述事实**。

## 门禁口径

本批有三个相互独立的门，**分开汇报，不得合并成一个「已完成」**：

| 门 | 含义 | 通过条件 |
| --- | --- | --- |
| **API 技术门** | 本地可验证的实现：契约、数据库、并发、权限、错误语义 | 对应层的自动化测试真实执行并通过（命令与结果见交付说明） |
| **UI 门** | 最小前端流程与持久化 | 页面可用且与后端契约一致。前置条件是 ZACH-4 写完 **且** ZACH-5 评审基线/变更边界明确，由 Mika 协调接入；ZACH-4/ZACH-5 处于 `in_review` **不等于** UI 已发布 |
| **真实集成门** | 与真实 RAGFlow 的闭环 | 需要真实环境与固定配置；缺配置时**明确标记未验收**，不允许用替身测试的结果顶替 |

状态取值：

- `已通过（API 技术门）` —— 该条目在本地自动化测试中已被真实验证。
- `已通过（真实集成门）` —— 该条目在与真实 RAGFlow 的闭环中被真实验证。
- `未验收（缺真实环境）` —— 需要真实 RAGFlow / 真实闭环环境才能判定，当前缺配置或缺环境。
- `未做` —— 本批未实现或未验证，附原因。

> 替身（RAGFlow 记录式替身，`tests/helpers/ragflow.ts`）用于契约层与端到端层的自动化断言，
> 覆盖本文件第 2 节「门禁口径」中的 API 技术门。
> **替身通过 ≠ 真实集成通过**，两者的结果在交付说明中分开汇报。

---

## 1. 对照表

| 编号 | 验收点 | 门 | 判据 | 证据位置 | 状态 |
| --- | --- | --- | --- | --- | --- |
| M01 | 迁移账本与校验和 | API 技术门 | 迁移账本 `aip_schema_migration` 记录文件名与 sha256；校验和不一致时拒绝执行；单个迁移失败不留账本行、不留半成品表；`asset_revision` 正文与哈希不可变（UPDATE/DELETE 均被拒） | `tests/db/migrations.test.ts` | 已通过（API 技术门） |
| M02 | 多租户数据隔离 | API 技术门 | 同名 slug 可在不同 project 并存；A 的令牌访问 B 的路径或资源分别得到 403 / 404；数据库角色 A 无法连接 B 的库；操作记录不跨 project 可见 | `tests/db/isolation.test.ts` | 已通过（API 技术门） |
| M03 | Skill 注册与查询（含重启后一致） | API 技术门 | 注册返回 201 与稳定 `content_hash`；重启 API 进程后 GET 返回完全相同的载荷、哈希与状态；分页 `limit` + `next_cursor` 且页面互不重叠；注册不产生任何 operation，也不产生 published/executable 字段 | `tests/db/registry.test.ts` | 已通过（API 技术门） |
| M04 | 重复注册与幂等键冲突 | API 技术门 | 20 路并发注册同一 slug/version 只产生 1 个 201 与 19 个 409，数据库只有 1 条资产、1 条版本、1 条成功审计；同幂等键同请求体重放返回同一 `asset_id`；同幂等键不同请求体返回 409 `IDEMPOTENCY_CONFLICT` 且不改动旧标题；不产生静默的 1.0.1；显式创建版本得到 1.0.0 与 1.0.1 | `tests/db/registry-concurrency.test.ts` | 已通过（API 技术门） |
| M05 | 版本号校验与体积上限 | API 技术门 | `latest` / `^1.0` / `1` / `v1.0.0` / `1.0` / `1.0.0.0` / `01.0.0` / 空串一律 422 `INVALID_VERSION` 且定位到 `version` 字段；缺 `payload.content` 422 `CONTRACT_INVALID`；正文超 256 KiB 413；载荷超 512 KiB 413；非法请求不落任何行；正文中的外部 URL 不被抓取（0 次上游请求） | `tests/unit/versions.test.ts` | 已通过（API 技术门） |
| M06 | Agent 绑定固定 Skill 版本 | API 技术门 | Skill 发布 1.0.1 后，已绑定的 Agent 仍指向 1.0.0；`agent_skill_binding` 上存在至少 2 个外键约束；绑定行只有 1.0.0 一条 | `tests/db/agent-binding.test.ts` | 已通过（API 技术门） |
| M07 | 无效引用拒绝 | API 技术门 | 引用不存在的版本 → `REF_NOT_AVAILABLE`；畸形版本（`latest`/`1.0`/`v1.0.0`/`^1.0.0`）→ 422 且定位到 `payload.skill_refs[0].version`；引用 Agent 当作 Skill → `REF_NOT_AVAILABLE`；引用已 revoked 的 Skill → `REF_NOT_AVAILABLE`；重复引用 → 422 定位到 `payload.skill_refs[1]`；跨作用域引用与不存在的错误表现一致（不泄露存在性）；失败时不留半截行 | `tests/db/agent-invalid-reference.test.ts` | 已通过（API 技术门） |
| M08 | 绑定权限与不启动执行 | API 技术门 | 只有 `asset:write` → 403 且信息指向 `asset:bind`；有 `asset:bind` 无 `asset:read` → 403 且信息指向 `asset:read`；不可下放的 `asset:manage` → `CONTRACT_INVALID`；可下放但未持有的 `source:read` → `PERMISSION_ESCALATION`；`config` 中的 `api_key`/URL/嵌套 `password` → 拒绝且密钥不出现在 `asset_revision.payload`；`execution_enabled: true` → `CONTRACT_INVALID`；注册不产生 operation；不存在 `/run` 端点（404） | `tests/db/agent-permission.test.ts` | 已通过（API 技术门） |
| M09 | 状态机与并发竞态 | API 技术门 | 并发的「注册」与「吊销」被线性化（要么 201 且 `binding_valid === false`，要么 422 `REF_NOT_AVAILABLE` 且无残留资产行）；绑定到已 revoked 的 Skill → `REF_NOT_AVAILABLE`；过期的 `expected_state_revision` → 409 `STATE_CONFLICT`；`revoked` 是终态（409 且行状态不变） | `tests/db/status-race.test.ts` | 已通过（API 技术门） |
| M10 | RAGFlow dataset 固定契约 | API 技术门 | 创建知识库返回 202 与操作号，推进后写入 dataset 映射并置 `ready`；上游只创建一次 dataset（先按稳定名称核对，未命中才 POST）；HTTP 200 但 `code != 0` 不算成功；缺 `data.id` 是协议错误；上游 401 归为凭据问题；创建响应丢失时登记 `unknown_outcome` 且不再发第二次 POST | `tests/contract/ragflow-dataset.test.ts` | 已通过（API 技术门） |
| M11 | 文档上传契约 | API 技术门 | 上传走 multipart 单 `file` 字段，上游收到的是原始文件名与内容；上游返回的 dataset 与请求一致；上游响应缺 `id` 是协议错误；上传结果未知时不重发（只读核对） | `tests/contract/ragflow-upload.test.ts` | 已通过（API 技术门） |
| M12 | 上传大小与类型限制 | API 技术门 | 超过 20 MiB 返回 413 `UPLOAD_TOO_LARGE`；扩展名不在 `.txt`/`.md`/`.pdf` 返回 415；MIME 与扩展名不匹配返回 415；PDF 缺 `%PDF-` 文件头返回 415；加密 PDF 返回 422 `CONTRACT_INVALID`；文本非 UTF-8 或含二进制控制字符返回 422；文件名含路径或 `..` 被拒；非法上传**不产生任何上游请求** | `tests/unit/upload-limits.test.ts`、`tests/e2e/upload-security.test.ts` | 已通过（API 技术门） |
| M13 | 解析状态轮询 | API 技术门 | 轮询 `GET /datasets/{id}/documents?id=…`，`run` 为 `RUNNING` 时保持 `parsing`；`DONE` 且 `progress >= 1` 且 `chunk_count > 0` 时置 `ready` 并登记索引修订；`DONE` 但 chunk 数为 0 记为 `empty` 不算成功 | `tests/contract/ragflow-parse.test.ts` | 已通过（API 技术门） |
| M14 | 解析失败与超时终态 | API 技术门 | 上游 `FAIL` → 操作与知识版本进入终态 `failed` 且停止自动轮询；上游 `CANCEL` 同样终态失败；超过 `AIP_PARSE_DEADLINE_MS` 未完成 → 终态 `failed`（超时必须停止自动轮询，而不是一直「解析中」） | `tests/contract/parse-recovery.test.ts` | 已通过（API 技术门） |
| M15 | 审核记录落库与 CAS | API 技术门 | 审核后 `knowledge_review` 真实落库：审核人、`expected_hash`、理由、时间、有效期、适用条件；`expected_hash` 与当前内容不符 → 409；过期的 `state_revision` → 409；并发审核不会互相覆盖（CAS 生效）；`knowledge_revision` 上的 `valid_from`/`valid_until` 与审核记录同事务写入 | `tests/e2e/knowledge-review.test.ts` | 已通过（API 技术门） |
| M16 | 文档级授权检索 | API 技术门 | 只有被显式授予文档读取权的主体才能检索到该文档的证据；未审核通过、未索引就绪、已撤回的知识不进白名单；上游返回白名单之外的文档或数据集时整体失败（`RAGFLOW_PROTOCOL_ERROR`），不把越权内容放进响应 | `tests/contract/ragflow-authorization.test.ts` | 已通过（API 技术门） |
| M17 | 空授权零上游请求 | API 技术门 | 授权集合为空时返回 `no_match`，且**出口 RAGFlow 请求数为 0**（用记录式替身逐条计数断言，不靠日志推断） | `tests/contract/ragflow-empty-access.test.ts` | 已通过（API 技术门） |
| M18 | 授权白名单规模上限 | API 技术门 | 授权文档数超过 `AIP_RETRIEVAL_MAX_DOCUMENTS`（默认 200）→ 422 `AUTHORIZED_SCOPE_TOO_LARGE`；跨多个 dataset 的授权范围 → 422 并要求收窄请求 | `tests/contract/ragflow-whitelist.test.ts` | 已通过（API 技术门） |
| M19 | 上游故障处理 | API 技术门 | 上游不可用/超时/协议不符分别映射到 `RAGFLOW_UNAVAILABLE` / `RAGFLOW_TIMEOUT` / `RAGFLOW_PROTOCOL_ERROR`，不落到 500；只读调用在总预算内重试且不超出 `RAGFLOW_READ_BUDGET_MS`；写调用零自动重试 | `tests/contract/ragflow-unavailable.test.ts`（503/504）、`tests/contract/ragflow-authorization.test.ts`（502） | 已通过（API 技术门） |
| M20 | 授权撤销边界 | API 技术门 | 撤销后新发起的检索拿不到该文档；`authz_state` 行锁只覆盖本地末次授权判定与有界响应交付，不跨越上游网络调用与长下载流；测试明确断言「不承诺召回已发送字节」这一边界 | `tests/contract/acl-revocation.test.ts` | 已通过（API 技术门）—— 已断言「交付点前撤销生效」与「行锁不跨上游」；**已发送字节不召回**是显式不承诺的边界，写在 `docs/decisions.md` D7 与该测试文件头，不作为可断言项 |
| M21 | 引用来源与定位 | API 技术门 | 检索结果带 `source_locator`（`source_file_id`、`source_file_version`、`chunk_id`、`chunk_hash`）；无可核验位置时 `incomplete === true`，**不伪造页码**；证据快照落库并记录 `authz_revision` | `tests/e2e/citations.test.ts` | 已通过（API 技术门） |
| M22 | 作用域与访问限制 | API 技术门 | 令牌 scope 与路径 project 不一致 → 403；显式引用无权访问的知识 → 404（不泄露存在性）；显式引用未审核/未就绪的知识 → 409 `INDEX_NOT_READY`；下载来源文件需 `source:read` 且校验文档级下载授权 | `tests/contract/scope-limits.test.ts` | 已通过（API 技术门） |
| M23 | concept 契约校验（不得伪造成功） | API 技术门 | 含 `concept_ref` 的契约必须逐条经本体校验；本体未配置或不可达 → 拒绝（`ONTO_UNAVAILABLE` / `CONTRACT_INVALID`），**不得降级为通过**；本体返回 404 → 拒绝并指出该引用；无数值/概念契约的字符串契约可直接注册 | `tests/unit/concept-gate.test.ts` | 已通过（API 技术门） |
| M24 | 运行手册与配置项 | API 技术门 | 存在启动手册，命令与 `package.json` 脚本一致；环境变量清单与 `services/api/src/config.ts` 读取的变量名完全一致；示例值一律是占位符；密钥只从环境变量读取 | `docs/runbook.md`、`.env.example`、`deploy/compose.example.yaml`、`deploy/project-routing.example.conf` | 已通过（API 技术门） |
| M25 | OpenAPI 与实现一致 | API 技术门 | OpenAPI 3.1 描述与 `packages/contracts/src/**`、`services/api/src/**/routes.ts`、SQL 字段一致（含响应信封 `{data, trace_id}`、错误体 `{code, message, trace_id, details[]}`、审核有效期与 `content_hash`） | `openapi/aip-v1.yaml`、`tests/unit/asset-validate.test.ts` | 已通过（API 技术门）—— 逐条核对结果：16 条路径 / 19 个操作与路由一致（`POST /assets`、`POST /assets/{assetId}/versions`、`POST /knowledge-bases`、`POST /knowledge-bases/{kbId}/documents` 四个写入口都声明了必填的 `Idempotency-Key`）；50 个 schema，其中 21 个直接对应 `packages/contracts/src/**` 的接口，属性集合逐字段一致；21 个错误码枚举与 `packages/contracts/src/errors.ts` 完全一致（双向无差集）；响应信封一律 `{data, trace_id}`（列表额外带 `next_cursor`），错误体一律 `{code, message, trace_id, details[]}`；`knowledge_review` 的 `reviewer`/`expected_hash`/`reason`/`reviewed_at`/`valid_from`/`valid_until` 与 SQL 列一致。核对中发现并修复了两处偏差：① 实现可返回 413/503 的操作在规格里缺声明（已补齐 8 个操作）；② `/assets/validate` 在本体不可达时会报「校验通过」，已改为把失败落成问题项并补测 |
| M26 | 真实 RAGFlow 闭环 | 真实集成门 | 在真实 RAGFlow 上完成：建知识库 → 上传 → 解析 → 审核 → 检索 → 拿到带来源引用的证据 | `tests/real/closed-loop.test.ts`；替身版本 `tests/e2e/closed-loop.test.ts` | 已通过（真实集成门）—— 2026-10-24 在本地 RAGFlow v0.20.5（镜像 digest `sha256:d95d0e4d…`，嵌入模型 `BAAI/bge-large-zh-v1.5@BAAI`）上跑通：建库 → 上传 markdown → 上游解析 DONE 且 chunk_count=1 → 审核通过 → 检索返回 `authorized_evidence` 与来源引用。命令：`pnpm exec vitest run --config vitest.real.config.ts --reporter=verbose`，2 个文件 / 5 个用例全部通过。联调中发现并修复了上游真实行为与替身不一致的一处：上游「按名称列数据集」零命中时返回 code=108（PERMISSION_ERROR）而不是空数组，适配器按「未命中」处理（`services/api/src/ragflow/adapter.ts` 的 `parseEnvelopeAllowingEmptyNameLookup`），替身已同步该行为（`tests/helpers/ragflow.ts`），契约层新增对应断言（`tests/contract/ragflow-dataset.test.ts`） |
| M27 | 真实 RAGFlow 隔离失败 | 真实集成门 | 在真实 RAGFlow 上验证：无权文档不出现在检索结果中；上游返回白名单外文档时整体失败 | `tests/real/isolation-failure.test.ts` | 已通过（真实集成门）—— 2026-10-24 与 M26 同一轮联调通过：授权为空时真实上游请求数为 0；无权主体访问被拒主体得到 404 `NOT_FOUND`；无权文档不出现在真实检索结果中。命令与结果同 M26 |
| M28 | 密钥不落库不落日志 | API 技术门 | 上游密钥与令牌密钥不出现在任何持久化行（`asset_revision.payload`、`audit_event`、`operation.result`）与日志输出中；`config` 中出现 `api_key`/URL/嵌套 `password` 的资产注册被拒绝；错误响应不回显上游原文 | `tests/unit/security-no-secret.test.ts` | 已通过（API 技术门） |
| UI-01 | 最小前端流程与持久化 | UI 门 | 复用 onto console 与既有共享包，只新增本批页面：Skill/Agent 注册与查询、详情、版本与状态；知识库创建、文档上传、解析状态、审核、检索与引用 | — | 未做 —— **前置条件未满足**：UI 发布的前置条件是 ZACH-4 写完 **且** ZACH-5 的评审基线/变更边界明确，由 Mika 协调接入窗口。ZACH-4 / ZACH-5 处于 `in_review` **不等于** UI 已发布。本批只交付 API 与契约；页面未新增、未接入、未部署，也未改动 onto console 或任何共享包 |

---

## 2. 本批不具备的验收条件（缺项说明）

以下条件曾缺失，直接导致上表相应条目无法推进；已在本地补齐的条目注明了补齐时间与来源，仍缺失的保持原状：

| 缺失项 | 类型 | 影响条目 | 说明 |
| --- | --- | --- | --- |
| 真实 RAGFlow 环境与 API key | 环境 | M26、M27 | **已补齐（2026-10-24）**：本地 Docker Compose 栈 `deploy/ragflow/` 提供 RAGFlow v0.20.5；账号与 API Key 由 `deploy/ragflow/create-local-account.sh` 在本地签发，密钥只落在被 gitignore 的 `.env.api-key` 里。剩余边界：这是**本地开发环境**，不是生产环境，也不涉及付费模型 |
| RAGFlow 镜像 digest、契约来源摘要、嵌入模型名与修订号 | 配置 | M26、M27、`docs/ragflow-lock.md` 第 3 节 | **已锁定（2026-10-24）**：四项均取自本地栈实测值，见 `docs/ragflow-lock.md` 第 3 节与 3.1 |
| 本体（onto）概念服务可用的端点契约 | 契约 | 不影响 M23 的 API 技术门 | M23 的判据是「不可用即拒绝、不得伪造成功」，已用可控校验替身验证通过。真实本体联调仍需该契约，端点形态由 ZACH-4 / 后续 E1 冻结 |
| ZACH-4 写完 + ZACH-5 评审基线/变更边界明确 | 流程 | UI 门全部 | 页面本身复用 onto console 与既有共享包；接入窗口由 Mika 协调。ZACH-4 / ZACH-5 处于 `in_review` **不等于** UI 已发布 |
| 部署环境（compose / 路由）实际投产 | 部署 | M24 的落地部分 | 本批只交付示例文件（`deploy/compose.example.yaml`、`deploy/project-routing.example.conf`）与本地开发用的 `deploy/ragflow/`，**未投产、未改动任何权限** |

---

## 3. 支撑上表「已通过（API 技术门）/「已通过（真实集成门）」的真实执行结果

以下命令在本批交付的检出目录中**真实执行**，结果原样记录。

| 命令 | 结果 | 覆盖条目 |
| --- | --- | --- |
| `pnpm typecheck` | 三个包 + `tsc -p tsconfig.tests.json --noEmit` 全部通过，无输出错误 | M01–M28（测试树也受类型检查约束） |
| `pnpm test:unit` | 6 个文件 / 44 个用例全部通过 | M05、M12、M23、M25、M28 |
| `pnpm test:db` | 8 个文件 / 43 个用例全部通过 | M01–M04、M06–M09 |
| `pnpm test:contract` | 10 个文件 / 37 个用例全部通过 | M10、M11、M13、M14、M16–M20、M22 |
| `pnpm test:e2e` | 4 个文件 / 24 个用例全部通过 | M12、M15、M21、M26（替身闭环） |
| `pnpm test:ragflow:real` | 2 个文件：2 个通过、3 个跳过（NOT RUN） | M26、M27 —— 未启用真实环境时按约定报告 NOT RUN |
| `RUN_REAL_RAGFLOW=1 pnpm test:ragflow:real` | 非零退出，报错列出缺失配置项名称 | M26、M27 —— 证明「没跑」不会被记成「跑通」 |
| `pnpm exec vitest run --config vitest.real.config.ts --reporter=verbose`（真实环境已配置：本地 RAGFlow v0.20.5） | 2 个文件 / 5 个用例全部通过 | **M26、M27 —— 真实集成门已通过**（2026-10-24） |

数据库层与端到端层需要 PostgreSQL。开发期使用独立的 `aip-test-postgres` 实例
（127.0.0.1:55433，独立库与独立角色），**不接触** onto / Multica / RAGFlow-ES 的任何数据库。

---

## 4. 状态维护规则

- 状态只允许上表的四个取值，不得出现「基本完成」「大部分可用」这类模糊表述。
- 任何一条从「未做」变为「已通过（API 技术门）」时，必须同时给出**真实的测试命令与执行结果**；
  源码存在不等于测试通过。
- 任何一条从「未验收（缺真实环境）」推进时，必须同时给出真实联调的**命令、配置项名称与结果**，
  并把 `docs/ragflow-lock.md` 第 3 节的未锁定项填成真实值。
- 真实集成结果与替身测试结果**分开汇报**，不得合并成一个「通过」。
