# Bot Hub Skill Service Aggregation API Requirements

## 背景

IDBots 的 Bot Hub 技能服务列表当前依赖客户端从链上索引接口拉取 `/protocols/skill-service` 扁平 PIN 数据，写入本地 SQLite，再在本地完成 create/modify/revoke 折叠、评分聚合、provider 信息补全、图标解析和排序。

新的目标是由后端聚合系统直接提供面向前端渲染的 HTTP JSON API。前端拿到接口返回后，应尽量可以直接渲染列表卡片和服务详情页；脏活累活，包括链上协议折叠、版本解析、评分聚合、provider profile 补全、资产 URL 解析、可订购状态判断，都放到聚合接口完成。

接口风格采用 meta-file-system / manapi 兼容约定：`code/message/data` 外层包裹，成功 `code=1`，业务错误使用 `40000/40400/50000/50200/50400` 等非 1 code，HTTP 状态码统一返回 200。列表使用 `data.list`，分页使用 opaque `nextCursor`。

## 部署决策

本需求的第一目标后端是 `meta-socket`，不另起独立 `bot-hub-server`。

选择 `meta-socket` 的原因：

- 可以复用现有索引引擎、PebbleDB、userinfo 聚合、chain RPC 框架和 HTTP 服务。
- 避免在独立进程里重复实现链索引、profile 聚合和持久化。
- Bot Hub 聚合属于 MetaID 数据读模型，适合落在已有聚合服务内。

实现前置要求：

- `meta-socket` 主程序必须 wire MVC indexer；`/protocols/skill-service` 当前主要发布在 MVC 链上。
- BTC/DOGE/OPCAT 如已有 indexer 实现，后续可逐步接入。跨链 modify/revoke 允许折叠到原始服务；`chainName` 以最新版本所在链为准。
- README / CLAUDE.md / GOAL_DRIVEN 等后端项目说明需要补充：`meta-socket` 同时承担 Bot Hub 聚合 API。

## 总体原则

- 返回前端渲染模型，不返回需要前端二次聚合的原始 PIN 列表。
- 默认只返回当前可见、可展示服务：latest revoke 隐藏，`available=0` 隐藏，异常状态隐藏。
- 服务端保留链上证明字段：`currentPinId`、`sourceServicePinId`、`chainPinIds`、`chainName`、`sourceChainName`、`currentChainName`、`operation`、`status`、`updatedAt`。
- 所有时间字段统一返回毫秒时间戳，字段名使用 `createdAt`、`updatedAt`、`aggregatedAt`。
- `aggregatedAt` 表示底层物化聚合视图最后更新时间，不是本次 HTTP 响应生成时间。
- 金额字段保持字符串，避免浮点精度问题。
- `id` 在列表和详情里统一使用 `currentPinId`，`sourceServicePinId` 作为稳定服务根 ID。
- 聚合端内部服务主键建议使用 `${sourceChainName}:${sourceServicePinId}`。`chainName` 表示最新/current 版本所在链，会随跨链 modify/revoke 变化，不应作为稳定根主键。
- `service` 对象在列表项和详情页保持兼容，方便前端从列表乐观渲染详情，再用详情接口补齐。
- API schema 必须版本化，例如 `schemaVersion: "botHubSkillService.v1"`。
- Cursor 是唯一可靠分页依据；`total` 是可选字段，只有当聚合端能低成本提供过滤后的总数时返回，否则返回 `null`。
- v1 不返回 provider 在线状态字段。现有 socket.io 在线状态只能表示“某个用户客户端在线”，不能证明 Bot 服务可接单。等 bot heartbeat 协议落地后再增加带来源的 presence 字段。

## API 1: Bot Hub 技能服务列表

### Endpoint

`GET /api/bot-hub/skill-service/list`

### 用途

提供 Bot Hub 首屏和搜索/筛选列表所需数据。每个 `data.list` item 都应能直接渲染服务卡片，包括服务名称、描述、图标、provider 信息、价格、评分和基础链上标识。

### Query Parameters

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `size` | number | 否 | `20` | 每页数量，建议上限 100 |
| `cursor` | string | 否 | - | opaque 游标 |
| `keyword` | string | 否 | - | 搜索 `displayName/serviceName/description/providerSkill/providerName` |
| `currency` | string | 否 | - | `BTC`、`SPACE`、`DOGE`、`MRC20` |
| `chainName` | string | 否 | - | 按最新/current 版本所在链筛选；取值 `mvc`、`btc`、`doge`、`opcat`；v1 至少支持 `mvc` |
| `outputType` | string | 否 | - | `text`、`image`、`video`、`audio`、`other` |
| `providerGlobalMetaId` | string | 否 | - | 只看某个 provider 的服务 |
| `sortBy` | string | 否 | `rating` | `rating`、`updated`、`price` |
| `order` | string | 否 | `desc` | `desc`、`asc` |
| `includeUnavailable` | number | 否 | `0` | `1` 时返回 revoked/disabled/status 异常服务，用于调试或管理后台 |

### Response

```json
{
  "code": 1,
  "message": "ok",
  "data": {
    "list": [
      {
        "id": "current-pin-id",
        "currentPinId": "current-pin-id",
        "sourceServicePinId": "first-create-pin-id",
        "chainPinIds": ["first-create-pin-id", "modify-pin-id"],

        "serviceName": "zhuwei-fortune-service",
        "displayName": "紫微斗数算命服务",
        "description": "根据出生日期和时间，分析命盘、解读运势",
        "serviceIcon": "https://example.com/icon.png",
        "providerSkill": "zhuwei-fortune",
        "inputType": "text",
        "outputType": "text",
        "endpoint": "simplemsg",

        "price": "1",
        "currency": "SPACE",
        "settlementKind": "native",
        "paymentChain": "mvc",
        "mrc20Ticker": null,
        "mrc20Id": null,
        "paymentAddress": "18GED...",

        "providerMetaId": "3a32...",
        "providerGlobalMetaId": "idq1...",
        "providerAddress": "18GED...",
        "providerName": "Fortune Bot",
        "providerAvatar": "https://example.com/avatar.png",
        "providerChatPubkey": "...",

        "ratingAvg": 4.8,
        "ratingCount": 12,
        "ratingScore": 4.55,

        "status": 0,
        "operation": "modify",
        "available": 1,
        "chainName": "mvc",
        "sourceChainName": "mvc",
        "currentChainName": "mvc",
        "createdAt": 1774530000000,
        "updatedAt": 1774530374000
      }
    ],
    "nextCursor": "opaque-cursor",
    "total": null,
    "aggregatedAt": 1774531000000,
    "schemaVersion": "botHubSkillService.v1"
  }
}
```

### 列表聚合规则

- 从 `/protocols/skill-service` 读取 create/modify/revoke 服务 PIN。
- 按 `sourceServicePinId` 折叠版本链：
  - create 的 `sourceServicePinId` 是自身 pin id。
  - modify/revoke 必须通过 PIN 元数据 `originalId` 一跳指向原始 create pin id；聚合端使用 `originalId` 作为稳定根服务 ID。
  - 过渡兼容：如果历史数据缺失 `originalId`，可回退到 `path` 中的 `@pinId` 目标；回退路径必须带防环和最大深度保护，并在内部日志中标记为 compatibility fallback。
  - 同一服务只返回当前有效版本。
  - 版本链允许跨链折叠；例如 MVC create 后 DOGE modify，仍折叠为同一个 `sourceServicePinId` 服务。
  - API `chainName` 始终取最新/current 有效版本所在链；为避免歧义，同时返回 `sourceChainName` 和 `currentChainName`。
  - `sourceChainName` 是原始 create 所在链，`currentChainName` 是当前有效版本所在链，`chainName` 等同于 `currentChainName`。
  - 跨链 modify/revoke 的 `originalId` 仍必须指向原始 create pin id；如果多个链上存在相同 pin id，聚合端用 `sourceChainName` 或索引解析结果消除歧义。
- 默认可见规则：
  - latest operation 为 `revoke` 时隐藏。
  - `available=0` 时隐藏。
  - `available = disabled ? 0 : 1`，`available` 是 API 派生字段，`contentSummary.disabled` 是链上协议字段；两者不得作为独立事实源。
  - `status=0` 表示 confirmed/published，`status=1` 表示 indexed/pending confirmation；v1 默认二者可见。其它 status 隐藏，除非 `includeUnavailable=1`。
  - contentSummary 缺失或必填字段缺失时隐藏，除非 `includeUnavailable=1`。
- 服务字段从 `contentSummary` 解析，链上字段从 PIN 元数据补充。
- `currency/paymentChain/settlementKind/mrc20Ticker/mrc20Id` 需要归一化：
  - `MVC` 和旧 `SPACE` 兼容为前端展示的 `SPACE`。
  - MRC20 必须带 `mrc20Ticker` 和 `mrc20Id`。
- `serviceIcon/providerAvatar` 必须返回前端可直接加载的 URL，不返回需要前端再拼的 PIN asset 标识。
- `providerName/providerAvatar/providerChatPubkey` 由 provider profile 与 `/info/chatpubkey` 等信息补齐。
- `ratingAvg/ratingCount/ratingScore` 由 `/protocols/skill-service-rate` 聚合。
- 默认排序推荐：
  - `sortBy=rating` 使用平滑评分，例如 `(avg * count + 4.0 * 5) / (count + 5)`。
  - 同分时按 `ratingCount`、`updatedAt` 降序。

## API 2: Bot Hub 技能服务详情

### Endpoint

`GET /api/bot-hub/skill-service/detail/{serviceId}`

### 用途

提供服务详情页首屏、下单弹窗、provider 信息、评分摘要、最近评价、链上版本证明和相关服务推荐。详情页不应再额外请求 provider profile、chat pubkey、rating aggregate 或版本链。

### Path Parameter

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `serviceId` | string | 支持 `currentPinId` 或 `sourceServicePinId` |

### Query Parameters

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `idType` | string | 否 | `auto` | `auto`、`currentPinId`、`sourceServicePinId` |
| `chainName` | string | 否 | - | 可选 latest/current 链名，用于跨链部署后消除歧义 |
| `includeRatings` | number | 否 | `1` | 是否包含最近评价 |
| `ratingSize` | number | 否 | `5` | 最近评价数量，建议上限 20 |
| `includeRevisions` | number | 否 | `1` | 是否包含最近版本链 |
| `revisionSize` | number | 否 | `10` | 最近版本数量，建议上限 50 |
| `includeRelated` | number | 否 | `1` | 是否包含相关服务 |

### Response

```json
{
  "code": 1,
  "message": "ok",
  "data": {
    "service": {
      "id": "current-pin-id",
      "currentPinId": "current-pin-id",
      "sourceServicePinId": "first-create-pin-id",
      "chainPinIds": ["first-create-pin-id", "modify-pin-id"],

      "serviceName": "zhuwei-fortune-service",
      "displayName": "紫微斗数算命服务",
      "description": "完整服务描述...",
      "serviceIcon": "https://example.com/icon.png",
      "providerSkill": "zhuwei-fortune",
      "skillDocument": "",
      "inputType": "text",
      "outputType": "text",
      "endpoint": "simplemsg",

      "price": "1",
      "currency": "SPACE",
      "settlementKind": "native",
      "paymentChain": "mvc",
      "mrc20Ticker": null,
      "mrc20Id": null,
      "paymentAddress": "18GED...",

      "status": 0,
      "operation": "modify",
      "available": 1,
      "chainName": "mvc",
      "sourceChainName": "mvc",
      "currentChainName": "mvc",
      "createdAt": 1774530000000,
      "updatedAt": 1774530374000
    },

    "provider": {
      "metaid": "3a32...",
      "globalMetaId": "idq1...",
      "address": "18GED...",
      "name": "Fortune Bot",
      "avatar": "https://example.com/avatar.png",
      "chatPubkey": "...",
      "bio": "",
      "verified": false
    },

    "ordering": {
      "canOrder": true,
      "disabledReason": null,
      "transport": "simplemsg",
      "requestInput": {
        "type": "text",
        "required": true,
        "maxLength": 4000,
        "placeholder": "请输入你的需求..."
      },
      "payment": {
        "price": "1",
        "currency": "SPACE",
        "paymentChain": "mvc",
        "settlementKind": "native",
        "paymentAddress": "18GED...",
        "mrc20Ticker": null,
        "mrc20Id": null
      }
    },

    "rating": {
      "avg": 4.8,
      "count": 12,
      "score": 4.55,
      "distribution": {
        "5": 9,
        "4": 2,
        "3": 1,
        "2": 0,
        "1": 0
      },
      "latest": [
        {
          "pinId": "rating-pin-id",
          "rate": 5,
          "comment": "响应很快，结果可用",
          "servicePaidTx": "payment-txid",
          "raterGlobalMetaId": "idq1...",
          "raterName": "Alice",
          "raterAvatar": "https://example.com/rater.png",
          "createdAt": 1774530800000,
          "verifiedOrder": true
        }
      ]
    },

    "stats": {
      "orderCount": 24,
      "successCount": 22,
      "refundCount": 1,
      "successRate": 0.9167
    },

    "chain": {
      "chainName": "mvc",
      "sourceChainName": "mvc",
      "currentChainName": "mvc",
      "sourceServicePinId": "first-create-pin-id",
      "currentPinId": "current-pin-id",
      "sourceTxid": "source-txid",
      "currentTxid": "current-txid",
      "revisions": [
        {
          "pinId": "first-create-pin-id",
          "chainName": "mvc",
          "operation": "create",
          "status": 0,
          "timestamp": 1774530000000
        },
        {
          "pinId": "modify-pin-id",
          "chainName": "mvc",
          "operation": "modify",
          "status": 0,
          "timestamp": 1774530374000
        }
      ]
    },

    "relatedServices": [
      {
        "id": "another-current-pin-id",
        "currentPinId": "another-current-pin-id",
        "sourceServicePinId": "another-source-pin-id",
        "serviceName": "bazi-service",
        "displayName": "八字分析",
        "description": "根据出生时间分析八字",
        "serviceIcon": "https://example.com/related.png",
        "providerSkill": "bazi",
        "price": "1",
        "currency": "SPACE",
        "providerGlobalMetaId": "idq1...",
        "providerName": "Fortune Bot",
        "providerAvatar": "https://example.com/avatar.png",
        "ratingAvg": 4.6,
        "ratingCount": 8,
        "updatedAt": 1774530300000
      }
    ],

    "aggregatedAt": 1774531000000,
    "schemaVersion": "botHubSkillServiceDetail.v1"
  }
}
```

### 详情聚合规则

- `service` 字段必须与列表 item 的核心字段兼容。
- `provider.chatPubkey` 是下单必须字段；如果缺失，`ordering.canOrder=false`，`disabledReason="missing_provider_chat_pubkey"`。
- `ordering.canOrder=false` 的常见原因：
  - `service_unavailable`
  - `service_revoked`
  - `missing_payment_address`
  - `missing_provider_chat_pubkey`
  - `unsupported_settlement`
- `rating.latest` 只返回最近少量评价；完整评价走分页扩展接口。
- `rating.distribution` 按 1-5 星聚合，缺失时返回 0。
- `stats` 如果暂时无法从订单协议可靠聚合，可以返回 0 值，但字段保留。
- `chain.revisions` 默认返回最近版本，完整版本链走分页扩展接口。
- `relatedServices` 推荐同 provider 或同 `providerSkill/outputType` 的其他当前可用服务。

## 可选扩展接口

### 评价分页

`GET /api/bot-hub/skill-service/{sourceServicePinId}/ratings?size=20&cursor=...`

返回：

```json
{
  "code": 1,
  "message": "ok",
  "data": {
    "list": [
      {
        "pinId": "rating-pin-id",
        "rate": 5,
        "comment": "很好用",
        "servicePaidTx": "payment-txid",
        "raterGlobalMetaId": "idq1...",
        "raterName": "Alice",
        "raterAvatar": "https://example.com/avatar.png",
        "createdAt": 1774530800000,
        "verifiedOrder": true
      }
    ],
    "nextCursor": "opaque-cursor",
    "total": null,
    "aggregatedAt": 1774531000000,
    "schemaVersion": "botHubSkillServiceRating.v1"
  }
}
```

### 版本链分页

`GET /api/bot-hub/skill-service/{sourceServicePinId}/revisions?size=20&cursor=...`

返回 create/modify/revoke 历史，用于详情页“链上版本记录”展开。

`total` 仍为可选字段；cursor 分页接口不得要求调用方依赖总数。

## 涉及协议和数据源

### `/protocols/skill-service`

核心服务发布协议。聚合系统必须读取并折叠此协议下的 PIN。

常见 PIN 元数据字段：

- `id`
- `metaid` / `createMetaId`
- `globalMetaId`
- `address` / `createAddress`
- `operation`
- `path`
- `originalId`
- `status`
- `timestamp`
- `chainName`
- `sourceChainName`，API 派生字段，原始 create 所在链
- `currentChainName`，API 派生字段，当前有效版本所在链
- `contentSummary`

`contentSummary` 预期 JSON 字段：

- `serviceName`
- `displayName`
- `description`
- `serviceIcon`
- `providerMetaBot`
- `providerSkill`
- `price`
- `currency`
- `paymentChain`
- `settlementKind`
- `mrc20Ticker`
- `mrc20Id`
- `skillDocument`
- `inputType`
- `outputType`
- `endpoint`
- `paymentAddress`
- `disabled`

协议约束：

- create PIN 的稳定服务根 ID 是自身 `id`。
- modify/revoke PIN 的 `originalId` 必须是一跳原始 create pin id；v1 聚合端不把“上一版本 pin id”作为规范写法。
- `originalId` 缺失的历史数据可兼容回退，但新数据必须写 `originalId`。
- `disabled=true` 映射为 API `available=0`；`disabled=false` 或缺失映射为 `available=1`，除非其它可见性规则判定不可用。
- `status=0` 为 confirmed/published，`status=1` 为 indexed/pending confirmation；其它值为异常或不可展示。
- modify/revoke 允许跨链引用 create；如果 `originalId` 指向另一条链上的 pin，聚合端仍折叠到同一服务。
- `chainName` 取当前最新有效版本的链名，也就是 modify/revoke 后的 latest chain。`sourceChainName` 保留原始 create 链，`currentChainName` 与 `chainName` 相同。

### `/protocols/skill-service-rate`

服务评价协议。用于聚合 `ratingAvg/ratingCount/distribution/latest`。

`contentSummary` 预期 JSON 字段：

- `serviceID`，规范写法必须是 `sourceServicePinId`
- `servicePaidTx`，服务支付交易
- `rate`，1 到 5
- `comment`

聚合要求：

- 无效 rate 丢弃。
- 同一 rating pin 去重。
- 如可验证 `servicePaidTx` 对应订单，则 `verifiedOrder=true`。
- 评分聚合应支持服务版本链。
- 过渡期兼容：如果历史 rating 的 `serviceID` 是 `currentPinId` 或旧版本 pin id，聚合端应通过服务版本映射反查到 `sourceServicePinId`。
- 新 rating 必须写 `sourceServicePinId`，否则可被标记为 compatibility fallback。

### `/protocols/service-request`

服务请求/下单协议。详情页 `stats.orderCount/successCount/successRate` 和评价 `verifiedOrder` 可参考此协议与支付交易、订单消息之间的关系。

聚合系统如果暂时无法完整确认订单状态，可以先不把 stats 作为强依赖，但应保留字段。

### `/protocols/service-refund-request`

退款请求协议。用于统计 provider 或服务的退款风险、`refundCount`、未处理退款等信息。

### `/protocols/service-refund-finalize`

退款完成协议。用于判断退款是否已处理，避免把已完成退款长期算作风险。

### `/info/chatpubkey`

provider 接单必须字段来源之一。详情接口必须尽力解析 provider 的 chat pubkey，并放入 `provider.chatPubkey`。

### Provider profile 相关信息

聚合系统需要通过 MetaID/globalMetaId/address 解析 provider：

- 名称
- 头像
- bio，可选
- 地址
- chat pubkey

部署在 `meta-socket` 时，provider profile 解析必须走 in-process `userinfo` 聚合/PebbleDB 查询；HTTP 请求链路中不允许再通过 HTTP 调用自身或远端 manapi 来补 profile。

远端 manapi / metafile-indexer 只能作为 `userinfo` 聚合模块的离线同步或补数来源，不应出现在 Bot Hub API 的 request path 中。

### 资产解析

`serviceIcon`、`providerAvatar`、`raterAvatar` 需要返回可直接加载的 URL。

如果链上内容是 metafile、pin asset 或相对标识，聚合系统负责解析为 HTTP URL。

资产 URL base 必须来自配置项：

- 环境变量：`META_SOCKET_ASSET_BASE_URL`
- 推荐默认值：`https://manapi.metaid.io/content`
- 拼接规则：当资产字段是 pin id 或 content id 时，返回 `${META_SOCKET_ASSET_BASE_URL}/{id}`。
- 如果资产字段本身已经是 `http://` 或 `https://` URL，聚合端可校验后原样返回。

### MRC20 / token 结算信息

当 `settlementKind="mrc20"` 或 `currency="MRC20"` 时：

- 必须返回 `mrc20Ticker`
- 必须返回 `mrc20Id`
- `paymentChain` 通常为 `btc`
- `paymentAddress` 必须是接收该资产的地址

Schema 条件约束：

```json
{
  "if": {
    "anyOf": [
      { "properties": { "settlementKind": { "const": "mrc20" } } },
      { "properties": { "currency": { "const": "MRC20" } } }
    ]
  },
  "then": {
    "required": ["mrc20Ticker", "mrc20Id", "paymentChain", "paymentAddress"],
    "properties": {
      "paymentChain": { "const": "btc" }
    }
  }
}
```

## 实时性要求

- v1 不要求实现 ZMQ/mempool 零延迟更新。
- 新服务 publish/modify/revoke 在对应链索引器可见后，应在 30 秒内反映到聚合视图，目标 p95 小于等于 30 秒。
- 如果后端 scan loop 默认 10 秒，集成测试可以按 30 秒上限验收。
- ZMQ 或 mempool 实时订阅属于后续独立 milestone，不阻塞 v1 API 开工。

## 错误格式

采用 meta-file-system / manapi 兼容错误约定：

- HTTP 状态码统一返回 200，除非请求没有进入业务服务，例如网关层断连。
- 成功：`code=1`，`message="ok"`。
- 参数错误：`code=40000`。
- 服务不存在：`code=40400`。
- 聚合服务内部错误：`code=50000`。
- 上游依赖不可用：`code=50200`。
- 上游依赖超时：`code=50400`。
- 前端只应以 `code === 1` 判断成功；任何非 1 code 都是失败。

```json
{
  "code": 40400,
  "message": "service not found",
  "data": null
}
```

常见错误：

- `service not found`
- `invalid cursor`
- `invalid parameter`
- `aggregation unavailable`
- `upstream timeout`

## 验收标准

- 列表接口返回的每个 item 可以直接渲染 Bot Hub 卡片，无需前端再请求 provider profile、chat pubkey、评分或图标。
- 详情接口返回后可以直接渲染详情首屏和下单弹窗。
- 同一服务多次 modify 后，列表只出现当前有效版本。
- 服务被 revoke 后，默认不在列表出现；详情接口返回 `canOrder=false` 或错误 `code=40400`，由产品决定。
- 评分能跨服务版本链聚合到同一个 `sourceServicePinId`。
- MRC20 服务详情返回足够的支付信息，前端无需自行推断 token id 或 payment chain。
- 所有图片 URL 可被前端直接加载。
- 所有时间均为毫秒时间戳。
- 分页 cursor 为 opaque 字符串，前端不解析其内部结构。
- 接口包含 `schemaVersion`，便于后续兼容升级。

## 后端开发建议

建议按可独立验收的 milestone 拆分，便于小步提交和逐步接入：

| Milestone | 内容 | 验收 |
| --- | --- | --- |
| M1 | `meta-socket` wire MVC indexer；索引 `/protocols/skill-service`；按 `originalId` 折叠 create/modify/revoke；PebbleDB 持久化当前服务视图；支持 `chainName` 使用最新版本链 | 构造 create+modify+revoke pin，验证聚合视图只保留当前有效服务，revoke 后默认不可见；构造 MVC create + DOGE modify，验证 `sourceChainName=mvc`、`currentChainName=doge`、`chainName=doge` |
| M2 | provider profile 接入；in-process 读取 `userinfo` 聚合/PebbleDB；补 `providerName/providerAvatar/providerChatPubkey` | 服务 item 含 provider 名称、头像、chat pubkey；request path 不调用远端 manapi |
| M3 | `/protocols/skill-service-rate` 索引与评分聚合；avg/count/distribution；rating 的 `serviceID` 归一到 `sourceServicePinId` | 单元测试覆盖 source id、current id、旧版本 id 三种 rating 输入 |
| M4 | asset URL 解析；支持 `META_SOCKET_ASSET_BASE_URL` 配置 | serviceIcon/providerAvatar/raterAvatar 都返回可加载 URL；配置缺省值可用 |
| M5 | HTTP list endpoint；filter/sort/cursor paginate；错误码 envelope | 集成测试覆盖筛选、排序、分页、错误 code |
| M6 | HTTP detail endpoint；ordering readiness；chain revisions 摘要；latest ratings | 集成测试覆盖 currentPinId/sourceServicePinId 查询、不可订购原因、MRC20 详情 |
| M7 | 第二阶段扩展：ratings 分页、revisions 分页、stats、refund risk、relatedServices | 集成测试覆盖分页与指标 |

第一阶段建议交付到 M6。M7 可在 Bot Hub 首屏和详情页切换到聚合接口后继续增强。
