# aip 运行手册

本文覆盖 `aip` 服务的本地启动、部署启动、迁移、健康检查与故障处置。
所有命令都取自仓库根 `package.json` 与各包 `package.json` 的真实脚本，示例值一律是占位符，不含任何真实凭据。

## 1. 前置条件

| 组件 | 版本要求 | 依据 |
| --- | --- | --- |
| Node.js | `>=22.0.0 <23` | 根 `package.json` 的 `engines` |
| pnpm | `10.28.2` | 根 `package.json` 的 `packageManager` |
| PostgreSQL | 16（本仓库按 16.15 验证） | 迁移脚本使用 `NOT VALID` 约束、`jsonb`、`timestamptz` |
| RAGFlow | `v0.20.5`（仅静态契约起点，见 `docs/ragflow-lock.md`） | `services/api/src/config.ts` 的 `SUPPORTED_RAGFLOW_API_VERSION` |

工作区是 pnpm workspace，成员为 `packages/contracts`、`services/api`、`services/worker`。

```bash
pnpm install
```

## 2. 环境变量

配置只在 `services/api/src/config.ts` 的 `loadConfig()` 中从环境变量读取；缺失的必填项在启动时直接失败，不做静默降级。

### 2.1 必填

| 变量名 | 含义 | 示例占位 |
| --- | --- | --- |
| `AIP_PROJECT_ID` | 部署作用域（project）。它同时是数据隔离键与 URL 路径段 | `<project-id>` |
| `DATABASE_URL` | aip 独占的 PostgreSQL 连接串 | `postgres://<user>:<password>@<host>:5432/<database>` |
| `AIP_FILE_STORE_ROOT` | 受控文件存储根目录（来源文件正文） | `/var/lib/aip/files` |
| `OIDC_ISSUER` | 令牌签发方 | `https://<issuer>` |
| `OIDC_AUDIENCE` | 令牌受众 | `<audience>` |
| `RAGFLOW_BASE_URL` | RAGFlow 服务根地址（`/api/v1` 后缀会被自动裁掉） | `http://<ragflow-host>:9380` |
| `RAGFLOW_API_KEY` | **仅从环境变量读取的上游凭据，禁止入库、禁止落日志** | `<ragflow-api-key>` |
| `RAGFLOW_API_VERSION` | 固定契约版本，必须为 `v0.20.5`，其他值直接启动失败 | `v0.20.5` |

### 2.2 鉴权

| 变量名 | 含义 | 默认 | 示例占位 |
| --- | --- | --- | --- |
| `AUTH_MODE` | `jwks` 或 `hs256` | `jwks` | `jwks` |
| `OIDC_JWKS_URI` | JWKS 端点（`AUTH_MODE=jwks` 时使用） | 空串 | `https://<issuer>/.well-known/jwks.json` |
| `AUTH_HS256_SECRET` | 共享密钥（`AUTH_MODE=hs256` 时使用）。**仅从环境变量读取，禁止入库、禁止落日志** | 空 | `<hs256-secret>` |

`NODE_ENV=production` 时 `AUTH_MODE` 必须是 `jwks`，否则启动失败。

### 2.3 RAGFlow 出口与检索参数

| 变量名 | 含义 | 默认 |
| --- | --- | --- |
| `RAGFLOW_EMBEDDING_MODEL` | 嵌入模型名 | 空 |
| `RAGFLOW_EMBEDDING_REVISION` | 嵌入模型修订号（写入 `index_revision.embedding_revision`） | 空 |
| `RAGFLOW_CHUNK_METHOD` | 分块方法 | `naive` |
| `RAGFLOW_PARSER_CONFIG_JSON` | 解析器配置 JSON 对象 | `{}` |
| `RAGFLOW_CONNECT_TIMEOUT_MS` | 连接超时 | `3000` |
| `RAGFLOW_READ_TIMEOUT_MS` | 单次读超时 | `10000` |
| `RAGFLOW_UPLOAD_TIMEOUT_MS` | 上传专用超时 | `60000` |
| `RAGFLOW_READ_BUDGET_MS` | 只读调用总预算（连接 + 单次超时 + 退避 + Retry-After） | `30000` |
| `RAGFLOW_READ_MAX_ATTEMPTS` | 只读调用最大尝试次数 | `3` |
| `RAGFLOW_SIMILARITY_THRESHOLD` | 相似度阈值 | `0.2` |
| `RAGFLOW_VECTOR_SIMILARITY_WEIGHT` | 向量相似度权重 | `0.3` |
| `RAGFLOW_TOP_K` | 检索 `top_k` | `1024` |
| `RAGFLOW_IMAGE_DIGEST` | 镜像摘要锁定值（写入文档，不参与运行期判断） | 空 |
| `RAGFLOW_SOURCE_SHA` | 契约来源摘要，缺省时 `parser_hash` 记为 `unpinned` | 空 |

### 2.4 平台限额

| 变量名 | 含义 | 默认 |
| --- | --- | --- |
| `AIP_UPLOAD_MAX_BYTES` | 单文件上传上限 | `20971520`（20 MiB） |
| `AIP_PARSE_DEADLINE_MS` | 解析截止时间，超时进入终态失败 | `1200000`（20 分钟） |
| `AIP_RETRIEVAL_MAX_DOCUMENTS` | 单次检索的授权文档白名单上限 | `200` |

### 2.5 本体（onto）概念校验

| 变量名 | 含义 | 默认 |
| --- | --- | --- |
| `ONTO_BASE_URL` | 本体服务根地址；**未配置时概念校验一律判为不通过**，不会降级为通过 | 空 |
| `ONTO_API_AUDIENCE` | 本体服务受众（作为 `x-audience` 头发送） | 空 |

### 2.6 运行时与运维

| 变量名 | 含义 | 默认 | 读取位置 |
| --- | --- | --- | --- |
| `PORT` | API 监听端口 | `8080` | `services/api/src/main.ts` |
| `LOG_LEVEL` | pino 日志级别 | `info` | `services/api/src/main.ts`、`services/worker/src/main.ts` |
| `WORKER_POLL_INTERVAL_MS` | Worker 轮询间隔 | `2000` | `services/worker/src/main.ts` |
| `WORKER_BATCH_SIZE` | 单轮可领取操作数上限 | `10` | `services/worker/src/main.ts` |
| `AIP_TRUSTED_PROXY` | 可信代理声明 | 空 | `services/api/src/config.ts` |
| `AIP_MIGRATIONS_DIR` | 迁移目录覆盖（源码/构建产物路径不一致时使用） | 自动探测 | `services/api/src/db/migrate.ts` |
| `RUN_REAL_RAGFLOW` | 置 `1` 启用真实 RAGFlow 联调层 | 未设置 | `services/api/src/config.ts` |
| `RAGFLOW_TEST_PROJECT_ID` | 真实联调使用的 project id | 空 | `services/api/src/config.ts` |

完整清单见仓库根 `.env.example`。

## 3. 迁移

迁移账本表为 `aip_schema_migration`（`filename` 主键 + `checksum` + `applied_at`）。
执行时用 advisory lock `8675309001` 串行化，逐文件独立事务，校验和 = 文件内容的 sha256；已登记文件的校验和不一致会直接失败。

```bash
# 依赖环境变量已就绪
pnpm migrate
# 输出：migrations applied: N, already present: M
```

迁移文件位于 `services/api/src/db/migrations/`，按文件名排序执行：

| 文件 | 内容 |
| --- | --- |
| `001_registry.sql` | `asset` / `asset_revision` / `agent_skill_binding`，含版本内容不可变触发器与注册状态机触发器 |
| `002_knowledge.sql` | `knowledge_base` / `source_file_revision` / `knowledge_revision` / `knowledge_review` / `index_revision` / `knowledge_index_map` |
| `003_authorization.sql` | `principal_grant` / `document_grant` / `authz_state` / `local_deny` |
| `004_operations.sql` | `operation` / `idempotency_record` / `audit_event` |
| `005_evidence.sql` | `evidence` |
| `006_review_validity.sql` | 审核有效期列与约束、`applies_to` 模式显式化（增量、只增不改） |

迁移策略：只做向前兼容的增量变更，不改写既有列语义、不删除数据；新增约束使用 `NOT VALID`，只约束新写入的行。

## 4. 启动

### 4.1 开发模式

```bash
# 终端 1：API
pnpm --filter @aip/api run dev      # tsx watch src/main.ts

# 终端 2：Worker
pnpm --filter @aip/worker run dev   # tsx watch src/main.ts
```

### 4.2 构建后运行

```bash
pnpm build                          # contracts -> api -> worker
pnpm --filter @aip/api run start    # node dist/src/main.js
pnpm --filter @aip/worker run start # node dist/main.js
```

### 4.3 API 路由前缀

业务路由挂在 `/api/v1/projects/:projectId` 下，`projectId` 必须与令牌中的 scope 一致，否则 403。
`/healthz` 不在项目前缀下，无需鉴权。

## 5. 健康检查

```bash
curl -sS http://<host>:<port>/healthz
# {"data":{"status":"ok"}}
```

数据库连通性可另外确认：

```bash
psql "$DATABASE_URL" -c 'SELECT filename, applied_at FROM aip_schema_migration ORDER BY filename;'
```

Worker 健康以日志为准：启动时打印 `aip worker started`，每轮打印 `operation advanced`。

## 6. 常见故障与处置

### 6.1 启动期配置错误

`loadConfig()` 抛出的 `ConfigError` 只会打印 `invalid configuration` 与缺失变量名，不含变量值。常见项：

- `missing required environment variable: <NAME>` —— 该变量未设置或为空串。
- `RAGFLOW_API_VERSION must be v0.20.5` —— 版本与已锁定契约不一致。换版本必须先做契约复核并新增专用适配器配置，不能直接改这个值。
- `AUTH_MODE must be jwks in production` —— 生产环境不允许共享密钥模式。
- `environment variable <NAME> must be a positive integer` —— 数值型变量非法。

### 6.2 上游 RAGFlow 不可用

读请求有总预算保护：最多 `RAGFLOW_READ_MAX_ATTEMPTS` 次尝试，整体不超过 `RAGFLOW_READ_BUDGET_MS`；
每次尝试的连接/读超时按剩余预算切分，所以「多次尝试 + 退避」不会突破总预算。写请求不自动重试。

| 现象 | 平台错误码 | HTTP | 处置 |
| --- | --- | --- | --- |
| 上游 5xx / 连接失败 | `RAGFLOW_UNAVAILABLE` | 503 | 检查 RAGFlow 可用性与 `RAGFLOW_API_KEY`；平台不会自动重发写请求 |
| 上游读超时 | `RAGFLOW_TIMEOUT` | 504 | 视需要调大 `RAGFLOW_READ_TIMEOUT_MS`，但受 `RAGFLOW_READ_BUDGET_MS` 约束 |
| 上游返回体不符合固定契约 | `RAGFLOW_PROTOCOL_ERROR` | 502 | 核对该 tag 的实际实现与 `docs/ragflow-lock.md`；不要在适配器里猜测字段 |
| 上游 401/403 | `RAGFLOW_UNAVAILABLE` | 503 | 凭据或权限问题，检查 `RAGFLOW_API_KEY` |

### 6.3 `unknown_outcome` 操作的人工核查

写请求的响应丢失时，平台**不会盲目重发**，而是把操作登记为 `unknown_outcome` 并推迟下一次自动处理（推迟时长由 `OperationsDeps.unknownOutcomeDeferMs` 决定，默认 60 秒）。核对与认领依赖只读查询：

| 写操作 | 只读核对方式 | 唯一命中时 | 命中 0 个或多个时 |
| --- | --- | --- | --- |
| `knowledge_base.create` | `GET /api/v1/datasets?name=<稳定名称>` | 认领该 dataset，继续 | 停留 `unknown_outcome`，转人工 |
| `document.upload` | `GET /api/v1/datasets/{id}/documents` 按文件名匹配 | 认领该 document，继续 | 停留 `unknown_outcome`，转人工 |
| `document.parse` | `GET /api/v1/datasets/{id}/documents?id=<docId>` 看 `run` | `run != UNSTART` 说明已在解析 | `run == UNSTART` 说明确实没开始，可安全再发起 |
| `knowledge.withdraw` | `GET /api/v1/datasets/{id}/documents` 看文档是否还在 | 文档已不在则视为撤回完成 | 文档仍在则再删一次 |

排查用查询：

```sql
-- 该作用域下所有未终结的操作
SELECT id, kind, state, attempt, epoch, lease_until, next_attempt_at,
       last_error, resource_id, remote_id, created_at, updated_at
  FROM operation
 WHERE scope_id = '<project-id>'
   AND state IN ('pending', 'in_progress', 'unknown_outcome')
 ORDER BY created_at;

-- 某个操作当前的阶段标记（决定用哪种只读核对）
SELECT id, kind, state, result
  FROM operation
 WHERE scope_id = '<project-id>' AND id = '<operation-id>';

-- 对应知识版本的状态
SELECT knowledge_id, version, review_status, status, state_revision, applies_to
  FROM knowledge_revision
 WHERE scope_id = '<project-id>' AND knowledge_id = '<knowledge-id>';
```

`operation.result` 是 jsonb，其中的 `stage` 取值含义：

| stage | 含义 |
| --- | --- |
| `dataset_pending` | 知识库已登记，尚未发出 dataset 创建请求 |
| `dataset_create_attempted` | **已发出** dataset 创建请求，结果未知；禁止重发 |
| `dataset_created` | dataset 已确认创建 |
| `upload_pending` | 文档已登记，尚未发出上传请求 |
| `upload_attempted` | **已发出**上传请求，结果未知；禁止重发 |
| `uploaded` | 文档已确认上传 |
| `parse_attempted` | **已发出**解析启动请求，结果未知；先只读确认 `run` |
| `parse_started` | 解析已启动，轮询由独立的 `document.parse` 操作负责 |
| `withdraw_pending` | 撤回已登记，等待远端清理 |

人工确认远端事实后，如需推动操作继续，可把 `next_attempt_at` 置空并把 `state` 改回 `in_progress`，让 Worker 重新领取：

```sql
UPDATE operation
   SET state = 'in_progress', next_attempt_at = NULL, updated_at = now()
 WHERE scope_id = '<project-id>' AND id = '<operation-id>';
```

**不要**把 `state` 直接改成 `succeeded`：远端映射（`remote_id`）与本地知识版本状态必须由平台的推进逻辑写入，否则本地会出现「显示 ready 但上游没有对应对象」的状态。

### 6.4 解析未完成

- 解析有截止时间 `AIP_PARSE_DEADLINE_MS`（默认 20 分钟）。超过后操作进入终态 `failed`，知识版本 `status` 置为 `failed`，自动轮询停止。
- 上游报 `FAIL`/`CANCEL` 同样进入终态 `failed`，`last_error` 记录上游原因（已做清洗，不回显原始报文）。
- 上游报 `DONE` 但 chunk 数为 0：知识版本状态置为 `empty`，不算成功。

### 6.5 检索没有结果

| `status` | 含义 |
| --- | --- |
| `authorized_evidence` | 有命中且已通过末次授权复核 |
| `no_match` | 授权集合为空，或授权集合中没有任何可适用内容 |
| `needs_context` | 只有条件型知识且检索上下文不足以命中 `applies_to.conditions` |

空授权与上下文不足都**不产生任何上游 RAGFlow 请求**。若要排查授权，先看 `document_grant`：

```sql
SELECT knowledge_id, knowledge_version, subject, can_read, can_download
  FROM document_grant
 WHERE scope_id = '<project-id>' AND subject = '<subject>';
```

### 6.6 授权被撤销

撤回（`POST /knowledge/{id}/versions/{version}/withdraw`）与授权吊销都会递增 `authz_state.revision`：

```sql
SELECT scope_id, revision FROM authz_state WHERE scope_id = '<project-id>';
```

授权行锁（`SELECT ... FOR UPDATE`）只覆盖「本地末次授权判定 + 有界响应交付」这一段，不跨越上游网络调用，也不覆盖长时间下载流。因此：**已经发出的字节无法召回**，撤销只保证撤销之后开始的请求不再拿到内容。

## 7. 运维命令

授予/撤销某个主体的文档级授权（凭据只从环境变量读取，不接受命令行传入）：

```bash
# 授予读取 + 下载
pnpm grant:document -- --scope <project-id> --knowledge-id <knowledge-id> --version <version> --subject <subject>

# 只授予读取，不允许下载
pnpm grant:document -- --scope <project-id> --knowledge-id <knowledge-id> --version <version> --subject <subject> --no-download

# 撤销
pnpm grant:document -- --scope <project-id> --knowledge-id <knowledge-id> --version <version> --subject <subject> --revoke
```

输出为一行 JSON：`{"action":"granted","authz_revision":N}`。

## 8. 测试

```bash
pnpm typecheck        # 三个包的类型检查 + 测试树的类型检查
pnpm test:unit        # 纯单元层
pnpm test:db          # 需要 PostgreSQL：迁移账本、隔离、注册、绑定、竞态
pnpm test:contract    # 需要 PostgreSQL：RAGFlow 固定契约（上游为记录式替身）
pnpm test:e2e         # 需要 PostgreSQL：端到端（上游为记录式替身）
pnpm test             # 上述四层的串联
pnpm test:ragflow:real # 真实 RAGFlow 联调，缺配置时必须非零退出
```

数据库层与契约层连接的是**测试库**，不是服务运行库，连接串来自 `AIP_TEST_DATABASE_URL`
（未设置时默认指向本机一次性测试容器 `postgres://aip_test:aip_test_pw@127.0.0.1:55433/aip_test`）。
测试自行创建隔离 schema，测试结束清理自己创建的 schema，不会触碰服务库与其它项目的数据。

真实联调层需要 `RUN_REAL_RAGFLOW=1` 与 `RAGFLOW_API_KEY`、`RAGFLOW_BASE_URL` 等，
另外可用 `AIP_REAL_DATABASE_URL` 覆盖联调用的库、`AIP_REAL_PARSE_TIMEOUT_MS` 覆盖解析等待上限
（默认 600000 毫秒），详见 `docs/ragflow-lock.md`。

### 8.1 真实联调层的两种结果，含义完全不同

```bash
# 未启用：报告 NOT RUN，退出码 0
pnpm test:ragflow:real

# 启用但配置不齐：列出缺失的配置项名称，退出码非 0
RUN_REAL_RAGFLOW=1 pnpm test:ragflow:real
```

NOT RUN 的报告默认不打印在终端摘要里，需要用详细报告器才能看到：

```bash
pnpm test:ragflow:real -- --reporter=verbose
```

缺失项清单与配置项名称见 `tests/real/helpers.ts` 的 `REAL_ENV_NAMES`。
**缺配置时这层必须非零退出**，不允许把「被跳过」记成「联调通过」。

## 9. 回滚

- **代码回滚**：分支回退到已知提交后重新 `pnpm build` 并重启 API 与 Worker。数据库不做自动回滚。
- **数据回滚**：本批迁移只增不改、向前兼容，因此代码回滚到迁移之前不会因缺列而失败；已写入的数据保留。
- **迁移不可逆项**：`006_review_validity.sql` 会把 `knowledge_revision.applies_to` 的空对象回填为 `{"mode":"unconditional"}`。这是把既有语义显式化，不改变可见范围，但属于数据写入，撤销需要显式 `UPDATE` 回滚。
- **停机顺序**：先停 Worker（`SIGTERM`），再停 API（`SIGTERM`）。两者都实现了 `SIGTERM`/`SIGINT` 优雅退出：停止接单、关闭连接池。
