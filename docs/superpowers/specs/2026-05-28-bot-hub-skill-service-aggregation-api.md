# Bot Hub Skill Service Aggregation API Requirements

## 背景

IDBots 的 Bot Hub 技能服务列表当前依赖客户端从链上索引接口拉取 `/protocols/skill-service` 扁平 PIN 数据，写入本地 SQLite，再在本地完成 create/modify/revoke 折叠、评分聚合、provider 信息补全、图标解析和排序。

新的目标是由后端聚合系统直接提供面向前端渲染的 HTTP JSON API。前端拿到接口返回后，应尽量可以直接渲染列表卡片和服务详情页；脏活累活，包括链上协议折叠、版本解析、评分聚合、provider profile 补全、资产 URL 解析、可订购状态判断，都放到聚合接口完成。

接口风格应尽量贴近现有 manapi 风格：`code/message/data` 外层包裹，列表使用 `data.list`，分页使用 opaque `nextCursor`。

## 总体原则

- 返回前端渲染模型，不返回需要前端二次聚合的原始 PIN 列表。
- 默认只返回当前可见、可展示服务：latest revoke 隐藏，`available=0` 隐藏，负状态隐藏。
- 服务端保留链上证明字段：`currentPinId`、`sourceServicePinId`、`chainPinIds`、`chainName`、`operation`、`status`、`updatedAt`。
- 所有时间字段统一返回毫秒时间戳，字段名使用 `createdAt`、`updatedAt`、`aggregatedAt`。
- 金额字段保持字符串，避免浮点精度问题。
- `id` 在列表和详情里统一使用 `currentPinId`，`sourceServicePinId` 作为稳定服务根 ID。
- `service` 对象在列表项和详情页保持兼容，方便前端从列表乐观渲染详情，再用详情接口补齐。
- API schema 必须版本化，例如 `schemaVersion: "botHubSkillService.v1"`。

## API 1: Bot Hub 技能服务列表

### Endpoint

`GET /api/bot-hub/skill-service/list`

### 用途

提供 Bot Hub 首屏和搜索/筛选列表所需数据。每个 `data.list` item 都应能直接渲染服务卡片，包括服务名称、描述、图标、provider 信息、价格、评分、在线状态和基础链上标识。

### Query Parameters

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `size` | number | 否 | `20` | 每页数量，建议上限 100 |
| `cursor` | string | 否 | - | opaque 游标 |
| `keyword` | string | 否 | - | 搜索 `displayName/serviceName/description/providerSkill/providerName` |
| `currency` | string | 否 | - | `BTC`、`SPACE`、`DOGE`、`MRC20` |
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
        "providerOnline": true,
        "providerLastSeenAt": 1774531000000,

        "ratingAvg": 4.8,
        "ratingCount": 12,
        "ratingScore": 4.55,

        "status": 0,
        "operation": "modify",
        "available": 1,
        "chainName": "mvc",
        "createdAt": 1774530000000,
        "updatedAt": 1774530374000
      }
    ],
    "nextCursor": "opaque-cursor",
    "total": 70,
    "aggregatedAt": 1774531000000,
    "schemaVersion": "botHubSkillService.v1"
  }
}
```

### 列表聚合规则

- 从 `/protocols/skill-service` 读取 create/modify/revoke 服务 PIN。
- 按 `sourceServicePinId` 折叠版本链：
  - create 的 `sourceServicePinId` 是自身 pin id。
  - modify/revoke 应指向原始服务或上一版本，聚合端需要解析为稳定根服务 ID。
  - 同一服务只返回当前有效版本。
- 默认可见规则：
  - latest operation 为 `revoke` 时隐藏。
  - `available=0` 时隐藏。
  - `status` 非 `0` 或 `1` 时隐藏。
  - contentSummary 缺失或必填字段缺失时隐藏，除非 `includeUnavailable=1`。
- 服务字段从 `contentSummary` 解析，链上字段从 PIN 元数据补充。
- `currency/paymentChain/settlementKind/mrc20Ticker/mrc20Id` 需要归一化：
  - `MVC` 和旧 `SPACE` 兼容为前端展示的 `SPACE`。
  - MRC20 必须带 `mrc20Ticker` 和 `mrc20Id`。
- `serviceIcon/providerAvatar` 必须返回前端可直接加载的 URL，不返回需要前端再拼的 PIN asset 标识。
- `providerName/providerAvatar/providerChatPubkey` 由 provider profile 与 `/info/chatpubkey` 等信息补齐。
- `providerOnline/providerLastSeenAt` 如聚合系统有在线状态源则返回；没有时返回 `false/null`，但字段保留。
- `ratingAvg/ratingCount/ratingScore` 由 `/protocols/skill-service-rate` 聚合。
- 默认排序推荐：
  - provider 在线服务优先。
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
      "verified": false,
      "online": true,
      "lastSeenAt": 1774531000000
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
      "sourceServicePinId": "first-create-pin-id",
      "currentPinId": "current-pin-id",
      "sourceTxid": "source-txid",
      "currentTxid": "current-txid",
      "revisions": [
        {
          "pinId": "first-create-pin-id",
          "operation": "create",
          "status": 0,
          "timestamp": 1774530000000
        },
        {
          "pinId": "modify-pin-id",
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
  - `provider_offline`，如果产品决定必须在线才能下单
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
    "total": 12,
    "aggregatedAt": 1774531000000,
    "schemaVersion": "botHubSkillServiceRating.v1"
  }
}
```

### 版本链分页

`GET /api/bot-hub/skill-service/{sourceServicePinId}/revisions?size=20&cursor=...`

返回 create/modify/revoke 历史，用于详情页“链上版本记录”展开。

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

### `/protocols/skill-service-rate`

服务评价协议。用于聚合 `ratingAvg/ratingCount/distribution/latest`。

`contentSummary` 预期 JSON 字段：

- `serviceID`，对应服务 pin id 或 source service pin id
- `servicePaidTx`，服务支付交易
- `rate`，1 到 5
- `comment`

聚合要求：

- 无效 rate 丢弃。
- 同一 rating pin 去重。
- 如可验证 `servicePaidTx` 对应订单，则 `verifiedOrder=true`。
- 评分聚合应支持服务版本链，即评价打到旧版本 pin 时也能归到 `sourceServicePinId`。

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

可用数据源包括 manapi 用户信息接口、metafile-indexer 用户信息接口、本地或远端 MetaID profile 索引。

### 资产解析

`serviceIcon`、`providerAvatar`、`raterAvatar` 需要返回可直接加载的 URL。

如果链上内容是 metafile、pin asset 或相对标识，聚合系统负责解析为 HTTP URL。

### MRC20 / token 结算信息

当 `settlementKind="mrc20"` 或 `currency="MRC20"` 时：

- 必须返回 `mrc20Ticker`
- 必须返回 `mrc20Id`
- `paymentChain` 通常为 `btc`
- `paymentAddress` 必须是接收该资产的地址

## 错误格式

建议保持统一 envelope：

```json
{
  "code": 0,
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

HTTP 状态码建议：

- 参数错误：`400`
- 服务不存在：`404`
- 聚合系统异常：`500`
- 上游超时或不可用：`502` 或 `504`

如果为了兼容 manapi 风格必须始终返回 HTTP 200，也应至少在 `code/message` 中明确失败原因。

## 验收标准

- 列表接口返回的每个 item 可以直接渲染 Bot Hub 卡片，无需前端再请求 provider profile、chat pubkey、评分或图标。
- 详情接口返回后可以直接渲染详情首屏和下单弹窗。
- 同一服务多次 modify 后，列表只出现当前有效版本。
- 服务被 revoke 后，默认不在列表出现，详情接口返回 `canOrder=false` 或 404，由产品决定。
- 评分能跨服务版本链聚合到同一个 `sourceServicePinId`。
- MRC20 服务详情返回足够的支付信息，前端无需自行推断 token id 或 payment chain。
- 所有图片 URL 可被前端直接加载。
- 所有时间均为毫秒时间戳。
- 分页 cursor 为 opaque 字符串，前端不解析其内部结构。
- 接口包含 `schemaVersion`，便于后续兼容升级。

## 后端开发建议

第一阶段优先实现：

- `/api/bot-hub/skill-service/list`
- `/api/bot-hub/skill-service/detail/{serviceId}`
- `/protocols/skill-service` 版本链折叠
- provider profile/chat pubkey 补全
- 评分均值和数量聚合
- asset URL 解析

第二阶段再补：

- 评价分页
- 版本链分页
- 评分分布
- 订单成功率
- 退款风险
- related services 推荐

这样可以先让 Bot Hub 卡片和详情页从远端聚合接口直接渲染，再逐步增强商业指标和可信度展示。
