# 原 M01–M28 验收覆盖表（按 ZACH-8 冻结矩阵编号）

本表按 **ZACH-8《可判定验收矩阵》的原编号** 逐条给出判据、证据与状态。
编号沿用矩阵原文，不做重编号：原 **M24 = UI 注册页**、原 **M25 = UI 知识页**、
原 **M26 / M27 = 真实 RAGFlow 集成**、原 **M28 = 构建期密钥扫描**。
运行手册与 OpenAPI 一致性检查另编为 **DOC-01 / DOC-02**（见第 2 节），**不占用 M 编号**。

> 上一版本文档曾把「运行手册与配置项」写成 M24、「OpenAPI 与实现一致」写成 M25，
> 与冻结矩阵不符（被 ZACH-10 审查指为擅自重编号）。本版已按原编号复位。

状态取值与口径：

- `FULL` —— 矩阵该行的全部必需判据都有**真实执行**的自动化断言支撑。
- `PARTIAL` —— 有断言覆盖，但仍有判据缺覆盖或只覆盖了替代路径；缺口逐条写在「限制」列。
- `NOT RUN` —— 该门在本仓库没有可执行对象，或缺少必需环境，**不以替身结果顶替**。

> 替身（RAGFlow 记录式替身，`tests/helpers/ragflow.ts`）只支撑 API 技术门。
> **替身通过 ≠ 真实集成通过**，两者的结果在第 5 节分开汇报。

---

## 1. M01–M28 覆盖表

| 编号 | 验收点 | 门 | 判据（矩阵原文摘要） | 证据（`file:line`） | 状态 |
| --- | --- | --- | --- | --- | --- |
| M01 | 迁移账本与约束 | API 技术门 | 全新隔离库迁移；台账 checksum = sha256(文件)；第 3 个迁移失败不留成功记录、重跑不重复；复合 FK 与唯一约束真实存在于 `pg_constraint`；已写入的版本载荷与哈希不可被改写 | `tests/db/migrations.test.ts:27`、`:48`、`:67`、`:104`、`:128`、`:161`；冻结列补齐：`tests/db/revision-immutability.test.ts:62`、`:71`、`services/api/src/db/migrations/007_revision_immutability.sql`；**应用角色无 DDL、迁移角色可改结构、API 真的以应用角色运行**：`tests/db/app-role-separation.test.ts:107`、`:120`、`:135`、`:150`、`:166`；**009→010 升级路径**：`tests/db/migration-upgrade.test.ts:46`、`:96` | FULL |
| M02 | 多租户数据隔离 | API 技术门 | 同名 slug 跨项目并存；A 令牌访问 B 路径 403 / B 资源 404；A 账号连不上 B 库；**缓存 / 文件路径 / operation 不串用** | `tests/db/isolation.test.ts:99`、`:122`、`:131`、`:149`、`:159`、`:170`、`:196`、`:222`；**显式 admin/app 实例配置与实例身份校验**：`tests/helpers/test-instance.ts:52`、`:70` | FULL |
| M03 | Skill 注册与查询 | API 技术门 | 201 + 稳定哈希 + 正文/元数据一致；重启后 GET 同载荷同哈希同状态；分页 `limit` + `next_cursor`；无发布/执行副作用 | `tests/db/registry.test.ts:25`、`:58`、`:83`、`:118` | FULL |
| M04 | 并发注册与幂等 | API 技术门 | 20 并发同 slug/version → 1×201 + 19×409；同键同体重放原资源，同键异体 409 且旧正文不变；不静默创建 1.0.1；**同键跨资产必须各自成立** | `tests/db/registry-concurrency.test.ts:25`、`:74`、`:116`、`:140`；跨资产：`tests/db/idempotency-scope.test.ts:38`、`:85`、`:122` | FULL |
| M05 | 版本号校验与体积上限 | API 技术门 | 8 种非法版本 422 定位 `version`；缺正文 422 定位 `payload.content`；正文 >256KiB 413；载荷 >512KiB 413；非法请求不落库；正文外 URL 不被抓取；**本机路径内容入口被拒且不读本地文件** | `tests/unit/versions.test.ts:26`（8 种版本参数化）、`:45`、`:65`、`:86`、`:107`、`:126`、`:148`；内容入口：`tests/unit/upload-boundaries.test.ts:72`、`:109` | FULL |
| M06 | Agent 绑定固定 Skill 版本 | API 技术门 | 发布 1.0.1 后绑定仍指向 1.0.0；绑定两端 ≥2 个外键；绑定行只有 1.0.0；**依赖详情显示准确版本 / 哈希** | `tests/db/agent-binding.test.ts:30`、`:85`、`:137`、`:149` | FULL |
| M07 | 无效引用拒绝 | API 技术门 | 缺版本 / 畸形版本 / 不存在 / Agent 当 Skill / 已撤回 / 重复引用 / 跨作用域与不存在错误全等；失败不留半截行 | `tests/db/agent-invalid-reference.test.ts:80`、`:87`、`:99`、`:108`、`:117`、`:126`、`:139`、`:166` | FULL |
| M08 | 绑定权限与不启动执行 | API 技术门 | 只有 `asset:write` → 403 指 `asset:bind`；有 bind 无 read → 403；不可下放权限 → `CONTRACT_INVALID`；未持有的可下放权限 → `PERMISSION_ESCALATION`；config 中密钥/URL/嵌套 password → 拒绝；`execution_enabled=true` → 拒绝；注册不产生执行任务、无 `/run` 端点；**秘密不入库、不入日志、不回显** | `tests/db/agent-permission.test.ts:38`、`:54`、`:70`、`:90`、`:110`、`:177`、`:196`、`:216` | FULL |
| M09 | 状态机与并发竞态 | API 技术门 | 注册与撤回线性化；撤回后新绑定被拒；旧 `state_revision` → 409；`revoked` 是终态 | `tests/db/status-race.test.ts:26`、`:83`、`:113`、`:142` | FULL |
| M10 | RAGFlow dataset 契约 | API 技术门 | 202 + 操作号；成功才落 dataset 映射；业务失败 / 缺 `data.id` / 上游 401 三类失败结论**互相可区分**且不落映射、不进 ready；丢响应 → `unknown_outcome` 且只发一次 POST | `tests/contract/ragflow-dataset.test.ts:24`、`:54`、`:80`、`:106`、`:132`；失败可区分：`tests/contract/dataset-negative-cases.test.ts:88`、`:102`、`:117`、`:131`、`:158`；**核对用的 GET 失败不得授权另一次 POST**：`tests/db/review-recovery.test.ts:96` | FULL |
| M11 | RAGFlow 上传契约 | API 技术门 | 单个 `file` 字段 multipart；`data` 长度 1 且 dataset 匹配；**来源 sha256 落库**；协议错误即失败；丢响应 → `unknown_outcome` 且不盲重传 | `tests/contract/ragflow-upload.test.ts:25`、`:52`、`:78`、`:98`；完整性：`tests/contract/upload-integrity.test.ts:28`、`:55`；**解析未送达时只重试解析、不重复上传**：`tests/db/review-recovery.test.ts:118`；**同名不同来源不得被认领**：`tests/db/review-recovery.test.ts:158` | FULL |
| M12 | 上传限制 | API 技术门 | 20MiB 边界「恰好等于上限被接受」；超 1 字节 413；扩展名/MIME/伪 PDF/损坏 UTF-8/`../` 被拒；**两文件、压缩包被拒**；**非法请求 RAG 全 HTTP 为 0**；**无目录穿越与残留未引用文件** | `tests/unit/upload-limits.test.ts:26`–`:166`；`tests/e2e/upload-security.test.ts:46`–`:131`；边界：`tests/unit/upload-boundaries.test.ts:28`、`:38`、`:54`；残留与两文件：`tests/contract/upload-rejections.test.ts:81`、`:102`、`:123`、`:147`；**HTTP 层真实 20MiB 上限（恰好等于上限被接受、超 1 字节 413）**：`tests/e2e/upload-limit-real.test.ts:36`、`:57` | FULL |
| M13 | RAGFlow 解析状态契约 | API 技术门 | `code 0` 不立即 ready；DONE + 进度完成 + chunk_count>0 才 ready 并登记 index_revision；FAIL/CANCEL 可见错误；DONE+0 → empty；**`run` 为 `"0".."4"` 字符串、缺 `run`、`run=null`、未知值均按实现分支判定** | `tests/contract/ragflow-parse.test.ts:29`、`:49`、`:68`、`:88`、`:107`；分支：`tests/contract/parse-status-branches.test.ts:104`、`:113`、`:122`、`:130`、`:143`、`:151`、`:159`、`:169`、`:179` | FULL |
| M14 | 解析恢复与栅栏 | API 技术门 | Worker 解析中退出后重启**续跑同一 doc、不得新上传**；两个 worker 抢同一 operation 只有一个拿到租约；**旧 epoch 迟到写入被拒**；20 分钟未完成 → 终态 timeout 且停止自动轮询；**用户 GET 返回 stale 标记而不是「无匹配」** | 重启续跑与栅栏：`tests/db/operation-fencing.test.ts:231`、`:263`、`:54`、`:68`、`:120`；超时终态：`tests/contract/parse-recovery.test.ts:26`；stale 标记：`tests/e2e/knowledge-stale.test.ts:25`、`:49`；**轮询用的 GET 失败不得重新触发已确认的重建**：`tests/db/review-recovery.test.ts:138` | FULL |
| M15 | 审核与撤回四态 | API 技术门 | 未审 / 拒绝 / 批准 / 撤回四态；审核记录落库（审核人、`expected_hash`、理由、时间、有效期）；哈希不符 409；并发 CAS 409；无 `knowledge:review` → 403；**拒绝态不可检索**；**撤回本地立即拒绝召回 / 下载，远端删索引未完成也不可召回**；撤回登记 `knowledge.withdraw` 操作并推进到终态 | `tests/e2e/knowledge-review.test.ts:41`、`:89`、`:108`、`:157`、`:170`、`:188`、`:216`、`:234`；撤回全链路：`tests/e2e/withdraw.test.ts:68`、`:81`、`:92`、`:121`、`:131`、`:158`、`:162`、`:177`、`:188`；**撤回是终态、迟到的完成与失败都不能复活版本、撤回取消在途操作**：`tests/db/knowledge-withdraw-terminal.test.ts:70`、`:102`、`:132`、`:177` | FULL |
| M16 | 授权检索与来源引用 | API 技术门 | 401 / 403 语义正确；**无 `knowledge:read` → 403 且上游 0 请求**；**文档详情按权限鉴权**；**请求体自带 actor 无效**；越权回包整体失败；显式不可见资源 404 | `tests/contract/scope-limits.test.ts:29`、`:35`、`:45`、`:54`、`:65`、`:82`、`:95`；`tests/contract/ragflow-authorization.test.ts:91`、`:134`；补充：`tests/contract/retrieval-authz.test.ts:33`、`:60`；`tests/contract/audit-and-log-hygiene.test.ts:56` | FULL |
| M17 | 空授权零上游请求 | API 技术门 | 有项目读权限但无文档授权 → `no_match` + `evidence=[]` + **全部 HTTP 调用数 0**；缺上下文 → `needs_context` + 0 调用；**授权集合里只剩已撤回知识 → `no_match` + 0 调用** | `tests/contract/ragflow-empty-access.test.ts:29`、`:47`、`:73`；撤回集合：`tests/contract/withdrawn-access.test.ts:50`、`:81`、`:106` | FULL |
| M18 | 检索白名单 | API 技术门 | 上游只允许精确 docA + 所属 dataset；**客户端混传有权/无权引用 → 404 且不泄露**；**上游 200 但 `code != 0` / 结构不符 → 整体失败**；**metadata 不能替代 ID 限制**；越权回包整体 502 | `tests/contract/ragflow-authorization.test.ts:30`、`:91`、`:134`；补充：`tests/contract/retrieval-authz.test.ts:77`、`:101`、`:129`、`:156` | FULL |
| M19 | 上游故障与重试预算 | API 技术门 | 读最多 3 次、总预算 ≤ 生产默认 30s；最终 503/504 且 trace 可查；429 与 `Retry-After` 退避；**连接被拒（确定未送达）可安全重试**；**写响应丢失只发一次并进入 `unknown_outcome`**；**总预算真正约束等待（上游不回包也必须超时退出）**；**不泄漏 key / 上游原文 / 文件正文** | `tests/contract/ragflow-unavailable.test.ts:46`、`:72`；`tests/contract/ragflow-retry.test.ts:143`、`:172`、`:200`、`:225`、`:268`、`:303`、`:346`、`:381`、`:437`；总预算兜底：`tests/unit/ragflow-timeout.test.ts:33`；生产默认：`tests/unit/config-defaults.test.ts:33`；**读失败与写失败分开处置（读失败不得清掉写请求的发送意图）**：`tests/db/review-recovery.test.ts:96`、`:118`、`:138` | FULL |
| M20 | 授权撤销边界 | API 技术门 | 上游调用期间撤销 → 交付前重查后丢弃已失权内容；**撤销提交后新请求也不可用旧 ACL**；**下载同查**；不持 PG 锁跨网络 | `tests/contract/acl-revocation.test.ts:34`；`tests/contract/download-revocation.test.ts:55`、`:61`、`:89`；`tests/contract/withdrawn-access.test.ts:50`；`tests/e2e/citations.test.ts:164`；**在途下载撤权 / 撤回已提交且未发正文时必须拒绝**：`tests/db/review-recovery.test.ts:180`、`:218` | FULL |
| M21 | 来源引用与证据 | API 技术门 | 证据带 knowledge/index/source 版本 + `chunk_hash` + score；无页码标 `incomplete` 不伪造；**索引重建后旧 evidence 仍可读**；**来源下载 sha256 与原文件实际哈希一致**；实时权限可拒绝 | `tests/e2e/citations.test.ts:39`、`:70`、`:92`、`:119`、`:133`、`:164`；重建：`tests/e2e/index-rebuild.test.ts:57`、`:67`、`:110`、`:120`、`:126`；下载一致性：`tests/contract/upload-integrity.test.ts:73`；**远端文档名带来源标识（来源与索引不错配）**：`tests/db/review-recovery.test.ts:158`、`tests/db/crash-window-recovery.test.ts:130` | FULL |
| M22 | 作用域与访问限制 | API 技术门 | 显式无权 → 404；显式有权但未 ready → 409 `INDEX_NOT_READY`；**授权文档数超过上限 → 422 且 0 上游请求**；**201 个可授权文档按真实阈值在边界拒绝**；**多 dataset 越界 → 422**；**`top_n` 越界 → 422** | `tests/contract/scope-limits.test.ts:110`、`:128`、`:144`；`tests/contract/ragflow-whitelist.test.ts:26`；真实阈值：`tests/contract/retrieval-document-count.test.ts:27`、`:45`（生产默认 200 见 `tests/unit/config-defaults.test.ts:55`）；多 dataset 与 `top_n`：`tests/contract/retrieval-limits.test.ts:32`、`:53`、`:69`、`:83`、`:103` | FULL |
| M23 | 概念契约校验门 | API 技术门 | 无概念引用的字符串契约注册成功且校验器未被调用；数值契约缺概念引用 → 422；本体不可达 → 503 `ONTO_UNAVAILABLE` 且不降级成功；概念不存在 → 422 并指出引用；**详情标 `concept_validation='not_requested'`** | `tests/unit/concept-gate.test.ts:66`、`:84`、`:119`、`:149`、`:180`、`:217`、`:246`、`:275`；详情标记：`tests/contract/retrieval-limits.test.ts:124` | FULL |
| **M24** | **UI 注册页（`ui/registration.spec.ts`）** | **UI 门** | 列表空/加载/错误/403、直接深链、表单 `field_path`、注册 409、版本选择、binding 失效明显可见 | **本仓库无前端代码、无 `tests/ui/`、无 Playwright、无 `test:platform` 脚本** → 全部无覆盖 | **NOT RUN** |
| **M25** | **UI 知识页（`ui/knowledge.spec.ts`）** | **UI 门** | pending/parsing/failed/ready 四态、审核、`no_match`/`needs_context`/503、来源缺定位、密钥不入浏览器请求/storage/bundle、401/切项目清理结果 | **同 M24，全部无覆盖** | **NOT RUN** |
| **M26** | **真实 RAGFlow 闭环** | **真实集成门** | 全步骤真实可追踪，引用指向上传原文并有可核验摘要；真实报告含版本/digest/来源证据；任何 mock 替代判失败 | **本 SHA 未执行**：真实栈与凭据归 ZACH-9，本轮没有可用的真实 RAGFlow 凭据（`pnpm test:ragflow:real` 报 NOT RUN，`pnpm test:ragflow:real:guard` 非零退出）。PR2 在 `8993b86` 上的真实证据（`ragflow.source_sha=e650f0d368b357b0b434b7838177435e3d217de3`、`image_digest=sha256:d95d0e4dc83a96fafffc5238f15c9192ed76ef2d320adb516f010bdc9876455a`、`embedding_revision=79e7739b6ab944e86d6171e44d24c997fc1e0116`、`counts.pass=5`）**不迁移**到本 SHA：本轮改了上传远端名与下载交付路径，旧栈报告证明不了新语义。组合验收需在最终 SHA 上重跑 | **NOT RUN** |
| **M27** | **真实 RAGFlow 隔离失败** | **真实集成门** | 真实检索不返回未授权文档；无授权请求 0；真实不可达 503/504；解析失败保持 failed；目标解析失败不可稳定复现时明确 NOT RUN 而非用 mock 记真实通过 | **本 SHA 未执行**（同 M26：无真实凭据，真实栈与执行归 ZACH-9）。`8993b86` 上的真实证据同样不迁移；组合验收需在最终 SHA 上重跑 | **NOT RUN** |
| M28 | 密钥不落库不落日志 | API 技术门 | 8 张持久化表内无上游 key / DB URL / token；带 `api_key` 的 config 被拒；嵌套 password 与 URL 被拒；上游错误原文不回显；**构建产物扫描无密钥形态**；**日志快照不含敏感内容**；**动态出口 `base_url` 被拒**；**重定向不泄漏 key**；**审计 subject 来自可信 principal** | `tests/unit/security-no-secret.test.ts:47`、`:58`、`:80`、`:105`；构建产物：`tests/unit/secret-scan.test.ts:72`、`:79`、`:86`、`:104`；日志与审计：`tests/contract/audit-and-log-hygiene.test.ts:27`、`:56`、`:76`、`:99`；动态出口：`tests/db/config-policy.test.ts:83`、`:119`、`:137`；重定向：`tests/unit/redirect-key-leak.test.ts:66` | FULL |

**统计：FULL 24 条（M01–M23、M28）／PARTIAL 0 条／NOT RUN 4 条（M24、M25、M26、M27）。**

> M24 / M25 的 NOT RUN **不是本轮降级**：这两项在 ZACH-8 冻结矩阵里属于 UI 门，
> 其交付物不在本仓库（UI 归 ZACH-11）。
> M26 / M27 的 NOT RUN 是**本 SHA 没有真实凭据**：真实栈与执行归 ZACH-9，
> 且 `8993b86` 上的真实证据不迁移到本 SHA（本轮改了上传远端名与下载交付路径）。
> 组合验收需要在最终组合 SHA 上重新执行真实层。
> 本轮不提供替身结果冒充，也不把「无代码」写成「已通过」。

---

## 2. 另行编号的文档与契约检查（不占用 M 编号）

| 编号 | 检查项 | 判据 | 证据 | 状态 |
| --- | --- | --- | --- | --- |
| DOC-01 | 运行手册与配置项一致性 | `docs/runbook.md`、`.env.example` 与 `config.ts` / `main.ts` / `migrate.ts` / worker 实际读取的环境变量一致 | `docs/runbook.md`、`.env.example`；读取点：`services/api/src/config.ts:109`、`services/api/src/main.ts:16`、`:78`、`services/worker/src/main.ts:14`–`:16`（**本轮未新增自动化断言**，见第 4 节限制） | PARTIAL |
| DOC-02 | OpenAPI 与实现一致 | 错误码枚举与契约层双向相等；每个操作声明已知权限；`operationId` 唯一且非空；`$ref` 全部可解析；文档路径集合与实际注册路由集合完全相等；每个文档路径在运行期命中路由 | `tests/contract/openapi-consistency.test.ts:108`、`:114`、`:130`、`:143`、`:151`、`:158`；`openapi/aip-v1.yaml` | FULL |

---

## 3. 本轮缺陷 → 修复 → 回归证据

| 编号 | 缺陷（来源） | 修复 | 回归证据 |
| --- | --- | --- | --- |
| B-1 | 幂等键跨资产静默重放：同一 `Idempotency-Key` + 同一请求体打到资产 A 与资产 B，第二次返回 A 的 `asset_id`，目标版本从未创建（ZACH-10 R-1） | 幂等身份纳入目标资产：版本创建的 operation key 为 `assets.new_version:${assetId}` | `tests/db/idempotency-scope.test.ts:38`、`:85`、`:122` |
| B-2 | 写请求响应丢失时没有 `unknown_outcome`，会盲目重发写请求 | 写响应丢失 → 操作进入 `unknown_outcome`，不重发，资源状态不再停在 `creating` | `tests/db/operation-fencing.test.ts:195`；`tests/contract/ragflow-dataset.test.ts:179`；`tests/contract/ragflow-upload.test.ts:98`；`tests/contract/ragflow-retry.test.ts:225` |
| R-1（真实集成门发现） | RAGFlow v0.20.5 的「按名称列数据集」在零命中时返回 `code=108`（PERMISSION_ERROR），与「数据集存在但不属于本租户」同码。适配器把它当成业务失败：写操作的结果未知核对直接判 `failed`（真实联调时表现为建库失败） | 按名称核对的响应单独处理：108 视为「未命中」，结果未知的路径据此保持 `unknown_outcome` 并转人工核对，不判失败、不重发写请求 | `tests/contract/ragflow-dataset.test.ts:132`（临时回退该修复后用例立即失败：操作状态由 `unknown_outcome` 变为 `failed`）；替身与上游同语义：`tests/helpers/ragflow.ts`；上游语义与版本证据：`docs/ragflow-lock.md` §1.1 陷阱 9、§2.2 |
| B-3 | 终态失败时资源状态不回滚（`knowledge_base.status` 停在 `creating` / `knowledge_revision.status` 停在 `parse_queued`），人工无法从资源侧判断原因 | 操作进入终态时同步回落 `knowledge_base.status` / `knowledge_revision.status`，并让 `operation.last_error` 与之对齐 | `tests/db/operation-fencing.test.ts:163`；`tests/e2e/knowledge-stale.test.ts:25` |
| M-1 | epoch fencing 未接线：`bumpEpoch` 无调用点，`setOperationState` 的 `expectedEpoch` 从未传入 | 领取操作即 `epoch + 1`；所有状态写入以 `WHERE epoch = $n` 条件化；迟到旧 epoch 一律被 DB 拒绝 | `tests/db/operation-fencing.test.ts:68`、`:120` |
| M-2 | 租约时长 ≤ 只读总预算，同一操作可被两个 worker 同时推进 | 租约默认值 > 上传超时 + 只读预算 + 余量；配置过短直接在启动时拒绝 | `tests/unit/config-defaults.test.ts:39`、`:49`；`tests/unit/operation-lease.test.ts:25`、`:32`、`:38` |
| M-3 | DB 层不可变触发器漏掉 `title` / `description`，`content_hash` 可与所存内容脱钩 | 新增迁移 `007_revision_immutability.sql`：冻结列补齐，并约束 `registration_status` 迁移与 `state_revision` 递增 | `tests/db/revision-immutability.test.ts:62`、`:71`；`tests/db/migrations.test.ts:128` |
| M-4 | config 密钥/URL 黑名单用未锚定子串匹配（误杀 `max_tokens`），同时漏掉 `private_key` / `authorization` 等常见密钥名 | 改为整键精确匹配 + 词边界匹配 + 密钥形似值启发式；`model_profile_ref` 只允许标识符形态；详情接口二次脱敏 | `tests/db/config-policy.test.ts:83`、`:119`、`:137`；`tests/unit/security-no-secret.test.ts:58`、`:80` |
| M-5 | 未受控 UUID 直达 PostgreSQL 类型转换 → 500（ZACH-10 R-2/R-3/R-4） | `kb_ids` / `knowledge_refs` 加 `format:'uuid'`；路径 UUID 参数做格式校验；DB 错误 `22P02` 映射为 400 | `tests/contract/invalid-identifier.test.ts:38`、`:49`、`:64`；`tests/unit/database-errors.test.ts:8` |
| M-6 | 没有文档级授权 API，权限只能靠项目级推断 | 新增文档级授权 API（授予 / 列出 / 撤销）与迁移 `009_audit_detail.sql` 的审计明细列 | `tests/db/document-grant-api.test.ts:63`、`:70`、`:81`、`:99`、`:110`、`:126`、`:162`、`:172` |
| M-7 | 本体网络调用发生在数据库事务内，长时间占用连接与行锁 | 注册与建版本前先做本体校验，事务内不再发起网络调用 | `tests/db/ontology-outside-transaction.test.ts:60`、`:73` |
| M-8 | 撤回后来源文件仍可下载，与矩阵「撤回本地立即拒绝下载」冲突 | 下载路径增加知识版本终态判定：`withdrawn` 一律 404，不等上游删索引完成 | `tests/e2e/withdraw.test.ts:188` |
| M-9 | 没有 `reports/<sha>/<mode>/` 证据产物 | 新增 Vitest reporter（`tools/report/reporter.ts`、`tools/report/context.ts`）与运行期事实采集（`tests/helpers/report-setup.ts`），产出 `summary.json` / `cases.json` / `.trace.jsonl` | 见第 4 节 |
| M-10 | 实现中不存在索引重建概念，重建后旧 evidence 指向的索引修订失效 | 新增迁移 `008_index_rebuild.sql`（同一上游文档允许多份索引修订映射）与重建接口 | `tests/e2e/index-rebuild.test.ts:57`、`:67`、`:110`、`:120`、`:126`、`:156`、`:171` |
| R1（934eb06 复审） | **恢复用旧进度**：失败处理始终拿入口处的旧快照回写，把本轮已确认的前序步骤（上传成功、解析已触发）覆盖掉；且把「核对用的 GET 连不上」当成「之前的 POST 没送达」，清掉发送意图后重发写请求 | ① 失败处理在 epoch 围栏内重读数据库里的最新持久检查点，不再回写旧快照；② 只读核对与写请求分开标记：核对失败只能延后核对，绝不清掉任何写请求的发送意图；③ 只有「这个写请求自己连接都没建立」才允许清掉它自己的发送意图 | `tests/db/review-recovery.test.ts:96`（核对 GET 失败 → 创建次数 0）、`:118`（解析重试 → 上传仍 1 次）、`:138`（轮询 GET 失败 → 重建触发仍 1 次） |
| R2（934eb06 复审） | **上传恢复只凭用户文件名认领**：同一个知识库里两份同名不同正文的文件，恢复时把另一份来源的旧文档认成这次的上传，来源与索引错配 | 首次发送前把由来源标识派生的唯一远端文档名与发送意图在同一次写入里落库；恢复按这个唯一身份核对；显示名仍然是用户文件名 | `tests/db/review-recovery.test.ts:158`（同名不同来源 → `unknown_outcome`，不认领旧文档）、`tests/db/crash-window-recovery.test.ts:130`（唯一名命中仍可认领） |
| R3（934eb06 复审） | **在途下载的授权复核缺口**：权限在文件读取前判定，读取期间发生撤权或撤回时，已提交且尚未发出正文仍返回 200 | 文件读取在事务外完成，读取之后、交付之前再做一次末次授权判定（撤回状态、读授权、下载授权）；文件 I/O 期间不持锁 | `tests/db/review-recovery.test.ts:180`（读取期间撤权已提交 → 404）、`:218`（读取期间撤回已提交 → 404） |
| R4（934eb06 复审） | **M02 测试硬编码 55433 管理连接**：忽略 `AIP_TEST_DATABASE_URL`，在既有共享实例上建角色建库；两个项目其实仍共用同一连接串 | 管理连接改为显式配置（`AIP_TEST_ADMIN_DATABASE_URL`），启动时校验实例身份（回环地址 + 专用管理库名 + 落库一致 + 实例上没有共享的应用测试库）；两个项目的 API 各自以自己的应用角色连自己的库 | `tests/helpers/test-instance.ts:52`、`:70`；`tests/db/isolation.test.ts:42`、`:70`、`:170` |
| M-19（新发现） | 只读总预算不约束等待：`nodeTransport` 的读计时器只在收到响应头后建立，上游接受连接却一直不回包时连接计时器已清除、读计时器未创建，整次调用无限挂起 | 传输层新增**单次尝试的总时间上限计时器**（`attemptTimeoutMs`），到期强制销毁请求；连接阶段超时仍归 `not_delivered`，已连接未回包归 `delivered_unknown`；复用 keep-alive 连接时立即清除连接计时器 | `tests/unit/ragflow-timeout.test.ts:33`（上游接受连接但不回包 → 预算内结束）；既有重试用例 `tests/contract/ragflow-retry.test.ts:143`–`:437` 未回归 |
| 安全-高 | 高风险密钥（`private_key` / `signing_key` / `authorization` / `passphrase` 等）可随 config 落库并被原样读回 | 密钥形似值识别 + 写入拒绝 + 读取脱敏 | `tests/db/config-policy.test.ts:83`、`:137`；`tests/unit/security-no-secret.test.ts:47` |
| 安全-中 | 令牌声明多个 scope 时按首元素放行 | 显式拒绝多 scope 令牌（403），不扩大授权语义 | `tests/contract/scope-limits.test.ts:65` |
| 安全-低 | 构建产物与日志没有密钥扫描 | `tests/unit/secret-scan.test.ts` 扫描 dist（缺失时退回 src），并带规则自检用例 | `tests/unit/secret-scan.test.ts:86`、`:104` |

---

## 4. 报告产物（`reports/<sha>/<mode>/`）

每层测试运行都会在 `reports/<git-sha>/<mode>/` 下产出（生成器：`tools/report/context.ts`、`tools/report/reporter.ts`；接线：`vitest.shared.ts`）：

- `summary.json` —— 本次运行的元数据：commit、是否 dirty、`changed_tracked` / `untracked`、`dependency_lock_hash`（sha256 of `pnpm-lock.yaml`）、逐个迁移文件的 sha256 与 `migration_set_hash`、RAGFlow tag / source_sha / image_digest（real 层取自环境变量，其余层记 `mock`）、`embedding_revision`、`parser_digest`、部署环境（platform / arch / release / cpu / node / ci）、用例计数（modules / cases / pass / fail / not_run）、`unhandled_errors`、`run_end_reason` 与哈希口径说明。
- `cases.json` —— 逐用例记录：状态（PASS / FAIL / NOT RUN）、文件、耗时、断言条数、涉及的主体角色、`trace_id` 列表、请求样例哈希与其口径、失败原因。
- `.trace.jsonl` —— 运行期事实流（断言计数、请求事实），由 reporter 合并进 `cases.json`。

> `reports/` 按仓库既有约定在 `.gitignore` 中，产物不入库；生成器与接线代码入库，任何复核人都能按同样的命令重新生成。
> 真实集成层（`real`）的产物只有在配置齐备并真实执行后才具备 `ragflow` / `embedding_revision` 的真实值。
> **本 SHA 的 real 层没有真实执行**：缺真实凭据，报告如实记 `not_run`，
> `ragflow.source_sha` / `image_digest` / `embedding_revision` 为 null。
> `8993b86` 上曾有真实执行（`counts.pass=5`），但那是旧 SHA 的证据，不迁移到本 SHA。

---

## 5. 限制与未完成项（逐项说明，不把结论降级为通过）

| 项 | 限制 | 原因 |
| --- | --- | --- |
| M24 / M25 | **NOT RUN** | 本仓库无前端代码、无 Playwright、无 `test:platform` 脚本。UI 门由 ZACH-11 交付；本轮不产出 UI 结论，也不以文档检查顶替。 |
| M26 / M27 | **NOT RUN（本 SHA）** | 本轮没有可用的真实 RAGFlow 凭据：真实栈与执行归 ZACH-9。`pnpm test:ragflow:real` 报 NOT RUN，`pnpm test:ragflow:real:guard` 非零退出并列出缺失配置名——门禁按预期拦住了「没跑当跑通」。`8993b86` 上的真实证据不迁移：本轮改了上传远端名与下载交付路径，真实层必须在最终组合 SHA 上重跑。 |
| M26 / M27 的替身层覆盖 | 替身层覆盖「真实不可达 503/504」「解析失败保持 failed」 | `tests/contract/ragflow-unavailable.test.ts:72`、`tests/contract/ragflow-parse.test.ts:68`。替身结果不顶替真实集成证据，只说明代码路径在替身下可判定。 |
| DOC-01 | 仍为**人工核对**，无自动化断言 | 环境变量清单分散在 `config.ts`、`main.ts`、`migrate-cli.ts` 与 worker 入口，缺少单一事实来源；本轮未引入配置清单生成器。 |
| M-3 的两阶段幂等 | **未实现**（有意保留现状） | 把幂等占位行移出业务事务会破坏 M04 依赖的「同键并发等待」语义。本轮按已确认的设计决策保留事务内占位，并在 `tests/db/idempotency-scope.test.ts` 固定其对外语义。 |
| M14 的真实 20 分钟解析路径 | 只在替身层用缩短的截止时间验证终态 | 真实等待 20 分钟无收益；生产默认值本身由 `tests/unit/config-defaults.test.ts:23` 钉死（20 分钟），超时终态行为由 `tests/contract/parse-recovery.test.ts:26` 覆盖。 |
| M19 的「总预算 ≤30s」 | 用缩短预算跑同一代码路径 | 30 秒的墙钟等待不产生额外信息；生产默认值由 `tests/unit/config-defaults.test.ts:33` 断言（30 秒 / 3 次），预算切分与兜底超时行为由 `tests/contract/ragflow-unavailable.test.ts:72`、`tests/contract/ragflow-retry.test.ts:178` 与 `tests/unit/ragflow-timeout.test.ts:33` 覆盖。 |
| M19 的「送达未知 / 未送达」可观测性 | 只读路径上两者结论相同（均 `in_progress`） | 「已送达 / 未送达」的差异只在写路径有可判别后果（`unknown_outcome` vs 可重试）；只读路径两者都允许重试，因此不额外暴露内部差异。 |
| 幂等键跨资产的**并发**交错 | 覆盖了「同键跨资产各自成立」与「同资产同键重放 / 异体冲突」 | 未构造两个资产同时用同一键并发写入的交错时序；现有断言覆盖该缺陷的复现路径（跨资产串读）。 |
| M01 / M02 的实例级用例 | 需要显式的 `AIP_TEST_ADMIN_DATABASE_URL`；未配置时整组用例标记为 NOT RUN | 这两组用例要在数据库实例上建角色建库。没有显式指定专用实例就不能跑：宁可记 NOT RUN，也不落到共享实例上伤人。复核人可按 `docs/runbook.md` 第 6 节起一个一次性实例后重跑。 |
| M14 的「真实 kill 进程」 | 恢复用持久状态重建（租约接管）验证，不是真的杀进程 | 杀进程会引入不可复现的时序，且杀不掉数据库里的租约语义。租约、epoch 与「不重复上传」的语义由持久状态重建覆盖；真实进程级故障注入留给真实联调阶段。 |
| R1 的「核对失败」的观测 | 核对失败与写失败在 `last_error` 上分别标注 | 核对失败写 `upstream verification read failed: ...`，确定失败保留上游分类原文，避免把两类故障混成一条。 |
| Ajv 校验错误的字段定位 | `additionalProperties` 类错误只能定位到 `body` / `payload` | Ajv 的错误对象不给出被拒字段名，契约层无法凭空补出字段路径；需改用 `propertyNames` 之类的自定义关键字才能定位，属契约层设计变更，本轮不做。 |

---

## 6. 审核的内部 CAS 与客户端「过期评审」意图

矩阵 §3 第 5 步要求的是「reviewer 检查 `expected_hash` 并审核 approved」，**不是** 客户端提交 `expected_state_revision`。
核对结论：

- **客户端契约**：审核请求只要求 `decision` / `expected_hash` / `reason`（`packages/contracts/src/knowledge.ts:197`）。
  `expected_state_revision` 只存在于**撤回**契约（`packages/contracts/src/knowledge.ts:210`），两者不可混用。
- **客户端的过期评审意图**：`expected_hash` 承载的是**正文版本一致性** —— 与当前 `content_hash` 不一致时返回 409 `STATE_CONFLICT` 并定位到 `expected_hash` 字段（`services/api/src/knowledge/service.ts:384`）。
  它**不**覆盖「客户端观察到旧审核状态后、别人已经完成审核才提交」的并发意图：正文未变时 `content_hash` 不变，旧客户端仍会以服务端最新修订号提交。
  这类客户端乐观并发需要单独裁决契约（是否新增必填的审核修订号），本轮不发明字段、不改契约。
- **服务端内部 CAS**：审核在同一事务内读取 `state_revision` 后做比较并交换，修订号过期时返回 409 `STATE_CONFLICT`（`services/api/src/knowledge/service.ts:399`）。这一步对客户端不可见，是防止两个审核人互相覆盖的内部保证。
- **因此**：不需要、也不应该发明新的必需字段。审查中「审核调用未提供 `expected_state_revision`」这一怀疑不成立；真实联调层此前失败的原因是缺真实 RAGFlow 配置，而不是缺字段。

回归证据：`tests/e2e/knowledge-review.test.ts:89`（哈希不符 → 409）、`tests/e2e/knowledge-review.test.ts:108`（并发审核 → 过期修订号被拒）。
