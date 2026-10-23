# RAGFlow 版本锁定与契约清单

本文件是 aip 适配器与 RAGFlow 之间**唯一的事实来源**。
适配器代码位于 `services/api/src/ragflow/`（`client.ts` / `adapter.ts` / `schemas.ts` / `errors.ts`），
本文的每一条都能在代码里找到对应实现。

**当前锁定版本：`v0.20.5`**（`SUPPORTED_RAGFLOW_API_VERSION`，`services/api/src/config.ts`）。

> `v0.20.5` 是**本批唯一验证过的静态契约起点**，不是生产选型。
> 见 `docs/decisions.md` D2。

---

## 1. 通用约定

| 项 | 约定 | 实现位置 |
| --- | --- | --- |
| 基础路径 | `{baseUrl}/api/v1/`，`RAGFLOW_BASE_URL` 末尾的 `/api/v1` 会被自动裁掉 | `config.ts` 的 `stripApiSuffix`、`client.ts` 的 `buildRawRequest` |
| 鉴权 | `Authorization: Bearer <RAGFLOW_API_KEY>` | `client.ts` 的 `buildRawRequest` |
| 响应信封 | `{ "code": <number>, "data": <any>, "message": <string> }` | `schemas.ts` 的 `parseEnvelope` |
| 成功判定 | `code` 必须是**数字**且等于 `0`；否则是业务失败（`RagFlowBusinessError`） | `schemas.ts` 的 `parseEnvelope` |
| HTTP 状态 | 仅 `200` / `201` 视为成功；`401`/`403` 归为凭据问题；`>=500` 归为上游不可用；其余为协议错误 | `adapter.ts` 的 `assertOk` |
| 重定向 | **不跟随**。避免把服务端 key 转发到未知地址 | `client.ts` 的 `nodeTransport`（无 redirect 处理） |
| 写请求重试 | **0 次**。`idempotentRead: false` 直接单次 transport | `client.ts` 的 `execute` |
| 读请求重试 | 最多 `RAGFLOW_READ_MAX_ATTEMPTS`（默认 3）次，总耗时不超过 `RAGFLOW_READ_BUDGET_MS`（默认 30s），退避 250ms/1000ms + jitter，遵守 `Retry-After` | `client.ts` 的 `execute` |
| 读请求单次尝试的超时 | 按**剩余总预算**切分：每次尝试的连接超时与读超时都取 `min(配置值, 剩余预算)`，保证「多次尝试 + 退避」不超过总预算 | `client.ts` 的 `nodeTransport`（`attemptTimeoutMs`） |
| 上传超时 | 独立的长超时 `RAGFLOW_UPLOAD_TIMEOUT_MS`（默认 60s） | `client.ts` 的 `buildRawRequest` |

### 1.1 已知实现陷阱（必须遵守，勿「优化」）

1. **`highlight` 必须是字符串 `'false'`**。
   该 tag 只把字符串 `"false"` 视为关闭高亮，布尔值 `false` 会被当成**开启**。
   实现：`adapter.ts` 的 `retrieve` 中 `highlight: 'false'`。
2. **文档列表被包在 `data.docs` 里**，不是 `data` 直接是数组。
   实现：`schemas.ts` 的 `parseDocumentStatus` / `parseDocumentList`。
3. **`run` 状态枚举**：`UNSTART` / `RUNNING` / `CANCEL` / `DONE` / `FAIL`。
   该 tag 的列表实现把 `0..4` 映射为枚举名，但存在重复赋值路径，
   因此**只接受明确枚举名或 `0..4` 的字符串表示**；`null` 与未知值都是协议错误。
   实现：`schemas.ts` 的 `normalizeRunStatus`。
4. **检索必须同时给出 `dataset_ids` 与 `document_ids`**。
   `document_ids` 为空时该 tag 的实现会**退化为按 metadata 过滤全库**。
   适配器在调用前直接阻断：`adapter.ts` 的 `retrieve` 开头抛 `RagFlowProtocolError`。
5. **上传响应必须是长度恰为 1 的数组**，且条目含 `id`。
   实现：`schemas.ts` 的 `parseUploadedDocuments`。
6. **dataset 创建响应必须有 `data.id`**。缺 `id` 是协议错误，不得猜测。
   实现：`schemas.ts` 的 `parseCreatedDataset`。
7. **dataset 名称是稳定短名**，格式 `aip-{scope}-{16 位十六进制}`，
   用于「写操作结果未知」时按名称核对远端。
   实现：`services/api/src/util/hash.ts` 的 `newDatasetName`。
8. **解析完成的判据是 `run == 'DONE'` 且 `progress >= 1` 且 `chunk_count > 0`**。
   `DONE` 但 chunk 数为 0 记为 `empty`，不记为成功。

---

## 2. 端点逐条清单

### 2.1 创建 dataset

```
POST /api/v1/datasets
```

请求体：

```json
{
  "name": "aip-<scope>-<hex16>",
  "description": "",
  "permission": "me",
  "chunk_method": "naive",
  "embedding_model": "<RAGFLOW_EMBEDDING_MODEL，可选>",
  "parser_config": { "<RAGFLOW_PARSER_CONFIG_JSON，可选>" }
}
```

响应（必须 `code == 0`）：

```json
{ "code": 0, "data": { "id": "<datasetId>" }, "message": "success" }
```

必需字段：`data.id`（字符串非空）。缺失即协议错误。
实现：`adapter.ts` 的 `createDataset`。

### 2.2 按名称列出 dataset（只读核对用）

```
GET /api/v1/datasets?name=<encodedName>&page=1&page_size=100
```

响应 `data` 是**数组**，元素形如 `{ "id": "...", "name": "..." }`。
实现：`adapter.ts` 的 `listDatasetsByName`。
用途：写操作响应丢失后按稳定名称核对，唯一命中才认领，命中 0 个或多个都不认领
（`docs/decisions.md` D6）。

### 2.3 上传文档

```
POST /api/v1/datasets/{datasetId}/documents
Content-Type: multipart/form-data
```

表单字段固定为 `file`（`name` / `filename` / `Content-Type` + 二进制内容）。

响应（必须 `code == 0`）：

```json
{ "code": 0, "data": [ { "id": "<documentId>", "dataset_id": "<datasetId>" } ], "message": "success" }
```

必需字段：`data` 是**长度恰为 1** 的数组，元素含 `id`。
若元素带 `dataset_id`（或 `knowledgebase_id`），必须与请求的 dataset 一致，否则协议错误。
实现：`adapter.ts` 的 `uploadDocument`、`client.ts` 的 `buildMultipartBody`。

### 2.4 查询单个文档状态（解析轮询）

```
GET /api/v1/datasets/{datasetId}/documents?id={documentId}&page=1&page_size=1
```

响应：

```json
{
  "code": 0,
  "data": {
    "docs": [
      {
        "id": "<documentId>",
        "name": "...",
        "run": "RUNNING",
        "progress": 0.4,
        "chunk_count": null,
        "progress_msg": ""
      }
    ]
  },
  "message": "success"
}
```

必需字段：`data.docs` 非空数组，首项含 `id`、`run`。
`data.docs[0].id` 必须等于请求的 `documentId`，否则协议错误。
实现：`adapter.ts` 的 `getDocumentStatus`、`schemas.ts` 的 `parseDocumentStatus`。

### 2.5 列出数据集内文档（只读核对用）

```
GET /api/v1/datasets/{datasetId}/documents?page=1&page_size=100
```

响应与 2.4 同形：`data.docs[]`，每项含 `id` 与 `name`。
实现：`adapter.ts` 的 `listDocuments`、`schemas.ts` 的 `parseDocumentList`。
用途：上传响应丢失后按文件名核对；撤回前确认文档是否还在。

### 2.6 启动解析

```
POST /api/v1/datasets/{datasetId}/chunks
```

请求体：

```json
{ "document_ids": ["<documentId>"] }
```

响应：`{ "code": 0, "data": true, "message": "success" }`。
`document_ids` 为空数组时适配器直接抛协议错误，不发请求。
实现：`adapter.ts` 的 `startParse`。

### 2.7 检索

```
POST /api/v1/retrieval
```

请求体：

```json
{
  "question": "<query>",
  "dataset_ids": ["<datasetId>"],
  "document_ids": ["<documentId>", "..."],
  "page": 1,
  "page_size": 10,
  "top_k": 1024,
  "similarity_threshold": 0.2,
  "vector_similarity_weight": 0.3,
  "use_kg": false,
  "keyword": false,
  "highlight": "false"
}
```

`page_size` 取本次请求的 `top_n`（契约层上限 `RETRIEVAL_TOP_N_MAX = 20`）。

响应：

```json
{
  "code": 0,
  "data": {
    "chunks": [
      {
        "id": "<chunkId>",
        "content": "...",
        "document_id": "<documentId>",
        "dataset_id": "<datasetId>",
        "similarity": 0.83,
        "positions": null
      }
    ]
  },
  "message": "success"
}
```

必需字段：`data.chunks` 为数组，每项含 `id`、`content`、`document_id`，
以及 `dataset_id` 或 `kb_id` 之一。
`positions` 为 `null` 时表示**没有可核验位置**，平台据此把 `source_locator.incomplete` 置为 `true`，
**禁止伪造页码**。
实现：`adapter.ts` 的 `retrieve`、`schemas.ts` 的 `parseRetrievalChunks`。

### 2.8 删除文档

```
DELETE /api/v1/datasets/{datasetId}/documents/{documentId}
```

响应：`{ "code": 0, "data": true, "message": "success" }`。
实现：`adapter.ts` 的 `deleteDocument`。

---

## 3. 锁定清单

| 锁定项 | 环境变量 | 当前值 | 说明 |
| --- | --- | --- | --- |
| 契约版本 | `RAGFLOW_API_VERSION` | `v0.20.5` | 非此值启动失败 |
| 镜像 digest | `RAGFLOW_IMAGE_DIGEST` | **未锁定** | 生产落地前必须补齐并记录到本文件第 5 节 |
| 契约来源摘要 | `RAGFLOW_SOURCE_SHA` | **未锁定** | 缺省时 `index_revision.parser_hash` 记为 `unpinned` |
| 嵌入模型 | `RAGFLOW_EMBEDDING_MODEL` | **未锁定** | 生产必须固定到具体模型名 |
| 嵌入模型修订 | `RAGFLOW_EMBEDDING_REVISION` | **未锁定** | 生产必须固定到具体修订号，否则 `embedding_revision` 记为 `unversioned` |
| 分块方法 | `RAGFLOW_CHUNK_METHOD` | `naive`（默认值） | 生产建议显式设置 |
| 解析器配置 | `RAGFLOW_PARSER_CONFIG_JSON` | 空 | 生产建议显式固定 |

> **未锁定项清单**（本批交付时全部为「未锁定」）：
> `RAGFLOW_IMAGE_DIGEST`、`RAGFLOW_SOURCE_SHA`、`RAGFLOW_EMBEDDING_MODEL`、
> `RAGFLOW_EMBEDDING_REVISION`。
> 原因是本批**没有真实 RAGFlow 环境**，无法取得真实 digest 与模型修订号，
> 不得编造。这四项的缺失直接导致真实集成项（M26/M27）无法验收。

---

## 4. 契约复核步骤

任何一次对 RAGFlow 的版本变更或行为怀疑，都按下列步骤复核，**不得跳过**：

1. **拿到确切版本**：确认镜像 digest 与运行中的 tag 一致。
   ```bash
   docker inspect --format '{{index .RepoDigests 0}}' <ragflow-image>
   ```
2. **逐端点抓真实报文**：对第 2 节的每个端点，用**同一份 API key** 跑一次，
   把请求体与响应体（含 `code`/`data`/`message`）原样记录。
   至少覆盖：dataset 创建、dataset 按名列出、文档上传、文档状态查询、
   文档列表、解析启动、检索、文档删除。
3. **比对本文第 2 节**：重点核对第 1.1 节的八条陷阱是否仍然成立
   （尤其 `highlight` 的字符串语义、`data.docs` 包装、`run` 的数值映射、
   `document_ids` 为空时的退化行为）。
4. **更新适配器与本文**：契约变化先改 `services/api/src/ragflow/schemas.ts` 的投影，
   再改 `adapter.ts`，最后更新本文。**三者必须同批次变更**，不允许只改代码不改本文。
5. **更新锁定清单**：把第 3 节的镜像 digest、模型名与修订号填成真实值。
6. **重跑契约层与真实联调层**：
   ```bash
   pnpm test:contract
   RUN_REAL_RAGFLOW=1 pnpm test:ragflow:real
   ```
   真实联调层在缺配置时必须**非零退出**，不允许把「被跳过」记成「联调通过」。
7. **改 `RAGFLOW_API_VERSION` 的时机**：只有当新版本的契约已被本文件完整记录、
   且适配器已按新契约重写并通过契约层测试后，才允许改这个值。

---

## 5. 版本变更登记

| 日期 | 契约版本 | 镜像 digest | 嵌入模型 / 修订 | 复核人 | 备注 |
| --- | --- | --- | --- | --- | --- |
| — | `v0.20.5` | 未锁定 | 未锁定 | — | 首批交付：仅完成静态契约与替身测试，真实集成 NOT RUN |

---

## 6. 替身与真实环境的边界

本仓库的契约层与端到端层用**记录式替身**（`tests/helpers/ragflow.ts`）替换上游：
替身实现本文件第 2 节的最小协议投影，并**完整记录每一个到达的 HTTP 请求**，
使得「空授权时出口请求数为 0」「写操作只发了一次 POST」这类行为可以被断言，
而不是靠日志推断。

替身测试通过**不等于**与真实 RAGFlow 联调通过。真实联调由 `tests/real/` 覆盖，
需要 `RUN_REAL_RAGFLOW=1` 与完整配置，缺配置时非零退出。
两者的结果在交付说明中**分开汇报**。
