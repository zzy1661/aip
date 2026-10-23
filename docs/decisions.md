# 架构决策记录

本文件记录 `aip`（智能研发平台首批：Skill/Agent 注册与 RAGFlow 知识库闭环）的关键决策。
编号 D1–D5 是本批的既定裁剪，由平台负责人（Mika）确认；D6 起是实现过程中做出的具体技术决策。

---

## D1：aip 独立服务 + 独立 PostgreSQL，注册事实以 aip 为唯一权威

**背景**
初版架构计划（v3.1）设想把「Skill/Agent 注册事实」写入共享的本体库（onto），
并让 RAGFlow 侧的知识状态与之做跨库原子发布：要么两边同时生效，要么同时回滚。

**决策（裁剪）**
aip 作为一个**独立的 TypeScript/Node 服务**，配一个**独占的 PostgreSQL 实例**，
是注册事实（Skill/Agent 资产、版本、知识版本、授权、操作登记）的**唯一权威**。
本批**不做跨库原子发布**：aip 不写 onto 的业务表，onto 也不参与 aip 的事务。

**影响**
- 注册事实的可读性与一致性由单个数据库保证，可用单库事务与 CAS（`state_revision`）实现。
- 代价：aip 与 onto 之间**没有分布式事务**。本体只以**只读的概念校验**方式被调用
  （`services/api/src/ontology/client.ts`），失败即拒绝，不做反向写回。
- 代价：跨系统的「发布」只能是最终一致，必要时由人工在两侧分别推进。
  因此平台把 `published` / `approved` / `executable` 之类的跨系统状态
  **从本批注册模型中剥离**，注册状态只有 `registered → deprecated → revoked` 三态，
  `revoked` 为终态。
- 代价：onto 的概念变更不会自动反映到已注册资产上。数值型/概念型契约因此要求
  在注册时绑定**精确的**本体与词表版本（见 D3）。

---

## D2：RAGFlow v0.20.5 只是「已验证的静态契约起点」，不是生产选型

**背景**
RAGFlow 官方镜像的 tag 与实际实现存在偏差，且不同 tag 之间的字段形状不稳定。
直接按「最新版本」实现，会在生产环境出现无法解释的解析失败或检索退化。

**决策**
- `RAGFLOW_API_VERSION` 固定为 `v0.20.5`，`loadConfig()` 对其他取值直接启动失败
  （`services/api/src/config.ts`）。这不是「推荐版本」，而是**本批唯一验证过的静态契约起点**。
- 契约、镜像 digest、模型修订三者必须**同版本锁定**，记录在 `docs/ragflow-lock.md`。
- 在没有真实环境的情况下，只完成**契约层**与**数据库层**的验证；
  **真实集成一律标记 NOT RUN**，不得用替身测试的结果冒充联调通过。
- 换任何其他固定版本都必须**重新走一遍契约复核**，不得凭猜测修改适配器字段。

**影响**
- 适配器（`services/api/src/ragflow/`）只投影该契约明确出现的字段，
  缺失或未知一律判定为协议错误，不做「宽容解析」。
- 生产落地前必须补齐 `RAGFLOW_IMAGE_DIGEST`、`RAGFLOW_SOURCE_SHA`、
  `RAGFLOW_EMBEDDING_REVISION` 三个锁定值，否则 `index_revision.parser_hash` 会记为 `unpinned`、
  `embedding_revision` 记为 `unversioned`，无法证明某次索引由哪份契约与模型产生。

---

## D3：首批范围 —— 行内 Markdown Skill、单文件 20 MiB、字符串契约可闭环

**背景**
「Skill 注册 + Agent 绑定 + 知识库闭环」如果一次做全（任意 Skill 内容形态、任意文件形态、
任意契约类型、Agent 自动执行），评审面会失控，且每一处的失败模式都无法在有限时间内验证。

**决策**
本批只覆盖：
1. **Skill 内容形态**：行内 Markdown（`content.kind = 'inline_markdown'`，正文有 256 KiB 上限）。
2. **知识来源文件**：单个文件，扩展名限 `.txt` / `.md` / `.pdf`，单文件 ≤ 20 MiB
   （`AIP_UPLOAD_MAX_BYTES`，默认 `20 * 1024 * 1024`），且需通过扩展名 + MIME + 文件头 + 文本编码四重校验。
3. **契约类型**：**字符串**契约、且不含 concept 引用的 Skill 可以走完闭环。
   **数值型 / 概念型契约必须被精确校验或被拒绝，绝不允许伪造成功**：
   - 数值型契约（`data_type = 'NUMBER'`）必须绑定 `unit_ref` 与精确的
     `ontology_version` / `vocabulary_version`；
   - 概念引用（`concept_ref`）必须经本体服务逐条校验，**本体不可用即拒绝**
     （`ONTO_UNAVAILABLE` / `CONTRACT_INVALID`），绝不降级为「校验通过」。
4. **Agent 注册不触发执行**：`execution_enabled` 只能是 `false`，
   置 `true` 直接 `CONTRACT_INVALID`。本批没有 `/run` 端点，注册 Agent 只是登记事实。

**影响**
- 首批闭环可以在没有本体环境、没有 Agent 执行引擎的情况下完成并验证。
- 数值/概念型 Skill 的注册被明确拒绝，是**有意的失败**，不是缺陷：它保证了
  「语义不可验证的事实不会进入注册库」。

---

## D4：复用 onto console 与既有共享包，只做本批页面

**背景**
onto 已经有 console 与共享包（类型、组件、请求封装）。另起一套前端会重复建设，
且会让 ZACH-4（onto 侧写能力）与 ZACH-5（评审基线与变更边界）的结论无法落地。

**决策**
- 本批前端**复用 onto console 与既有共享包**，只新增本批所需的页面
  （Skill/Agent 注册与查询、详情、版本与状态；知识库创建、文档上传、解析状态、审核、检索与引用）。
- **UI 发布的前置条件**是：ZACH-4 写完 **且** ZACH-5 的评审基线/变更边界明确。
  ZACH-4 与 ZACH-5 处于 `in_review` **不等于** UI 可以发布；
  由 Mika 统一协调访问与接入窗口。
- **不扩大 ZACH-5 的范围**：本批不改 ZACH-5 定义的基线与边界。

**影响**
- 本批的 API 交付与页面交付是**两个独立门**：API 技术门可以在 UI 门未开时独立完成并验收。
- 页面权限表与服务端权限判定必须一致（见 D8），页面不作为唯一防线。

---

## D5：操作登记持久化 + lease/epoch Worker，不引入通用编排运行时

**背景**
上游写操作（RAGFlow 的 dataset 创建、文档上传、解析启动、文档删除）是**异步且不可幂等**的：
响应丢失时，服务端无法确定远端到底有没有生效。若引入通用编排运行时来「编排」这些步骤，
会引入一个比业务本身更难验证的子系统。

**决策**
- 所有跨上游的长流程都由**持久化操作登记**（`operation` 表）表达，状态机为
  `pending → in_progress → succeeded | failed | unknown_outcome | cancelled`。
  `cancelled` 表示「不再需要做了」（例如知识版本已撤回），与 `failed`（做砸了）区分开。
- 由**轻量 Worker** 推进：领取操作时写入 `lease_until` 与 `epoch`，
  本轮处理结束即释放租约（否则轮询间隔会被租约时长悄悄放大）。
- **不引入通用编排运行时**：没有工作流 DSL、没有 DAG、没有通用补偿框架。
  每个操作类型的推进逻辑是普通代码。
- **未知写入结果绝不盲目重试**（见 D6）。

**影响**
- 进程重启不丢进度：操作状态在数据库里，Worker 重启后继续。
- 租约保证同一操作不会被两个 Worker 同时推进；`epoch` 为后续引入 fencing 预留。
- 代价：状态机的分支逻辑是手写的，新增操作类型必须同步实现推进函数。

---

## D6：写操作用「已尝试」标记 + 只读核对取代盲目重试

**背景**
写请求在 HTTP 层的自动重试为 0 次（`services/api/src/ragflow/client.ts`：
`idempotentRead: false` 直接走一次 transport）。
但**操作层**原本会在下一轮轮询时把失败的写操作整个重来一次：
响应丢失 → 登记 `unknown_outcome` → 下一轮重新 POST。
这在语义上是**盲目重试**：远端可能已经创建了对象，重发会造出重复 dataset / 重复文档。

**决策**
每个写请求在发出**之前**先把「已尝试」标记写进 `operation.result.stage`，
之后结果未知时只允许**只读核对**，不允许重发：

| 写操作 | 已尝试标记 | 只读核对方式 | 唯一命中 | 不唯一 / 未命中 |
| --- | --- | --- | --- | --- |
| `knowledge_base.create` | `dataset_create_attempted` | `GET /api/v1/datasets?name=<稳定名称>` | 认领该 dataset 并置为 ready | 停留 `unknown_outcome`，转人工 |
| `document.upload` | `upload_attempted` | `GET /api/v1/datasets/{id}/documents` 按文件名匹配 | 认领该 document，继续解析 | 停留 `unknown_outcome`，转人工 |
| `document.parse` | `parse_attempted` | `GET .../documents?id=<docId>` 看 `run` | `run != UNSTART` 说明已在解析，直接进入轮询 | `run == UNSTART` 说明确实未开始，可安全发起 |
| `knowledge.withdraw` | —（删除前先读） | `GET .../documents` 看文档是否还在 | 文档已不在即视为撤回完成 | 文档仍在则再删一次 |

核对不通过的操作被登记为 `unknown_outcome` 并**推迟**下一次自动处理
（`operation.next_attempt_at`，默认 60 秒），既避免 worker 热循环，
也保证「无法确认」的状态会稳定地暴露出来而不是被自动「修好」。

**两种「写结果不可知」必须分开处理**（复审补充）：

| 情形 | 判据 | 处理 |
| --- | --- | --- |
| **响应丢失** | 写请求的响应没回来（`delivered_unknown`） | 结果不可知，**永远不重发**：登记 `unknown_outcome`，只做只读核对，核对不通过就转人工 |
| **崩溃窗口** | 上游写成功、本地提交之前进程退出（已尝试标记在库、本地没有远端 ID） | 先只读核对上游：命中唯一对象则认领；命中多个则转人工；**连续两次核对都未命中**才判定上一次写入没有生效，清掉发送意图后重发 |

「连续两次未命中」是**推断**而不是证明：上游写入与可查询之间可能存在可见性延迟。
但与「响应丢失」不同，崩溃窗口的本地事实是「已尝试标记在库、没有远端 ID」，
这本身就是「上一次发送很可能没有落地」的证据，因此允许在两次核对后重发。

**撤回是终态**：`withdrawn` 之后不能再改回 `ready` / `failed`。
epoch 栅栏挡不住这件事——迟到的是另一个操作（解析 / 重建），它持有自己的 epoch。
因此撤回有三层保护：推进前读数据库里的撤回事实、状态写入用条件更新
（`AND status <> 'withdrawn'`）、数据库触发器拒写（迁移 `010_withdrawn_terminal.sql`）。
撤回同时取消该版本在途的上传 / 解析 / 重建操作（`epoch + 1`，迟到写入命中 0 行）。

**影响**
- 副作用：无法确认的远端状态会停留在 `unknown_outcome` 直到人工介入，
  这是刻意的——**重复的 dataset 或重复的文档比一个显式的待核查状态更糟**。
- 人工核查步骤见 `docs/runbook.md` 第 6.3 节。

---

## D7：`authz_state` 行锁只覆盖本地授权判定与有界响应交付

**背景**
检索返回的证据必须在下发前复核授权。若在持有行锁期间调用上游，锁会跨越
网络往返，撤销操作会被长时间阻塞；若完全不锁，撤销与下发之间存在竞态窗口。

**决策**
- `authz_state` 的行锁（`SELECT ... FOR UPDATE`）只覆盖
  **「本地末次授权判定 + 有界响应构建」**这一段
  （`services/api/src/knowledge/service.ts` 的 `retrieval` 交付事务）。
- 行锁**不跨越上游网络调用**：上游检索在上游调用**之前**完成，
  拿到候选块之后才进入加锁事务做末次复核与证据落库。
- 行锁**不覆盖长时间下载流**：来源文件下载（`/sources/{fileId}/versions/{version}/download`）
  在锁外完成。
- 由此明确一条边界：**已经发送给客户端的字节无法召回**。
  撤销保证的是「撤销之后开始的请求不再拿到内容」，而不是「撤销会撤回已发出的内容」。

**影响**
- 撤销的语义在文档与接口契约中被显式声明，测试也据此断言
  （不得承诺召回已发送字节）。
- 授权版本 `authz_state.revision` 随每次授权变更递增，
  并写入证据快照（`evidence.authz_revision`），使「这份证据是在哪个授权版本下产生的」可追溯。

---

## D8：Agent 绑定同时要求 `asset:bind` 与 `asset:read`，页面权限表不是防线

**背景**
Agent 注册请求里带 `skill_refs`，即把具体的 Skill 版本绑到 Agent 版本上。
只校验 `asset:bind` 是不够的：绑定会让 Agent 具备引用该 Skill 的能力，
这本身就是一种读取能力。只在页面权限表里显示/隐藏按钮，服务端仍可被直接调用绕过。

**决策**
- 服务端在解析 `skill_refs` 时**同时**检查 `asset:bind` 与 `asset:read`，
  缺任一权限直接 `FORBIDDEN`（`services/api/src/registry/service.ts` 的 `resolveSkillRefs`）。
- 页面权限表与后端判定必须**口径一致**：前端不显示的能力，后端也必须拒绝；
  反过来后端允许的组合，页面也应当可用。
- `requested_permissions` 只能取**可下放白名单**（`asset:read`、`knowledge:read`、`source:read`）：
  - 不可下放的权限（如 `asset:manage`）在契约层就被拒绝（`CONTRACT_INVALID`）；
  - 可下放但当前主体并不持有的权限判为 `PERMISSION_ESCALATION`。

**影响**
- 前端权限表是**提示**，后端判定是**强制**；两者不一致时以服务端为准并修正前端。
- Agent 注册**不触发执行**（见 D3）：绑定只登记事实，不产生任何运行期效果。

---

## D9：内容摘要与审核并发用 CAS，不用「先查后写」

**背景**
审核接口要求客户端提交 `expected_hash`（它观察到的内容摘要）与
`expected_state_revision`。若服务端只是「先查后写」，两个并发审核都能通过校验，
后者覆盖前者。

**决策**
- 审核在**同一事务**内完成：`SELECT` 当前行 → 校验 `expected_hash` →
  `UPDATE ... WHERE state_revision = <期望值>`（CAS）→ 插入审核记录。
- CAS 影响行数为 0 即判定为 `STATE_CONFLICT`（409），不会静默覆盖。
- 审核记录**独立成表**（`knowledge_review`），真实落库：审核人（`reviewer`）、
  期望哈希（`expected_hash`）、理由（`reason`）、时间（`reviewed_at`）、
  有效期（`valid_from` / `valid_until`）。
- `knowledge_revision` 上同步保存当前结论的有效区间，供检索路径直接过滤，
  避免为「取最新一次审核」引入排序歧义。
- 客户端必须能读到内容摘要才能构造合法审核请求，因此
  `DocumentSummary.content_hash` 是公开契约字段。

**影响**
- 并发审核不会互相覆盖：后到者收到 409 而不是静默生效。
- 有效期与适用条件一起构成「这份知识在什么条件下、什么时间段内可用」的可判定语义。

---

## D10：`/assets/validate` 只列问题，不做「半失败即通过」

**背景**
`POST /assets/validate` 的语义是「对一份注册请求做完整校验并返回问题列表」。
实现上有两个坑：

1. **信封层错误被抛出，信封以下的问题被收集。** 同一个端点，
   非法版本号走 422、非法 slug 走 200 + `issues`，口径不一致，
   调用方无法用统一的方式读结论。
2. **本体不可达会被吞成「校验通过」。** 本体不可用抛的是 `ONTO_UNAVAILABLE`，
   它没有字段级 `details`；而收集逻辑用的是 `details ?? [默认问题]`，
   空数组不是 nullish，于是问题列表为空、`passed` 变成 `true`。
   这正是「本体不可用绝不降级为通过」这条硬约束要防的失败模式。

**决策**
- 这个端点**始终返回 200**，把能找到的所有问题一次性列进 `issues`；
  只有鉴权失败才是 4xx。`passed` 当且仅当 `issues` 为空时为 `true`。
- 任何进不去校验器的失败（本体不可达、载荷超限等）都必须变成**一条问题**，
  而不是被吞掉。问题原因带上错误码，便于调用方区分「内容不合法」与「平台没验完」。
- 同一套逻辑同样适用于 `POST /assets` 的注册路径：注册时本体不可用直接 503，
  不进入注册流程，不落任何行。

**影响**
- `POST /assets` 与 `POST /assets/validate` 的差别只在「是否落库」，
  校验结论的口径一致，不会出现「校验说通过、注册却失败」的错位。
- 代价：调用方不能靠状态码区分「内容不合法」与「平台没验完」，
  必须读 `issues[].reason` 里的错误码前缀。

