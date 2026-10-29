# 本体概念查询契约（冻结）· `onto-concept-query/v1`

> 本文件是 **aip（智能研发平台）** 与 **onto（本体平台）** 之间唯一的概念查询契约。
>
> - 权威副本：<https://github.com/zzy1661/onto/blob/main/docs/ontology-concept-query-contract.md>
> - aip 仓副本：`docs/ontology-concept-query-contract.md`（**必须与本副本逐字一致**）
> - 共享夹具：`server/contracts/onto-concept-query.v1.json`（onto 仓）／
>   `tests/fixtures/onto-concept-query.v1.json`（aip 仓），**两份逐字一致**，
>   `sha256 = e0fc5a6caec5e36b8f506e7b4c0160d7394f0d47b27e9d0e89d9db431b0772d0`
> - 契约版本标识：`onto-concept-query/v1`
>
> 本文件在两仓各存一份且逐字一致，**不是各写一份**：任何一侧修改本文件，
> 必须在同一个变更里同步另一侧的副本，并更新上面记录的夹具 `sha256`。
> 两仓各自的契约测试都会用钉死的 `sha256` 复核自己的副本，所以单侧改动会红。

---

## 1. 为什么有这份契约

aip 的注册链路要校验契约字段上的 `concept_ref`（本体概念引用），
这件事只有在两端**对同一个概念、同一个错误、同一个版本**有共同定义时才成立。

在写这份契约之前：aip 假定存在 `GET /api/ontology/concepts/{concept_ref}`，
onto 并没有这个路由。结果是**恒假阴性**——本体服务一旦真的部署，所有带
`concept_ref` 的注册都会被按「概念不存在」拒绝，数值型/概念型契约一条都注册不进来；
同时「概念存在且已发布 → 校验通过」这一侧**永远拿不到证据**。

本契约冻结接口语义，两端各自按它实现，并用同一份夹具做双向契约测试。

## 2. 角色与边界

| 侧 | 职责 | 不做什么 |
| --- | --- | --- |
| onto | 提供只读的概念查询路由；**按已发布快照**解析概念 | 不写 aip 的库；不判断「这次注册该不该通过」 |
| aip | 调用 onto 校验 `concept_ref`；把 onto 的结论映射成注册结果 | 不解析本体模型；不在 onto 不可用时降级为通过 |

onto 的这条路由属于**运行态**（`/api/ontology/**`）：只读，永远按**已发布快照**解析，
调用它不会改动模型。

## 3. 端点

```
GET {ONTO_BASE_URL}/api/ontology/concepts/{concept_ref}
```

`{concept_ref}` 必须做 URL 编码（`:` 编码为 `%3A` 亦可，服务端解码后按同一形态解析）。

查询参数（全部可选）：

| 参数 | 形态 | 缺省时的行为 |
| --- | --- | --- |
| `ontology_version` | 十进制正整数字符串（`^[1-9][0-9]*$`），即 onto 已发布快照的版本号 | 用本体**当前发布**的版本 |
| `vocabulary_version` | onto 当前的单位词表版本，当前为 `onto-units-v1` | 不校验 |
| `unit_ref` | `<symbol>` 或 `<namespace>:unit:<symbol>`（见 §7） | 不校验单位 |

不接受的查询参数一律**忽略**（不报错），以便将来扩展。

## 4. `concept_ref` 形态（冻结）

```
concept_ref := <ontology_code> ":" <property_code>
```

- 两段都必须是 onto 的 code 形态：`^[A-Za-z][A-Za-z0-9_]*$`（字母开头，可含字母、数字、下划线）。
- **恰好一个 `:`**：`ontology_code` 是本体码，`property_code` 是该本体下的属性码。
- 本体码与属性码都不是内部 ID：`concept_ref` 里不出现 UUID，也不带 `@版本`。
  版本由 `ontology_version` 参数单独表达，所以同一个 `concept_ref` 在不同版本下可以被分别校验。

**为什么是这个形态**：onto 的模型里「概念」就是**某个本体的一个属性**
（`OntologySnapshot.properties`）。`本体码:属性码` 直接落在 onto 已有的一等公民上，
不需要为契约另造一套标识空间；而「概念 ID@版本」会把 onto 的内部 ID 暴露成对外契约，
且与 `ontology_version` 重复表达版本。

## 5. 成功响应

onto 的统一响应信封保持不变（`code`/`message`/`result`），概念查询的结果在 `result` 里：

```json
{
  "code": 0,
  "message": "执行成功",
  "result": {
    "contract_version": "onto-concept-query/v1",
    "concept_ref": "demo:amount",
    "ontology": {
      "code": "demo",
      "name": "演示本体",
      "version": 1,
      "published_at": "2026-01-01T00:00:00.000Z",
      "published": true,
      "is_current": true
    },
    "concept": {
      "code": "amount",
      "name": "金额",
      "data_type": "DECIMAL",
      "required": false,
      "unique": false,
      "description": null
    },
    "unit": { "unit_ref": "mm", "unit": "mm", "dimension": "length", "canonical": "m" },
    "vocabulary_version": "onto-units-v1"
  }
}
```

| 字段 | 含义 |
| --- | --- |
| `result.contract_version` | 契约版本标识。客户端**必须**校验它等于自己实现的版本 |
| `result.concept_ref` | 回显本次解析的概念引用 |
| `result.ontology.code` / `.name` | 概念所属本体 |
| `result.ontology.version` | 本次解析所用的**已发布快照**版本号 |
| `result.ontology.published` | 该本体**当前**是否处于已发布状态 |
| `result.ontology.is_current` | 本次解析的版本是否就是该本体当前发布的版本 |
| `result.ontology.published_at` | 该快照的发布时间（**易变字段**，逐字节比较时排除） |
| `result.concept.code` / `.name` | 命中概念 |
| `result.concept.data_type` | 概念的取值域（onto 的 `DataType`） |
| `result.concept.required` / `.unique` / `.description` | 概念的属性特征 |
| `result.unit` | 命中的单位；请求未带 `unit_ref` 时为 `null` |
| `result.vocabulary_version` | 服务端当前使用的单位词表版本 |

**「是否已发布」的口径**：`published` 说的是**本体当前**的状态，
`is_current` 说的是**本次解析的版本**是不是当前版本。两者分开，
是因为「本体已发布但你绑的是旧版本」与「本体根本没发布」是两件事，混成一个字段就分不开了。

## 6. 错误

失败响应沿用 onto 的信封，并**增加一个**字段 `error_code`（成功响应不带该字段）：

```json
{ "code": 404, "message": "概念不存在: demo:missing", "result": null, "error_code": "CONCEPT_NOT_FOUND" }
```

`error_code` 是**机器可读**的判据，`message` 是给人看的，两者都必须稳定。

| `error_code` | HTTP | 含义 |
| --- | --- | --- |
| `CONCEPT_REF_INVALID` | 400 | `concept_ref` 不符合 `{ontology_code}:{property_code}` |
| `ONTOLOGY_VERSION_INVALID` | 400 | `ontology_version` 不是十进制正整数 |
| `UNIT_REF_INVALID` | 400 | `unit_ref` 不符合 §7 的两种形态之一 |
| `UNIT_UNKNOWN` | 422 | 单位不在词表内 |
| `VOCABULARY_VERSION_MISMATCH` | 409 | `vocabulary_version` 与服务端当前词表版本不一致 |
| `ONTOLOGY_NOT_FOUND` | 404 | 本体不存在 |
| `ONTOLOGY_VERSION_NOT_FOUND` | 404 | 指定版本没有对应的已发布快照 |
| `CONCEPT_NOT_FOUND` | 404 | 概念不在该快照里 |
| `ONTOLOGY_NOT_PUBLISHED` | 409 | 本体当前未发布（尚未发布或已撤回发布） |
| `UNIT_NOT_APPLICABLE` | 422 | 概念不是数值类型，单位对它不适用 |

**「概念不存在」与「本体未发布」必须可区分**：前者 `404 / CONCEPT_NOT_FOUND`，
后者 `409 / ONTOLOGY_NOT_PUBLISHED`。这两条是本契约存在的核心原因，不允许合并成一个 404。

### 6.1 判定顺序（确定性）

同一个请求可能同时踩中多条规则，**按下面顺序**判定，先命中者生效：

1. `concept_ref` 形态 → `CONCEPT_REF_INVALID`
2. `ontology_version` 形态 → `ONTOLOGY_VERSION_INVALID`
3. `unit_ref` 形态 → `UNIT_REF_INVALID`
4. 单位符号是否在词表内 → `UNIT_UNKNOWN`
5. `vocabulary_version` 是否与服务端一致 → `VOCABULARY_VERSION_MISMATCH`
6. 本体是否存在 → `ONTOLOGY_NOT_FOUND`
7. 本体当前是否已发布 → `ONTOLOGY_NOT_PUBLISHED`
8. 指定版本的快照是否存在 → `ONTOLOGY_VERSION_NOT_FOUND`
9. 概念是否在该快照里 → `CONCEPT_NOT_FOUND`
10. 单位是否适用于该概念（非数值类型） → `UNIT_NOT_APPLICABLE`

顺序冻结的理由：客户端要能把同一个失败**稳定地**归因到同一件事上，
否则「今天报 A、明天报 B」的错误会让上游的重试与告警失去意义。

## 7. 单位与词表版本

onto 的单位是一个**封闭词表**（`length`/`mass`/`time`/`volume` 四个量纲，符号见
`server/src/domain/canonical.ts`）。词表版本标识为 `onto-units-v1`：

- 词表内容变化（增删单位、改换算因子）**必须**提升版本号。
- `vocabulary_version` 不匹配时服务端回答 `409 / VOCABULARY_VERSION_MISMATCH`，
  而不是「忽略它继续查」：调用方声明了它绑定的是哪个词表，词表变了就意味着
  同一个单位符号的含义可能变了，静默忽略等于让调用方拿着过期的事实注册契约。

`unit_ref` 的两种形态：

| 形态 | 例子 | 说明 |
| --- | --- | --- |
| `<symbol>` | `mm` | 直接是词表里的单位符号 |
| `<namespace>:unit:<symbol>` | `demo:unit:mm` | 命名空间是**调用方自己的标签**，服务端只取最后一段作为符号 |

命名空间被服务端的**单位词表**忽略，只在响应里原样回显（`result.unit.unit_ref`）。
服务端的判据只有一条：符号在词表内、且该概念是数值类型。

## 8. 类型兼容表（aip ↔ onto）

aip 的契约类型与 onto 的取值域不是同一套词汇，映射关系冻结如下：

| aip `data_type` | onto `data_type` |
| --- | --- |
| `NUMBER` | `INTEGER`、`DECIMAL` |
| `STRING` | `STRING`、`TEXT`、`ENUM`、`DATE`、`DATETIME` |
| `BOOLEAN` | `BOOLEAN` |
| `JSON` | （无对应；带 `concept_ref` 的 JSON 字段一律判为不兼容） |

**aip 必须校验类型兼容**：声明 `NUMBER` 的契约字段指向一个 `STRING` 概念，
是注册方写错了，不是本体的错——放过去就是把语义错误记进注册库。

## 9. aip 侧如何解释 onto 的回答

| onto 的回答 | aip 的结论 | aip 对调用方的响应 |
| --- | --- | --- |
| `200` 且与本契约一致 | 通过 | 注册继续 |
| `200` 但字段缺失/改名/取值不符 | 契约不符 | `503 ONTO_UNAVAILABLE`（**不降级为通过**） |
| `400` / `404` / `409` / `422` | 引用不成立 | `422 CONTRACT_INVALID`，`details[].reason` **精确指出该 `concept_ref`** |
| `401` / `403` | 凭据被拒 | `503 ONTO_UNAVAILABLE` |
| `5xx` / 网络不可达 / 超时 | 本体服务不可用 | `503 ONTO_UNAVAILABLE` |
| 本体服务未配置（`ONTO_BASE_URL` 为空） | 无法校验 | `422 CONTRACT_INVALID`（沿用 M23 既有语义） |

aip 侧在 `200` 之后还要逐条核对，**任何一条不成立都是 `422 CONTRACT_INVALID`**：

1. `result.contract_version` 等于 `onto-concept-query/v1`；
2. `result.concept_ref` 等于本次请求的引用；
3. `result.ontology.code` / `result.concept.code` 与引用里的两段一致；
4. `result.ontology.published` 为 `true`；
5. 声明了 `ontology_version` 时，`result.ontology.version` 与之相等（否则说明绑定的版本已被取代）；
6. 声明了 `vocabulary_version` 时，`result.vocabulary_version` 与之相等；
7. 声明了 `unit_ref` 时，`result.unit` 存在且其符号与声明一致；
8. `result.concept.data_type` 与声明的 `data_type` 按 §8 兼容。

## 10. 版本化与兼容策略

- 契约版本标识 `onto-concept-query/v1` 出现在**每一个成功响应**的 `result.contract_version` 里，
  客户端必须校验。不匹配即视为契约不符（`503`），不做「尽力而为」的兼容解析。
- **只增不删**：v1 内可以新增可选响应字段、新增错误码；客户端必须**忽略**不认识的响应字段，
  但不得忽略不认识就判定通过。
- **破坏性变更**（删除/改名字段、改变 `concept_ref` 形态、改变某个 `error_code` 的含义、
  改变类型兼容表）必须提升契约版本（`onto-concept-query/v2`），
  路径不变、版本标记变；两端必须同时升级。
- onto 的**本体快照版本**（`ontology_version`）是运行时事实，不是契约版本：
  快照版本变化不需要提升契约版本，但会让绑定旧版本的 aip 契约按 §9 第 5 条被拒。

## 11. 共享夹具与双向契约测试

夹具 `onto-concept-query.v1.json` 是**两端唯一的期望值来源**：

- onto 侧：按夹具里的 `seed` 建夹具数据，逐条请求真实路由，
  断言响应体与夹具逐字段相等（`volatile_paths` 列出的字段除外）。
- aip 侧：把夹具里的响应体喂给客户端，断言客户端按 §9 解释；
  再把夹具里的错误体喂给客户端，断言映射到 §9 规定的结论。

### 11.1 能证伪：谁改了，红灯落在哪里

漂移分三种，每一种都有确定的红灯：

| 改了什么 | 谁先红 | 为什么 |
| --- | --- | --- |
| **onto 的实现**（改了字段名/取值，没改夹具） | onto 侧 | onto 的验收跑拿真响应当场跟夹具逐字段比，不一致即红 |
| **aip 的实现**（改了期望，没改夹具） | aip 侧 | aip 的契约测试拿夹具喂客户端，客户端的解释与夹具不符即红 |
| **契约本身**（改了夹具或本文档） | **两侧都红** | 两仓各存一份并用 `sha256` 钉死：改的一侧要先更新自己仓里的钉死值才转绿，另一侧的副本随即过期，它自己的 `sha256` 断言变红 |

第三行是「任一侧改契约，另一侧变红」的落点：**红灯不在改的人身上，在没跟着改的人身上**。
所以改契约必须两仓同一个变更里一起改，否则另一仓的测试会拦住这次发布。

复核者可以直接执行（每一行都应当看到红灯）：

```bash
# onto 侧：改一个字段名，看 onto 侧变红
cd onto && pnpm --filter @onto/server test          # 契约静态门
cd onto && ONTO_GRAPH=pg pnpm verify                # 真库真路由，第 35 节

# aip 侧：改一个字段名，看 aip 侧变红
cd aip && pnpm test:contract

# 契约漂移：把 onto 的夹具改动同步到 aip，两侧同时变红
cp onto/server/contracts/onto-concept-query.v1.json aip/tests/fixtures/
cd aip && pnpm test:contract                          # sha256 断言失败
```

- 夹具与本文档的 `sha256` 被两仓的测试**钉死**（见文首），单侧改动而不同步另一侧，
  改的那一侧先红，没改的那一侧在拿到改动之后也红。

## 12. 认证现状（已知限制）

onto 的认证是**部署级**规则：带 `Authorization: Bearer <凭据>`，
`ONTO_REQUIRE_AUTH=1` 时必须带。当前 aip 的客户端只发 `x-audience`，不带凭据，
因此**只适用于 `ONTO_REQUIRE_AUTH` 未开启的部署**；在要求认证的部署里，
onto 会回答 401，aip 按 §9 映射成 `503 ONTO_UNAVAILABLE`（**失败关闭**，不会放行）。

补齐凭据传递是后续批次的事，本契约不覆盖。

## 13. 非目标

- 本契约**不**覆盖本体概念的任何写操作（onto 的概念只读）。
- 本契约**不**覆盖词表本身的管理（词表是 onto 的代码常量）。
- 本契约**不**让 aip 获得 onto 的任何写能力。
- 本契约**不**改变 aip 注册链路的其它行为（知识库、绑定、状态机一概不动）。
