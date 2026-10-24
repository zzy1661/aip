# 本地 RAGFlow 栈（aip 真实联调用）

本目录提供一套**本地开发用**的 RAGFlow v0.20.5 栈，用于跑 aip 的真实联调层
（`pnpm test:ragflow:real`，即 M26 / M27）。

它与 aip 自身的服务栈、仓库里已有的其它容器完全隔离：

- 独立 compose project 名 `aip-ragflow`，容器名形如 `aip-ragflow-es01-1`；
- 独立数据卷（`aip-ragflow_esdata` 等）与独立网络（`aip-ragflow_ragflow`）；
- 不使用 `container_name:`，不会与机器上已有的其它 RAGFlow 栈容器重名；
- 所有端口**只绑定 `127.0.0.1`**，不对局域网暴露。

## 目录内容

| 文件 | 用途 |
| --- | --- |
| `compose.yaml` | 栈定义，镜像全部按 digest 固定 |
| `init.sql` | 与官方同版本的建库脚本，不含凭据 |
| `create-local-account.sh` | 注册本地账号并签发 API Key（结果写入 `.env.api-key`） |
| `.env.example` | 环境变量模板（占位符，可提交） |
| `.env` | 本地真实取值，**已被 `.gitignore` 忽略，禁止提交** |
| `.env.api-key` | 签发出来的 API Key，**已被 `.gitignore` 忽略，禁止提交** |

## 首次准备

```bash
cd deploy/ragflow
cp .env.example .env
# 把 .env 里的 <replace-me> 换成本地随机值（至少 5 处口令 + 1 处 32 位以上的 secret）
```

## 启动 / 停止 / 日志

```bash
cd deploy/ragflow

# 启动
docker compose --env-file .env -f compose.yaml up -d

# 查看状态与健康检查
docker compose --env-file .env -f compose.yaml ps

# 跟踪日志（全部服务）
docker compose --env-file .env -f compose.yaml logs -f

# 只看 RAGFlow 本体
docker compose --env-file .env -f compose.yaml logs -f ragflow

# 停止（保留数据卷）
docker compose --env-file .env -f compose.yaml down

# 停止并删除数据卷（会丢失本栈内的知识库）
docker compose --env-file .env -f compose.yaml down -v
```

服务由 Docker 自己管理生命周期，不随本仓库的进程退出而停止。

## 端口

官方默认端口（ES 1200 / MySQL 5455 / Redis 6379 / MinIO 9000-9001 / SVR 9380）
在本机已被其它服务或历史栈占用，因此整体后移：

| 服务 | 容器内端口 | 本机地址 |
| --- | --- | --- |
| RAGFlow HTTP API | 9380 | `http://127.0.0.1:19380` |
| Elasticsearch | 9200 | `http://127.0.0.1:19200` |
| MySQL | 3306 | `127.0.0.1:15455` |
| Valkey | 6379 | `127.0.0.1:16379` |
| MinIO API | 9000 | `http://127.0.0.1:19000` |
| MinIO 控制台 | 9001 | `http://127.0.0.1:19001` |

## 镜像与架构

- `infiniflow/ragflow:v0.20.5` 只有 **amd64** 镜像，本机是 arm64（Apple Silicon），
  因此 RAGFlow 本体跑在 Docker Desktop 的 x86 模拟层下，启动比原生慢；
  其余依赖（ES / MySQL / Valkey / MinIO）都有 arm64 镜像，原生运行。
- 用**完整版**而不是 `-slim`：`-slim` 镜像里没有 torch 与 FlagEmbedding，
  内置嵌入模型不可用，只能接外部（付费）向量服务；完整版自带
  `BAAI/bge-large-zh-v1.5` 与 `maidalun1020/bce-embedding-base_v1`，
  本地即可完成嵌入，不需要任何外部模型凭据。
- 完整版把模型烘焙在镜像内的 `/root/.ragflow`，**不要**在该路径上挂数据卷，
  否则会把内置模型遮住。

## MinIO 镜像的取用

官方 v0.20.5 用 `quay.io/minio/minio:RELEASE.2025-06-13T11-33-47Z`，但该仓库对
匿名拉取返回 401（本机网络如此，Docker Hub 上的 `minio/minio` 仓库也已不存在）。
因此这里固定到本机镜像库里已有的较早发布版本，并**按 digest 锁死字节**：

```
quay.io/minio/minio:RELEASE.2023-12-20T01-00-02Z@sha256:5702ea3614203466e8e6616469e460567dc0c82def5a024a90426b25ee4a4d23
```

## 首次使用需要创建 API Key

RAGFlow 的 `/api/v1/**` 接口用 API Key 鉴权。本栈开启了注册
（`REGISTER_ENABLED=1`），创建流程见 `docs/ragflow-lock.md` 的「本地栈 API Key 获取」一节。
API Key **只从环境变量读取**，不要写进仓库里的任何文件。

```bash
cd deploy/ragflow
RAGFLOW_ACCOUNT_PASSWORD='<本地口令>' ./create-local-account.sh
# API Key 写入 ./.env.api-key（已被 .gitignore 忽略），脚本不打印取值
```

## 跑真实联调层

```bash
cd ../..
set -a; . deploy/ragflow/.env.api-key; set +a
RUN_REAL_RAGFLOW=1 RAGFLOW_BASE_URL=http://127.0.0.1:19380 \
  RAGFLOW_API_VERSION=v0.20.5 RAGFLOW_TEST_PROJECT_ID=<aip 项目 id> \
  RAGFLOW_EMBEDDING_MODEL='BAAI/bge-large-zh-v1.5@BAAI' \
  RAGFLOW_EMBEDDING_REVISION=79e7739b6ab944e86d6171e44d24c997fc1e0116 \
  RAGFLOW_IMAGE_DIGEST=sha256:d95d0e4dc83a96fafffc5238f15c9192ed76ef2d320adb516f010bdc9876455a \
  RAGFLOW_SOURCE_SHA=e650f0d368b357b0b434b7838177435e3d217de3 \
  pnpm exec vitest run --config vitest.real.config.ts --reporter=verbose
```

2026-10-24 已用本栈跑通：4 个文件 / 13 个用例全部通过
（M26 闭环、M27 隔离失败、M27 真实不可达 503、M27 真实解析失败保持 failed）。

> `RAGFLOW_SOURCE_SHA` 填**上游 RAGFlow 的提交**（`v0.20.5` tag 指向的 commit），
> 不是本仓库的提交：报告里的 `ragflow.source_sha` 与 `parser_digest` 记的是上游解析器来源。
> 被测 aip 代码的 SHA 由报告的 `commit` 字段与 `reports/<sha>/` 目录名决定。
> `RAGFLOW_TEST_PROJECT_ID` 决定作用域，上游数据集因此命名为 `aip-<scope>-<16 位十六进制>`；
> 用一个可识别的 scope（例如 `aip-zach19`）能让本轮留下的数据集一眼认出来。

## 上游已知行为

v0.20.5 的「按名称列数据集」在零命中时返回 `code=108`（PERMISSION_ERROR）而不是空数组，
消息形如 `User '<tenant>' lacks permission for dataset '<name>'`。
aip 适配器只在**这个端点**上把 108 当成「未命中」，其余端点的 108 仍是业务失败。
详见 `docs/ragflow-lock.md` 第 1.1 节第 9 条。
