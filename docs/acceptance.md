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
| M09 | 状态机与并发竞态 | API 技术门 | 注册与撤回线性化；撤回后新绑定被拒；旧 `state_revision` → 409；`revoked` 是终态 | `tests/db/status-race.test.ts:26`、`:83`、`:113`、`:142`；**两种提交顺序各自成立（确定性门闩）**：`tests/db/status-linearization.test.ts:100`（注册提交在前 → 撤回 200、`binding_valid=false` 且精确旧配置仍可读、撤回后新绑定 422）、`:199`（撤回提交在前 → 后提交 422 `REF_NOT_AVAILABLE`、不留半截状态）；门闩由测试自持的数据库连接施加，并用 `pg_stat_activity` 确认被测请求**真的卡在预期的那一步**（`:133`、`:147`、`:233`） | **FULL** |
| M10 | RAGFlow dataset 契约 | API 技术门 | 202 + 操作号；成功才落 dataset 映射；业务失败 / 缺 `data.id` / 上游 401 三类失败结论**互相可区分**且不落映射、不进 ready；丢响应 → `unknown_outcome` 且只发一次 POST | `tests/contract/ragflow-dataset.test.ts:24`、`:54`、`:80`、`:106`、`:132`；失败可区分：`tests/contract/dataset-negative-cases.test.ts:88`、`:102`、`:117`、`:131`、`:158`；**核对用的 GET 失败不得授权另一次 POST**：`tests/db/review-recovery.test.ts:96` | FULL |
| M11 | RAGFlow 上传契约 | API 技术门 | 单个 `file` 字段 multipart；`data` 长度 1 且 dataset 匹配；**来源 sha256 落库**；协议错误即失败；丢响应 → `unknown_outcome` 且不盲重传 | `tests/contract/ragflow-upload.test.ts:25`、`:52`、`:78`、`:98`；完整性：`tests/contract/upload-integrity.test.ts:28`、`:55`；**解析未送达时只重试解析、不重复上传**：`tests/db/review-recovery.test.ts:118`；**同名不同来源不得被认领**：`tests/db/review-recovery.test.ts:158`；**首次发送前持久化远端身份**：`tests/db/upload-identity.test.ts:34`；**没有持久身份的历史操作不认领推算候选（保持 unknown）**：`tests/db/upload-identity.test.ts:82`；**上传回包为空/多条/错 dataset 时失败且零解析**：`tests/db/upload-identity.test.ts:111` | FULL |
| M12 | 上传限制 | API 技术门 | 20MiB 边界「恰好等于上限被接受」；超 1 字节 413；扩展名/MIME/伪 PDF/损坏 UTF-8/`../` 被拒；**两文件、压缩包被拒**；**非法请求 RAG 全 HTTP 为 0**；**无目录穿越与残留未引用文件** | `tests/unit/upload-limits.test.ts:26`–`:166`；`tests/e2e/upload-security.test.ts:46`–`:131`；边界：`tests/unit/upload-boundaries.test.ts:28`、`:38`、`:54`；残留与两文件：`tests/contract/upload-rejections.test.ts:81`、`:102`、`:123`、`:147`；**HTTP 层真实 20MiB 上限（恰好等于上限被接受、超 1 字节 413）**：`tests/e2e/upload-limit-real.test.ts:36`、`:57` | FULL |
| M13 | RAGFlow 解析状态契约 | API 技术门 | `code 0` 不立即 ready；DONE + 进度完成 + chunk_count>0 才 ready 并登记 index_revision；FAIL/CANCEL 可见错误；DONE+0 → empty；**`run` 为 `"0".."4"` 字符串、缺 `run`、`run=null`、未知值均按实现分支判定** | `tests/contract/ragflow-parse.test.ts:29`、`:49`、`:68`、`:88`、`:107`；分支：`tests/contract/parse-status-branches.test.ts:104`、`:113`、`:122`、`:130`、`:143`、`:151`、`:159`、`:169`、`:179` | FULL |
| M14 | 解析恢复与栅栏 | API 技术门 | Worker 解析中退出后重启**续跑同一 doc、不得新上传**；两个 worker 抢同一 operation 只有一个拿到租约；**旧 epoch 迟到写入被拒**；20 分钟未完成 → 终态 timeout 且停止自动轮询；**用户 GET 返回 stale 标记而不是「无匹配」** | 重启续跑与栅栏：`tests/db/operation-fencing.test.ts:231`、`:263`、`:54`、`:68`、`:120`；超时终态：`tests/contract/parse-recovery.test.ts:26`；stale 标记：`tests/e2e/knowledge-stale.test.ts:25`、`:49`；**轮询用的 GET 失败不得重新触发已确认的重建**：`tests/db/review-recovery.test.ts:138`；**历史身份恢复**：`tests/db/crash-window-recovery.test.ts:131`、`:167`；**真实进程退出（本轮补齐）**：`tests/db/worker-process-recovery.test.ts`——真起 `services/worker/src/main.ts`（tsx 跑源码，不是构建产物、不是进程内调用），在**持有租约**期间 `SIGKILL` 并三重确认进程真的死了（信号 0 抛 ESRCH、pid 退出、上游侧活连接归零）：`:194`（kill 与死亡确认 `:219`–`:232`；**上游 POST /documents 恰好 1 次** `:268`、**续跑的是同一个上游文档 id** `:270`、epoch/attempt 递增 `:272`、终态 `succeeded` `:259`）；**旧 epoch 迟到写入被数据库拒绝**：`:285`（旧 epoch 写入返回 false `:340`–`:350`，当前 epoch 写入返回 true `:353`–`:363`）；**两个真实 worker 进程抢同一 operation，只有一个拿到租约**：`:369`（两个不同 pid 且都活着 `:386`–`:398`；观察窗口内 `attempt`/`epoch` 恒为 1/2 `:447`；上游上传也恰好 1 次 `:454`） | **FULL** |
| M15 | 审核与撤回四态 | API 技术门 | 未审 / 拒绝 / 批准 / 撤回四态；审核记录落库（审核人、`expected_hash`、理由、时间、有效期）；哈希不符 409；并发 CAS 409；无 `knowledge:review` → 403；**拒绝态不可检索**；**撤回本地立即拒绝召回 / 下载，远端删索引未完成也不可召回**；撤回登记 `knowledge.withdraw` 操作并推进到终态 | `tests/e2e/knowledge-review.test.ts:41`、`:89`、`:108`、`:157`、`:170`、`:188`、`:216`、`:234`；撤回全链路：`tests/e2e/withdraw.test.ts:68`、`:81`、`:92`、`:121`、`:131`、`:158`、`:162`、`:177`、`:188`；**撤回是终态、迟到的完成与失败都不能复活版本、撤回取消在途操作**：`tests/db/knowledge-withdraw-terminal.test.ts:70`、`:102`、`:132`、`:177`；**撤回已提交且尚未交付正文时必须拒绝**：`tests/db/delivery-boundary.test.ts:155` | FULL |
| M16 | 授权检索与来源引用 | API 技术门 | 401 / 403 语义正确；**无 `knowledge:read` → 403 且上游 0 请求**；**文档详情按权限鉴权**；**请求体自带 actor 无效**；越权回包整体失败；显式不可见资源 404 | `tests/contract/scope-limits.test.ts:29`、`:35`、`:45`、`:54`、`:65`、`:82`、`:95`；`tests/contract/ragflow-authorization.test.ts:91`、`:134`；补充：`tests/contract/retrieval-authz.test.ts:33`、`:60`；`tests/contract/audit-and-log-hygiene.test.ts:56` | FULL |
| M17 | 空授权零上游请求 | API 技术门 | 有项目读权限但无文档授权 → `no_match` + `evidence=[]` + **全部 HTTP 调用数 0**；缺上下文 → `needs_context` + 0 调用；**授权集合里只剩已撤回知识 → `no_match` + 0 调用** | `tests/contract/ragflow-empty-access.test.ts:29`、`:47`、`:73`；撤回集合：`tests/contract/withdrawn-access.test.ts:50`、`:81`、`:106` | FULL |
| M18 | 检索白名单 | API 技术门 | 上游只允许精确 docA + 所属 dataset；**客户端混传有权/无权引用 → 404 且不泄露**；**上游 200 但 `code != 0` / 结构不符 → 整体失败**；**metadata 不能替代 ID 限制**；越权回包整体 502 | `tests/contract/ragflow-authorization.test.ts:30`、`:91`、`:134`；补充：`tests/contract/retrieval-authz.test.ts:77`、`:101`、`:129`、`:156` | FULL |
| M19 | 上游故障与重试预算 | API 技术门 | 读最多 3 次、总预算 ≤ 生产默认 30s；最终 503/504 且 trace 可查；429 与 `Retry-After` 退避；**连接被拒（确定未送达）可安全重试**；**写响应丢失只发一次并进入 `unknown_outcome`**；**总预算真正约束等待（上游不回包也必须超时退出）**；**不泄漏 key / 上游原文 / 文件正文** | `tests/contract/ragflow-unavailable.test.ts:46`、`:72`；`tests/contract/ragflow-retry.test.ts:143`、`:172`、`:200`、`:225`、`:268`、`:303`、`:346`、`:381`、`:437`；总预算兜底：`tests/unit/ragflow-timeout.test.ts:33`；生产默认：`tests/unit/config-defaults.test.ts:33`；**读失败与写失败分开处置（读失败不得清掉写请求的发送意图）**：`tests/db/review-recovery.test.ts:96`、`:118`、`:138` | FULL |
| M20 | 授权撤销边界 | API 技术门 | 上游调用期间撤销 → 交付前重查后丢弃已失权内容；**撤销提交后新请求也不可用旧 ACL**；**下载同查**；不持 PG 锁跨网络 | `tests/contract/acl-revocation.test.ts:34`；`tests/contract/download-revocation.test.ts:55`、`:61`、`:89`；`tests/contract/withdrawn-access.test.ts:50`；`tests/e2e/citations.test.ts:164`；**在途下载撤权 / 撤回已提交且未发正文时必须拒绝**：`tests/db/review-recovery.test.ts:180`、`:218`；**交付线性化点：授权事务提交后、HTTP 发送前提交的撤权/撤回必须被拒**：`tests/db/delivery-boundary.test.ts:155`；**下载 / 检索 / 证据的交付都在授权行锁内完成，并发撤权必须阻塞到交付事务提交之后**：`tests/db/delivery-boundary.test.ts:208`、`:254`、`:323` | FULL |
| M21 | 来源引用与证据 | API 技术门 | 证据带 knowledge/index/source 版本 + `chunk_hash` + score；无页码标 `incomplete` 不伪造；**索引重建后旧 evidence 仍可读**；**来源下载 sha256 与原文件实际哈希一致**；实时权限可拒绝 | `tests/e2e/citations.test.ts:39`、`:70`、`:92`、`:119`、`:133`、`:164`；重建：`tests/e2e/index-rebuild.test.ts:57`、`:67`、`:110`、`:120`、`:126`；下载一致性：`tests/contract/upload-integrity.test.ts:73`；**远端文档名带来源标识（来源与索引不错配）**：`tests/db/review-recovery.test.ts:158`、`tests/db/crash-window-recovery.test.ts:131`；**来源正文交付在授权行锁内完成**：`tests/db/delivery-boundary.test.ts:208` | FULL |
| M22 | 作用域与访问限制 | API 技术门 | 显式无权 → 404；显式有权但未 ready → 409 `INDEX_NOT_READY`；**授权文档数超过上限 → 422 且 0 上游请求**；**201 个可授权文档按真实阈值在边界拒绝**；**多 dataset 越界 → 422**；**`top_n` 越界 → 422** | `tests/contract/scope-limits.test.ts:110`、`:128`、`:144`；`tests/contract/ragflow-whitelist.test.ts:26`；真实阈值：`tests/contract/retrieval-document-count.test.ts:27`、`:45`（生产默认 200 见 `tests/unit/config-defaults.test.ts:55`）；多 dataset 与 `top_n`：`tests/contract/retrieval-limits.test.ts:32`、`:53`、`:69`、`:83`、`:103` | FULL |
| M23 | 概念契约校验门 | API 技术门 | 无概念引用的字符串契约注册成功且校验器未被调用；数值契约缺概念引用 → 422；本体不可达 → 503 `ONTO_UNAVAILABLE` 且不降级成功；概念不存在 → 422 并指出引用；**详情标 `concept_validation='not_requested'`** | `tests/unit/concept-gate.test.ts:66`、`:84`、`:119`、`:149`、`:180`、`:217`、`:246`、`:275`；详情标记：`tests/contract/retrieval-limits.test.ts:124` | FULL |
| **M24** | **UI 注册页（`ui/registration.spec.ts`）** | **UI 门** | 列表空/加载/错误/403、直接深链、表单 `field_path`、注册 409、版本选择、binding 失效明显可见 | **UI 门交付物在 onto 仓库**（本仓库无前端代码）：替身层 `console/ui/registration.spec.ts`（绑定失效显式提示 `console/ui/registration.spec.ts:211`、`:228`）；**真实层** `console/real/m24-registration.spec.ts`（真实 aip × 真实 PostgreSQL × 真实 RAGFlow，正式构建产物）：深链与刷新、空态、403 ×2、注册 409、`field_path` 定位、精确版本绑定、状态机（`revoked` 终态）、CAS 冲突、概念校验失败不显示通过、Markdown 转义、登出后旧响应不导航、切项目后旧响应不导航、浏览器请求与存储不含服务密钥、权限边界 ×2、依赖不可用 503；**本轮新增「加载态」**：资产列表在真实请求在途时给出骨架屏（不是空白、不是上一作用域残留、不是提前空态）——`console/real/m24-registration.spec.ts:99`（断言点 `:214`–`:233`）；**真实层实跑**（onto `agent/zach-34-acceptance-closeout`，端口 18180-18192）：31 条 = **28 passed + 3 skipped**（截图层，`SCREENSHOTS` 未设） | **FULL** |
| **M25** | **UI 知识页（`ui/knowledge.spec.ts`）** | **UI 门** | pending/parsing/failed/ready 四态、审核、`no_match`/`needs_context`/503、来源缺定位、密钥不入浏览器请求/storage/bundle、401/切项目清理结果 | UI 门交付物同样在 onto 仓库：`console/ui/knowledge.spec.ts`（替身层：四态标签、审核带 `expected_hash`、`no_match`、`needs_context`、依赖 503、来源定位不完整、切项目清理）+ `console/real/m25-knowledge.spec.ts`（真实层 10 条）。**本轮只复核并补齐了 M24**（加载态骨架屏），M25 的逐条覆盖本轮未做判据级复核，因此仍记 **NOT RUN**——这是「未复核」，不是「已确认无覆盖」 | **NOT RUN** |
| **M26** | **真实 RAGFlow 闭环** | **真实集成门** | 全步骤真实可追踪，引用指向上传原文并有可核验摘要；真实报告含版本/digest/来源证据；任何 mock 替代判失败 | **冻结 head `468c2cc` 上实跑**：`pnpm test:ragflow:real` 与 `pnpm test:ragflow:real:guard` 均 5/5 通过，`reports/468c2cc587ca73013135e1e30bd0a9b1c8d7df5c/real/summary.json`（`commit=468c2cc…`、`dirty=false`、`ragflow.source_sha=e650f0d…`＝上游 `v0.20.5` tag 提交、`image_digest=sha256:d95d0e4dc83a96fafffc5238f15c9192ed76ef2d320adb516f010bdc9876455a`、`embedding_revision=79e7739b6ab944e86d6171e44d24c997fc1e0116`、`counts.pass=5`、`run_end_reason=passed`）。**合并 head `8c487c7` 上再跑一遍**（含 M27 新增用例）：13/13 通过，`reports/8c487c74ee9f4c21564f51f79f6ed4bb99df4ec6/real/summary.json`（`4b2ce3e` 与 `8c487c7` 内容树相同）。**抗替身断言**：仓内已把「确实打到了真实上游」钉成断言，不依赖独立复核——① 真实上游传输被调用过；② 记录式替身一次都没被调用；③ 平台记录的上游数据集 id 能在**真实上游**按名查到（独立客户端 + 真实 API Key）：`tests/real/closed-loop.test.ts:93`、`:98`，检查实现 `tests/real/helpers.ts` 的 `checkRealUpstreamUsed`。**反向对照**：把上游换成 harness 自带替身后，流程照样跑绿（知识库仍判 `ready`），抗替身断言必须报出违规：`tests/real/anti-substitute.test.ts:67`、`:101`。**旧的 `8993b86` 证据仍不迁移**：它的 `commit` 字段指向旧 SHA，证明不了本轮的语义；本表的证据由 `commit` 字段与报告目录名双重绑定 | **FULL** |
| **M27** | **真实 RAGFlow 隔离失败** | **真实集成门** | 真实检索不返回未授权文档；无授权请求 0；真实不可达 503/504；解析失败保持 failed；目标解析失败不可稳定复现时明确 NOT RUN 而非用 mock 记真实通过 | **已真实执行的子判据**：① 真实检索不返回未授权文档 `tests/real/isolation-failure.test.ts:93`；② 无授权时上游请求数 0（真实传输计数）`tests/real/isolation-failure.test.ts:60`；③ **真实不可达 → 503 `RAGFLOW_UNAVAILABLE`**（连接被内核拒绝 `ECONNREFUSED`）`tests/real/upstream-unreachable.test.ts:149`、`:158`、`:191`；④ **真实解析失败保持 failed**（上游 `run=FAIL`）`tests/real/parse-failure.test.ts:105`、`:141`、`:200`。**本轮（ZACH-34）补上的两条**：⑤ **真实 504 / 读超时**——上游**收下连接但不回包**（本地 socket 服务接受连接后一个字节不回，用例内断言连接确实被接受，因此失败发生在读阶段而不是「连不上」），平台侧回 **504 `RAGFLOW_TIMEOUT`** 且不新增任何证据行：`tests/real/isolation-real-advanced.test.ts:378`（断言 `:415`–`:437`）；⑦ **真实 A/B 同库混排**——同一上游 dataset 下两份文档、两个主体交叉授权，主体 A 只召回自己有权的那份，**无权文档的内容在回包里完全不出现**（不是只在请求层回 404）：`tests/real/isolation-real-advanced.test.ts:196`（断言 `:262`–`:277`）。**本轮真实层实跑**：`reports/5a517ef1f987f1f69d8c17e26abfc293753503ab/real/summary.json`（`commit=5a517ef1…`、`dirty=false`、`ragflow.source_sha=e650f0d…`、`image_digest=sha256:d95d0e4d…`、`embedding_revision=79e7739b…`、`counts.modules=6`、`counts.pass=19`、`counts.fail=0`、`counts.not_run=0`、`run_end_reason=passed`）。**⑥ 真实撤回：平台侧终态已真实验证，上游侧清理不成立（产品缺陷，不是测试手段问题）**——撤回后本地立刻拒绝召回与下载已由真实层验证（`tests/real/isolation-real-advanced.test.ts:299`，断言 `:344`–`:361`）；但**上游文档没有被删除、也仍可被上游索引命中**：`tests/real/isolation-real-advanced.test.ts:363`–`:404`（独立原始 HTTP 复核）。根因已定位到产品代码：真实上游 v0.20.5 **没有**「删单个文档」这条路由（`/ragflow/api/apps/sdk/doc.py` 只给 `/datasets/<id>/documents` 挂了 DELETE 批量路由，单文档路由只有 PUT/GET），平台用的是单文档 DELETE（`services/api/src/ragflow/adapter.ts:224`），上游回 `code=100`（405 Method Not Allowed），而适配器只检查 HTTP 状态码不检查信封 `code`，于是删除被静默记成成功；替身层（`tests/helpers/ragflow.ts:259`）实现的正是这条上游不存在的路由，所以替身层永远发现不了。**按本任务边界不改产品行为**，该子判据维持 NOT RUN | **PARTIAL** |
| M28 | 密钥不落库不落日志 | API 技术门 | 8 张持久化表内无上游 key / DB URL / token；带 `api_key` 的 config 被拒；嵌套 password 与 URL 被拒；上游错误原文不回显；**构建产物扫描无密钥形态**；**日志快照不含敏感内容**；**动态出口 `base_url` 被拒**；**重定向不泄漏 key**；**审计 subject 来自可信 principal** | `tests/unit/security-no-secret.test.ts:47`、`:58`、`:80`、`:105`；构建产物：`tests/unit/secret-scan.test.ts:72`、`:79`、`:86`、`:104`；日志与审计：`tests/contract/audit-and-log-hygiene.test.ts:27`、`:56`、`:76`、`:99`；动态出口：`tests/db/config-policy.test.ts:83`、`:119`、`:137`；重定向：`tests/unit/redirect-key-leak.test.ts:66` | FULL |

**统计：FULL 26 条／PARTIAL 1 条（M27）／NOT RUN 1 条（M25）。**

> 本轮（ZACH-34）把 M09（确定性提交顺序）、M14（真实进程退出）从 PARTIAL 补到 FULL，
> 把 M24（UI 注册页，UI 门交付物在 onto 仓库）的加载态补上并记 FULL；
> M27 仍有「真实撤回的上游侧清理」一条未过（**已定位为产品缺陷**，非测试手段问题），故仍记 PARTIAL；
> M25 本轮只做 M24，未做逐条复核，仍记 NOT RUN。

> 本表不再把 M01–M23 一律记 FULL：上一版保留 PARTIAL 的 M09 与 M14
> （未真的 kill 进程、崩溃窗口用持久状态重建模拟）按 ZACH-10 复审口径处理，
> 本轮由 ZACH-34 补上了**确定性提交顺序**与**真实进程退出**两处缺口（见各行与第 5 节）。
> M11 / M15 / M20 / M21 上一版的 PARTIAL 全部来自 F1 / F2，本轮修复并各有独立反例覆盖。

> M24 / M25 属于 UI 门，交付物**不在本仓库**（UI 在 onto 仓库，ZACH-11 / ZACH-20）。
> 本轮（ZACH-34）把 M24 的「加载态」补上并复核了 M24 的逐条覆盖：onto 真实层
> （`console/real/m24-registration.spec.ts`，真实 aip × 真实 PostgreSQL × 真实 RAGFlow）
> 31 条 = 28 passed + 3 skipped，M24 记 FULL；M25 的逐条复核本轮未做，仍记 NOT RUN。
> M26 / M27 的 NOT RUN 已解除：真实栈（compose project `aip-ragflow`，镜像
> `infiniflow/ragflow:v0.20.5`）在本机可用，本轮在冻结 head `468c2cc` 与合并 head `8c487c7` 上
> **实跑了真实联调层**，证据见 `reports/468c2cc587ca73013135e1e30bd0a9b1c8d7df5c/real/` 与
> `reports/8c487c74ee9f4c21564f51f79f6ed4bb99df4ec6/real/`。
> **M27 本轮（ZACH-34）补上两条**：真实 504/读超时（上游收下连接但不回包）与
> 真实 A/B 同库混排（同一 dataset、两主体交叉授权）已由真实层执行；
> **真实撤回只剩「上游侧清理」一条未通过，且已定位为产品缺陷**（上游 v0.20.5 没有平台所用的
> 单文档删除路由，适配器又只看 HTTP 状态码），按本任务边界不改产品行为，故 M27 仍记 PARTIAL
> （缺口见 M27 行与第 5 节）。
> 替身层结果仍不顶替真实证据，两者在第 4 节分开汇报；
> `8993b86` 上的旧证据不迁移到本轮（`commit` 字段指向旧 SHA）。

---

## 2. 另行编号的文档与契约检查（不占用 M 编号）

| 编号 | 检查项 | 判据 | 证据 | 状态 |
| --- | --- | --- | --- | --- |
| DOC-01 | 运行手册与配置项一致性 | `docs/runbook.md`、`.env.example` 与 `config.ts` / `main.ts` / `migrate.ts` / worker 实际读取的环境变量一致 | 断言：`tests/contract/runbook-config-consistency.test.ts`（代码读取集合与「`docs/runbook.md` 变量表 ∪ `.env.example`」双向差集为空，两侧各 40 个变量；`.env.example` 与运行手册变量表分别单独相等）；读取点：`services/api/src/config.ts:72`、`:80`、`:85`、`:95`、`:123`、`:126`、`:215`、`services/api/src/main.ts:16`、`:78`、`services/api/src/db/migrate.ts:19`、`services/worker/src/main.ts:14`–`:16` | FULL |
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
| F1（e432ad8 复审） | **交付窗口：末次授权判定与 HTTP 交付不在同一个序列化边界内**。末次判定在事务里，事务 COMMIT 释放 `authz_state` 行锁之后路由才 `res.send`；这中间撤权/撤回真实提交成功，旧正文仍然发出（复审实测 `change_status=200, download_status=200`） | ① 交付改为**受控交付回调**：service 在末次判定事务内调用回调，路由只做响应入队；② 文件读取仍在事务外（不跨文件 I/O 持锁），上游调用也在事务外；③ 交付的线性化点 = 交付事务内 `SELECT … FOR UPDATE authz_state` 持有期间的响应入队：撤权要么在判定前提交（被判定看见 → 拒绝），要么阻塞到交付入队之后才提交；④ 交付事务提交失败等异常走 `headersSent` 保护，不再二次写错误体 | `tests/db/delivery-boundary.test.ts:155`（撤权/撤回在 COMMIT 后、HTTP 发送前提交 → 404 且正文不含标记）、`:208`（下载交付在授权锁内：并发撤权被阻塞到交付事务提交之后）、`:254`（检索交付同）、`:323`（证据交付同） |
| F2（e432ad8 复审） | **历史上传意图没有持久身份仍自动认领推算候选**：旧操作缺 `remoteName` 时用**新算法**推算一个名字，再把上游同名对象认领成这次的上传（复审实测 `remote_id=unproven-candidate, state=succeeded`） | 已处于发送意图/unknown 阶段且**没有已持久化远端身份**的历史操作不再推算、不再认领：保持 `unknown_outcome`、不绑定 `remote_id`，交人工按可靠远端 ID / 来源摘要核对；只有**新待发送操作**才生成远端名并在第一次 HTTP 之前与发送意图一起落库 | `tests/db/upload-identity.test.ts:34`（第一次上传之前身份已落库）、`:82`（无持久身份 + 同名候选 → `remote_id` 为空且 `unknown_outcome`）；`tests/db/crash-window-recovery.test.ts:131`（已持久身份仍可认领）、`:167`（无持久身份保持 unknown） |
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
> **本轮 real 层已真实执行**（`RUN_REAL_RAGFLOW=1` + 完整配置），产物：
>
> | 报告目录 | `commit` | `dirty` | `counts` | 上游事实 |
> | --- | --- | --- | --- | --- |
> | `reports/468c2cc587ca73013135e1e30bd0a9b1c8d7df5c/real/` | `468c2cc…`（冻结 head） | `false` | `cases=5, pass=5, fail=0, not_run=0` | `ragflow.source_sha=e650f0d…`（上游 `v0.20.5` tag）、`image_digest=sha256:d95d0e4d…`、`embedding_revision=79e7739b…` |
> | `reports/8c487c74ee9f4c21564f51f79f6ed4bb99df4ec6/real/` | `8c487c7…`（PR #6 合并 head，内容树同 `4b2ce3e`） | `false` | `cases=13, pass=13, fail=0, not_run=0` | 同上 |
> | 收官修正轮（本 PR 的 HEAD，含抗替身断言） | 本 PR HEAD | `false` | `cases=15, pass=15, fail=0, not_run=0` | 同上 |
>
> 用例计数口径：**13 = 4 条配置前置检查 + 9 条行为用例**（每个测试文件一条「未启用则报 NOT RUN」的前置检查，
> 共 4 个文件；其余 9 条是行为断言）。收官修正轮多一个文件，相应变成 **15 = 5 + 10**。
> 收官修正轮那一份报告的字面目录名 = 本 PR HEAD 的 SHA（同一提交里写不出自己的 SHA，
> 字面值见 PR 描述与随附的 `summary.json`）；报告的 `commit` 字段与之相等、`dirty=false`。
>
> 字段口径：
> - `commit` 是**被测 aip 代码的 SHA**（证据归属哪个 head 由它和报告目录名决定）；
> - `ragflow.source_sha` 与 `embedding_revision` 是**环境声明**（由运行者按 `docs/ragflow-lock.md` §3 填入，
>   报告本身不校验它们）；
> - `image_digest` **可独立核对**：它是运行中容器的 RepoDigest，
>   用 `docker inspect --format '{{index .RepoDigests 0}}' infiniflow/ragflow:v0.20.5` 就能对上；
> - `parser_digest` 复用 `ragflow.source_sha`（上游解析器来源）。
>
> 旧的 `8993b86` 证据不迁移：`commit` 字段指向旧 SHA，证明不了本轮语义。

---

## 5. 限制与未完成项（逐项说明，不把结论降级为通过）

| 项 | 限制 | 原因 |
| --- | --- | --- |
| M24 / M25 | **NOT RUN** | 本仓库无前端代码、无 Playwright、无 `test:platform` 脚本。UI 门由 ZACH-11 交付；本轮不产出 UI 结论，也不以文档检查顶替。 |
| M26 / M27 的替身层覆盖 | 替身层仍覆盖「上游 5xx」「读超时 504」与「解析状态分支」 | `tests/contract/ragflow-unavailable.test.ts:72`（5xx → 503）、`:89`（读超时 → 504 `RAGFLOW_TIMEOUT`）、`tests/contract/ragflow-parse.test.ts:68`。替身结果不顶替真实集成证据，只说明代码路径在替身下可判定。真实层的覆盖见下两条。 |
| **M27 剩余的一条 NOT RUN（故 M27 仍记 PARTIAL）** | **真实撤回的上游侧清理**（撤回后上游文档应被删除或索引不可命中） | 平台侧终态（撤回后本地立刻拒绝召回 / 下载）已由真实层验证（`tests/real/isolation-real-advanced.test.ts:299`）。上游侧不成立，且**不是本机造不出**：真实上游 v0.20.5 只有批量删除路由 `DELETE /api/v1/datasets/<id>/documents`（body `{"ids":[…]}`，实测 code=0、文档真的消失），**没有**平台所用的单文档路由 `DELETE /api/v1/datasets/<id>/documents/<doc>`（实测回 `code=100`、消息含 `405 Method Not Allowed`；上游源码 `/ragflow/api/apps/sdk/doc.py` 亦只给集合路由挂 DELETE，单文档路由只有 PUT/GET）。平台适配器走的正是这条不存在的路由（`services/api/src/ragflow/adapter.ts:224`），且只检查 HTTP 状态码、不检查信封 `code`（`:227`），于是上游的业务失败被静默记成「删除成功」；替身层（`tests/helpers/ragflow.ts:259`）实现的也是这条上游不存在的路由，因此替身层结构上不可能发现它。**按本任务边界（只改测试与验收文档、不改产品行为）不擅自修**；修复方向：适配器改用上游真实存在的批量删除路由，并对写操作校验信封 `code`。 |
| M27「真实不可达」的取证边界 | 失败发生在**连接上游**这一层（内核拒绝连接 `ECONNREFUSED`），**不覆盖「上游进程自己回 5xx」** | 本轮的可控故障只有「连不上」：把该轮上游指向确实没有监听的本地端口，连接被内核拒绝。这验证了「上游连不上时对外是 503、不是 500、且不写半条成功状态」；上游进程返回 5xx 的变体在本机无法在不干扰共享栈的前提下制造，仍只有替身层覆盖（`tests/contract/ragflow-unavailable.test.ts:72`）。失败分类（`not_delivered`，可安全重试/重发）与 503/504 的映射在两条路径上同一份代码，但**不能据此宣称 5xx 变体已真实验证**。 |
| M27「真实解析失败」的取证边界 | 真实覆盖的是「上游解析器判失败（`run=FAIL`）」；**加密 PDF 这一变体被平台自己的上传校验拦下，不算真实上游解析失败** | 损坏 PDF（有 `%PDF-` 魔数、无对象与交叉引用表）会真正走到上游解析器，上游 `run=FAIL`、`chunk_count=0`，平台侧保持 `failed`（`tests/real/parse-failure.test.ts:105`、`:141`）。加密 PDF 在 `validateUpload` 就被拒（`/Encrypt` 标记，`services/api/src/files/validate.ts`），根本不会产生上游请求，因此**不作为真实解析失败证据**。 |
| 真实联调层的隔离域 | 真实层的作用域是 `RAGFLOW_TEST_PROJECT_ID` 指定的 scope（本轮 `aip-zach19`），上游数据集命名规则固定为 `aip-<scope>-<16 位十六进制>`（本轮即 `aip-aip-zach19-<16hex>`）；**复跑会持续累积，不自动删除** | 上游 dataset 名由 scope 派生（`services/api/src/util/hash.ts` 的 `newDatasetName`），平台侧知识库名带可识别前缀（`real-闭环-*` / `real-隔离*` / `real-不可达-*` / `real-解析失败-*` / `real-替身对照-*`）。本任务累计留下若干 `aip-aip-zach19-*` 数据集，**按约定只列出、不删除**（数量随复跑次数增长，不写死）；他人数据集与 `smoke-probe` 均未触碰。本地测试库用既有 `aip-test-postgres`，每个用例独立 schema、结束即删。 |
| DOC-01 的断言边界 | 已补自动化断言，但仍是**静态扫描**而非运行时取值 | 断言比对的是「代码里出现的环境变量名字面量」与文档清单：`config.ts` 的读取助手字面量参数、`env.X` 直接读取、`services/**` 里的 `process.env.X`。因此动态拼出来的变量名（`config.ts` 里的 `env[name]`）取不到；若将来引入按字符串拼接的环境变量名，这条断言不会自动发现它，需要同步扩展扫描规则。compose 专用变量（`POSTGRES_*`、镜像名）不由产品代码读取，单独放在 `deploy/.env.example`，由 `tests/contract/runbook-config-consistency.test.ts` 另行断言归属未丢失。 |
| M-3 的两阶段幂等 | **未实现**（有意保留现状） | 把幂等占位行移出业务事务会破坏 M04 依赖的「同键并发等待」语义。本轮按已确认的设计决策保留事务内占位，并在 `tests/db/idempotency-scope.test.ts` 固定其对外语义。 |
| M14 的真实 20 分钟解析路径 | 只在替身层用缩短的截止时间验证终态 | 真实等待 20 分钟无收益；生产默认值本身由 `tests/unit/config-defaults.test.ts:23` 钉死（20 分钟），超时终态行为由 `tests/contract/parse-recovery.test.ts:26` 覆盖。 |
| M19 的「总预算 ≤30s」 | 用缩短预算跑同一代码路径 | 30 秒的墙钟等待不产生额外信息；生产默认值由 `tests/unit/config-defaults.test.ts:33` 断言（30 秒 / 3 次），预算切分与兜底超时行为由 `tests/contract/ragflow-unavailable.test.ts:72`、`tests/contract/ragflow-retry.test.ts:178` 与 `tests/unit/ragflow-timeout.test.ts:33` 覆盖。 |
| M19 的「送达未知 / 未送达」可观测性 | 只读路径上两者结论相同（均 `in_progress`） | 「已送达 / 未送达」的差异只在写路径有可判别后果（`unknown_outcome` vs 可重试）；只读路径两者都允许重试，因此不额外暴露内部差异。 |
| 幂等键跨资产的**并发**交错 | 覆盖了「同键跨资产各自成立」与「同资产同键重放 / 异体冲突」 | 未构造两个资产同时用同一键并发写入的交错时序；现有断言覆盖该缺陷的复现路径（跨资产串读）。 |
| M01 / M02 的实例级用例 | 需要显式的 `AIP_TEST_ADMIN_DATABASE_URL`；未配置时整组用例标记为 NOT RUN | 这两组用例要在数据库实例上建角色建库。没有显式指定专用实例就不能跑：宁可记 NOT RUN，也不落到共享实例上伤人。复核人可按 `docs/runbook.md` 第 6 节起一个一次性实例后重跑。 |
| M09 的确定性提交顺序 | **已补齐**：门闩由测试自持的数据库连接施加，顺序由数据库的锁队列决定 | `tests/db/status-linearization.test.ts` 用两个不同的门闩分别构造两种顺序：注册在前时门闩锁 `agent_skill_binding`（注册卡在写绑定、已持有 Skill 版本行锁 → 撤回只能等它提交），撤回在前时门闩锁 `asset` 表的 SHARE 模式（注册卡在 `INSERT INTO asset`，还没碰 Skill 版本行 → 撤回不受影响、可先提交）。两处都用 `pg_stat_activity` 断言被测请求**真的卡在预期的那一步**（卡住本身就是证据），因此门闩失效时用例立刻变红。自证：把两个请求的先后对调 → 变红；去掉门闩 → 变红（均已实跑） |
| M14 的「真实 kill 进程」 | **已补齐**：真进程 + SIGKILL + 死亡三重确认 | `tests/db/worker-process-recovery.test.ts` 起的是仓库里的真实 worker 入口（`services/worker/src/main.ts`，tsx 直接跑源码），杀的是那个 pid 本身。崩溃窗口落在「发送意图已落库、上游响应未回」这一点上，因此接管走的是**只读核对上游同名文档并认领**的分支，天然验证「续跑同一 doc、不产生第二次上传」。死亡确认不靠日志自述：信号 0 抛 ESRCH、进程退出、以及上游侧活连接归零。自证（均已实跑为红）：去掉上游挂起 → 红；不 kill → 红；迟到写入不带 epoch → 红；观察窗口内让租约过期 → 红（`attempt` 变 2，说明确实被领取过第二次）。已知边界：接管走 `stage==='upload_attempted'` 分支（`outcomeUnknown` 分支仍由既有进程内用例覆盖）；替身不会把文档标 DONE，故知识版本停在 `parsing`，不覆盖到 `ready` |
| R1 的「核对失败」的观测 | 核对失败与写失败在 `last_error` 上分别标注 | 核对失败写 `upstream verification read failed: ...`，确定失败保留上游分类原文，避免把两类故障混成一条。 |
| Ajv 校验错误的字段定位 | `additionalProperties` 类错误只能定位到 `body` / `payload` | Ajv 的错误对象不给出被拒字段名，契约层无法凭空补出字段路径；需改用 `propertyNames` 之类的自定义关键字才能定位，属契约层设计变更，本轮不做。 |

---

## 6. 审核的内部 CAS 与客户端「过期评审」意图

矩阵 §3 第 5 步要求的是「reviewer 检查 `expected_hash` 并审核 approved」，**不是** 客户端提交 `expected_state_revision`。
核对结论：

- **客户端契约**：审核请求只要求 `decision` / `expected_hash` / `reason`（`packages/contracts/src/knowledge.ts:197`）。
  `expected_state_revision` 只存在于**撤回**契约（`packages/contracts/src/knowledge.ts:210`），两者不可混用。
- **客户端的过期评审意图**：`expected_hash` 承载的是**正文版本一致性** —— 与当前 `content_hash` 不一致时返回 409 `STATE_CONFLICT` 并定位到 `expected_hash` 字段（`services/api/src/knowledge/service.ts:427`）。
  它**不**覆盖「客户端观察到旧审核状态后、别人已经完成审核才提交」的并发意图：正文未变时 `content_hash` 不变，旧客户端仍会以服务端最新修订号提交。
  这类客户端乐观并发需要单独裁决契约（是否新增必填的审核修订号），本轮不发明字段、不改契约。
- **服务端内部 CAS**：审核在同一事务内读取 `state_revision` 后做比较并交换，修订号过期时返回 409 `STATE_CONFLICT`（`services/api/src/knowledge/service.ts:449`）。这一步对客户端不可见，是防止两个审核人互相覆盖的内部保证。
- **因此**：不需要、也不应该发明新的必需字段。审查中「审核调用未提供 `expected_state_revision`」这一怀疑不成立；真实联调层此前失败的原因是缺真实 RAGFlow 配置，而不是缺字段。

回归证据：`tests/e2e/knowledge-review.test.ts:89`（哈希不符 → 409）、`tests/e2e/knowledge-review.test.ts:108`（并发审核 → 过期修订号被拒）。

---

## 7. 审核终态：已批准的版本不可改判（ZACH-17 裁决 a）

ZACH-10 复审发现（既有行为，非某次改动引入）：已批准且可下载的版本被再次审核为 `rejected` 时接口返回 200，
之后检索按 `review_status='approved'` 过滤返回 0 条证据，而下载仍按文档级授权返回 200 并发出正文——
同一个状态在两条路径上被解释成两种结果。成员裁决取 (a)：**禁止把已 approved 的版本改判为 rejected**；
(b)（改下载判定去检查 `review_status`）不做。

- **服务层**：`approved` 是终态。`approved → rejected` 一律拒绝，返回 409 `REVIEW_ALREADY_APPROVED`
  并定位到 `decision` 字段（`services/api/src/knowledge/service.ts:418`）；状态、审核记录、`state_revision` 都不变。
  `approved → approved`（同结论重放）按幂等返回当前已生效的审核事实（审核人、时间、有效期取自库里那条记录），
  不写审核记录、不推进 `state_revision`，因此**不是 409**。
  尚未批准的版本（`pending` / `rejected`）两条路径维持原行为。
- **判定顺序**：终态判定排在 `expected_hash` 校验之前（`services/api/src/knowledge/service.ts:418` 早于 `:417`）。
  已批准版本上的任何请求都按上表处理，不会因为哈希不匹配被改写成 `STATE_CONFLICT`——否则同一个失败会
  有两个错误码，调用方无法稳定分流。`expected_hash` 前置条件只对真正要落库的新结论有效。
- **并发**：同一版本的并发审核仍走既有 CAS（`UPDATE ... WHERE state_revision = <期望值>`），只有一方成功，
  另一方拿到明确的 409（`STATE_CONFLICT`，或在对 approved 的改判上拿到 `REVIEW_ALREADY_APPROVED`），不产生双写。
- **数据库层兜底**：迁移 `011_review_approved_final.sql` 加了 `BEFORE UPDATE` 触发器，
  任何写入路径（直连 SQL、未来新增的代码路径）都不能把 `approved` 改写成别的结论；
  触发器抛本仓自定义 SQLSTATE `AIP01`，API 层映射成同一个 `REVIEW_ALREADY_APPROVED`（409），不混成 500。
- **同步面**：错误码进 `packages/contracts/src/errors.ts`（`ERROR_CODES` / `ERROR_STATUS`）、
  `openapi/aip-v1.yaml`（`ErrorCode` 枚举 + 审核接口的状态机说明 + `Conflict` 响应说明）与 `docs/decisions.md` D14。

回归证据：`tests/unit/review-policy.test.ts`（状态机分支）、`tests/contract/review-verdict-final.test.ts`
（409 错误码、无副作用、幂等、pending 两条路径、并发双审核、检索与下载一致）、`tests/db/review-verdict-final.test.ts`
（数据库层拒写、`AIP01` 映射、同结论放行）、`tests/db/migration-upgrade.test.ts`（011 升级路径）。
