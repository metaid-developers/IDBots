# Bot Hub Skill Service Aggregation API Requirements

## 背景

IDBots 的 Bot Hub 技能服务列表当前依赖客户端从链上索引接口拉取 `/protocols/skill-service` 扁平 PIN 数据，写入本地 SQLite，再在本地完成 create/modify/revoke 折叠、评分聚合、provider 信息补全、图标解析和排序。

新的目标是由后端聚合系统直接提供面向前端渲染的 HTTP JSON API。前端拿到接口返回后，应尽量可以直接渲染列表卡片和服务详情页；脏活累活，包括链上协议折叠、版本解析、评分聚合、provider profile 补全、资产 URL 解析、支付声明字段归一，都放到聚合接口完成。

接口风格采用 meta-socket 主体接口约定：`code/message/data` 外层包裹，成功 `code=0`，业务错误使用非 0 code。v1 只定义 `40000/40400/50000` 三类错误码。列表使用 `data.list`，分页使用 opaque `nextCursor`。

## 部署决策

本需求的第一目标后端是 `meta-socket`，不另起独立 `bot-hub-server`。

选择 `meta-socket` 的原因：

- 可以复用现有索引引擎、PebbleDB、userinfo 聚合、chain RPC 框架和 HTTP 服务。
- 避免在独立进程里重复实现链索引、profile 聚合和持久化。
- Bot Hub 聚合属于 MetaID 数据读模型，适合落在已有聚合服务内。

实现前置要求：

- `meta-socket` 主程序必须 wire MVC indexer；`/protocols/skill-service` 当前主要发布在 MVC 链上。
- BTC/DOGE/OPCAT 如已有 indexer 实现，后续可逐步接入。v1 强制同一服务的 create/modify/revoke 在同一条链内折叠；跨链 modify/revoke 暂不支持，等协议层补充 `originalChainName` 或等价字段后再设计。
- README / CLAUDE.md / GOAL_DRIVEN 等后端项目说明需要补充：`meta-socket` 同时承担 Bot Hub 聚合 API。

## 总体原则

- 返回前端渲染模型，不返回需要前端二次聚合的原始 PIN 列表。
- 聚合端只做声明式数据聚合：索引、折叠、归一、补全、排序和可验证统计。聚合端不得输出 `canOrder`、`disabledReason`、`available`、`availableReason` 等主观业务裁决字段，也不得替客户端判断服务是否能被请求或交易。
- 默认列表只返回 latest 非 revoke、`disabled != true`、`status` 在约定可展示范围内的服务；这是对链上声明状态的筛选，不代表后端判断服务是否可被请求或交易。API 返回链上声明的 `disabled`，不返回 `available = !disabled` 这类反向业务命名。
- 聚合端保留前端识别、展示、寻址和支付声明字段：`currentPinId`、`sourceServicePinId`、`chainName`、`operation`、`status`、`updatedAt`。
- 所有时间字段统一返回毫秒时间戳，字段名使用 `createdAt`、`updatedAt`、`aggregatedAt`。
- `aggregatedAt` 表示底层物化聚合视图最后更新时间，不是本次 HTTP 响应生成时间。
- 金额字段保持字符串，避免浮点精度问题。
- `id` 在列表和详情里统一使用 `currentPinId`，`sourceServicePinId` 作为稳定服务根 ID。
- 聚合端内部服务主键建议使用 `${chainName}:${sourceServicePinId}`。v1 不支持跨链版本链，`chainName` 是服务版本链所在链。
- `service` 对象在列表项和详情页保持兼容，方便前端从列表乐观渲染详情，再用详情接口补齐。
- API schema 必须版本化，例如 `schemaVersion: "botHubSkillService.v1"`。
- Cursor 是唯一可靠分页依据；`total` 是可选字段，只有当聚合端能低成本提供过滤后的总数时返回，否则返回 `null`。
- v1 不返回 provider 在线状态字段。现有 socket.io 在线状态只能表示“某个用户客户端在线”，不能证明 Bot 服务可接单。等 bot heartbeat 协议落地后再增加带来源的 presence 字段。
- 字段准入规则：v1 主接口只返回当前 Bot Hub 列表、详情和发起服务请求流程会消费的数据，或服务识别、通信寻址、支付声明必须依赖的数据。没有当前 UI 消费、没有当前产品决策、或没有协议来源的字段不得进入主响应。
- 未来可能有用的数据，例如服务推荐、完整版本历史、评价分页、订单统计、退款风险、请求表单 schema，只能放到明确标记的后续接口或 milestone，不能混进 v1 主接口。

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
| `chainName` | string | 否 | - | 按服务所在链筛选；取值 `mvc`、`btc`、`doge`、`opcat`；v1 至少支持 `mvc` |
| `outputType` | string | 否 | - | `text`、`image`、`video`、`audio`、`other` |
| `providerGlobalMetaId` | string | 否 | - | 只看某个 provider 的服务 |
| `sortBy` | string | 否 | `rating` | `rating`、`updated`、`price` |
| `order` | string | 否 | `desc` | `desc`、`asc` |
| `includeInactive` | number | 否 | `0` | `1` 时返回 revoked/disabled/status 异常服务，用于调试或管理后台 |

### Response

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "list": [
      {
        "id": "current-pin-id",
        "currentPinId": "current-pin-id",
        "sourceServicePinId": "first-create-pin-id",

        "serviceName": "zhuwei-fortune-service",
        "displayName": "紫微斗数算命服务",
        "description": "根据出生日期和时间，分析命盘、解读运势",
        "serviceIcon": "https://example.com/icon.png",
        "providerSkill": "zhuwei-fortune",
        "outputType": "text",

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

        "status": 0,
        "operation": "modify",
        "disabled": false,
        "chainName": "mvc",
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
  - v1 版本链不跨链：create、modify、revoke 必须在同一条链上，聚合端只在同一 `chainName` 内使用 `originalId` 折叠。
  - 如果发现 modify/revoke 的 `originalId` 指向其它链上的 create，v1 不折叠为同一服务；可记录兼容日志并按异常数据处理。
  - API `chainName` 是服务版本链所在链。
- 默认可见规则：
  - latest operation 为 `revoke` 时隐藏。
  - `disabled=true` 时隐藏。
  - `disabled` 直接来自 `contentSummary.disabled`；缺失时按 `false` 处理。
  - `status=0` 表示 confirmed/published，`status=1` 表示 indexed/pending confirmation；v1 默认二者可见。其它 status 隐藏，除非 `includeInactive=1`。
  - contentSummary 缺失或必填字段缺失时隐藏，除非 `includeInactive=1`。
- 服务字段从 `contentSummary` 解析，链上字段从 PIN 元数据补充。
- `currency/paymentChain/settlementKind/mrc20Ticker/mrc20Id` 需要归一化：
  - `MVC` 和旧 `SPACE` 兼容为前端展示的 `SPACE`。
  - MRC20 必须带 `mrc20Ticker` 和 `mrc20Id`。
- `serviceIcon/providerAvatar` 必须返回前端可直接加载的 URL，不返回需要前端再拼的 PIN asset 标识。
- `providerName/providerAvatar/providerChatPubkey` 由 provider profile 与 `/info/chatpubkey` 等信息补齐。
- `ratingAvg/ratingCount` 由 `/protocols/skill-service-rate` 聚合；当前列表排序需要评分时返回。内部平滑排序分数不作为 v1 响应字段返回。
- 默认排序推荐：
  - `sortBy=rating` 使用平滑评分，例如 `(avg * count + 4.0 * 5) / (count + 5)`。
  - 同分时按 `ratingCount`、`updatedAt` 降序。

## API 2: Bot Hub 技能服务详情

### Endpoint

`GET /api/bot-hub/skill-service/detail/{serviceId}`

### 用途

提供服务详情页首屏和发起服务请求弹窗所需的服务声明、provider 信息和支付声明字段。详情页不应再额外请求 provider profile、chat pubkey 或图标资产。接口只返回声明事实和聚合事实，不返回服务是否可被请求或交易的主观判断。

### Path Parameter

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `serviceId` | string | 支持 `currentPinId` 或 `sourceServicePinId` |

### Query Parameters

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `idType` | string | 否 | `auto` | `auto`、`currentPinId`、`sourceServicePinId` |
| `chainName` | string | 否 | - | 可选服务所在链名，用于多链索引时消除同名或同 id 查询歧义 |

### Response

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "service": {
      "id": "current-pin-id",
      "currentPinId": "current-pin-id",
      "sourceServicePinId": "first-create-pin-id",

      "serviceName": "zhuwei-fortune-service",
      "displayName": "紫微斗数算命服务",
      "description": "完整服务描述...",
      "serviceIcon": "https://example.com/icon.png",
      "providerSkill": "zhuwei-fortune",
      "outputType": "text",

      "price": "1",
      "currency": "SPACE",
      "settlementKind": "native",
      "paymentChain": "mvc",
      "mrc20Ticker": null,
      "mrc20Id": null,
      "paymentAddress": "18GED...",

      "status": 0,
      "operation": "modify",
      "disabled": false,
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
      "chatPubkey": "..."
    },

    "aggregatedAt": 1774531000000,
    "schemaVersion": "botHubSkillServiceDetail.v1"
  }
}
```

### 详情聚合规则

- `service` 字段必须与列表 item 的核心字段兼容。
- `provider.chatPubkey` 是 provider profile 的通信寻址字段，来源于 `/info/chatpubkey` 或等价 userinfo 聚合结果。缺失时返回 `null` 或省略该字段，聚合端不得把缺失转换成 `canOrder=false` 或任何主观原因码。
- 价格和结算信息直接保留在 `service` 内：`price/currency/paymentChain/settlementKind/paymentAddress/mrc20Ticker/mrc20Id`。详情接口不再额外复制出 `ordering.payment`。
- v1 不返回 `requestInput`、`transport` 或默认请求表单模型。当前业务界面的输入框、placeholder、maxLength 和本地校验由前端掌握；未来如果服务发布协议增加请求 schema，聚合端只能透传和校验协议内声明的 schema，不能凭空生成。
- 客户端或前端根据 `service`、`provider`、本地钱包状态和服务请求协议自行决定是否发起服务请求。聚合端只提供声明字段，不提供动作许可。
- v1 详情主响应不返回 rating 详情、订单统计、退款统计或 chain history。当前详情页没有这些展示区域，聚合端不得提前实现并塞入主响应。
- 当前业务界面不展示 related services，v1 详情主响应不返回 `relatedServices`。后续如果产品需要推荐区，必须先定义“相关”的业务规则和 UI 入口，再作为独立接口或二期字段实现。

## 未来扩展接口，不属于 v1

### 评价分页

`GET /api/bot-hub/skill-service/{sourceServicePinId}/ratings?size=20&cursor=...`

当前业务界面没有评价列表入口，该接口不属于 v1 实现范围。只有未来产品需要展示服务评价列表时再实现。

返回：

```json
{
  "code": 0,
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

返回 create/modify/revoke 历史。该接口不属于 v1 详情页首屏依赖，只在未来产品增加“链上版本记录”、管理后台或开发调试入口时实现。

`total` 仍为可选字段；cursor 分页接口不得要求调用方依赖总数。

## v1 涉及协议和数据源

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
- `outputType`
- `paymentAddress`
- `disabled`

协议约束：

- create PIN 的稳定服务根 ID 是自身 `id`。
- modify/revoke PIN 的 `originalId` 必须是一跳原始 create pin id；v1 聚合端不把“上一版本 pin id”作为规范写法。
- `originalId` 缺失的历史数据可兼容回退，但新数据必须写 `originalId`。
- `disabled` 是链上声明字段，API 原样返回布尔值；缺失时按 `false` 处理。v1 不返回 `available`。
- `status=0` 为 confirmed/published，`status=1` 为 indexed/pending confirmation；其它值为异常或不可展示。
- v1 强制同链版本链：modify/revoke 只能引用同一 `chainName` 下的 create。协议层当前 `originalId` 没有链名限定，跨链引用无法可靠消歧义，因此 v1 不支持跨链折叠。
- `chainName` 是该服务 create/modify/revoke 版本链所在链。

### `/protocols/skill-service-rate`

服务评价协议。v1 仅用于聚合列表排序需要的 `ratingAvg/ratingCount`。

`contentSummary` 预期 JSON 字段：

- `serviceID`，规范写法必须是 `sourceServicePinId`
- `servicePaidTx`，服务支付交易
- `rate`，1 到 5
- `comment`

聚合要求：

- 无效 rate 丢弃。
- 同一 rating pin 去重。
- 评分聚合应支持服务版本链。
- 过渡期兼容：如果历史 rating 的 `serviceID` 是 `currentPinId` 或旧版本 pin id，聚合端应通过服务版本映射反查到 `sourceServicePinId`。
- 新 rating 必须写 `sourceServicePinId`，否则可被标记为 compatibility fallback。

### `/info/chatpubkey`

provider 通信寻址字段来源之一。详情接口应尽力解析 provider 的 chat pubkey，并放入 `provider.chatPubkey`；缺失只表示聚合视图没有该声明字段，不代表后端判定服务不可请求。

### Provider profile 相关信息

聚合系统需要通过 MetaID/globalMetaId/address 解析 provider：

- 名称
- 头像
- 地址
- chat pubkey

部署在 `meta-socket` 时，provider profile 解析必须走 in-process `userinfo` 聚合/PebbleDB 查询；HTTP 请求链路中不允许再通过 HTTP 调用自身或远端 manapi 来补 profile。

远端 manapi / metafile-indexer 只能作为 `userinfo` 聚合模块的离线同步或补数来源，不应出现在 Bot Hub API 的 request path 中。

### 资产解析

`serviceIcon`、`providerAvatar` 需要返回可直接加载的 URL。

如果链上内容是 metafile、pin asset 或相对标识，聚合系统负责解析为 HTTP URL。

资产 URL base 必须来自配置项：

- 环境变量：`META_SOCKET_ASSET_BASE_URL`
- 推荐默认值：`https://manapi.metaid.io/content`
- 拼接规则：当资产字段是 pin id 或 content id 时，返回 `${META_SOCKET_ASSET_BASE_URL}/{id}`。
- 如果资产字段本身已经是 `http://` 或 `https://` URL，聚合端可校验后原样返回。

## 未来可能涉及协议，不属于 v1

### `/protocols/service-request`

服务请求协议。v1 Bot Hub 列表和详情主接口不聚合服务请求统计。只有未来产品界面明确需要展示请求量、成功率或评价验真时，才把该协议纳入对应扩展接口。

### `/protocols/service-refund-request`

退款请求协议。用于统计 provider 或服务的退款风险、`refundCount`、未处理退款等信息。

### `/protocols/service-refund-finalize`

退款完成协议。用于判断退款是否已处理，避免把已完成退款长期算作风险。

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

采用 meta-socket 主体接口错误约定：

- HTTP 状态码统一返回 200，除非请求没有进入业务服务，例如网关层断连。
- 成功：`code=0`，`message="ok"`。
- 参数错误：`code=40000`。
- 服务不存在：`code=40400`。
- 聚合服务内部错误：`code=50000`。
- 前端只应以 `code === 0` 判断成功；任何非 0 code 都是失败。

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

## 验收标准

- 列表接口返回的每个 item 可以直接渲染 Bot Hub 卡片，无需前端再请求 provider profile、chat pubkey、评分或图标。
- 详情接口返回后可以直接渲染详情首屏和发起服务请求弹窗所需的展示字段、provider 寻址字段和支付声明字段。
- 同一服务多次 modify 后，列表只出现当前有效版本。
- 服务被 revoke 后，默认不在列表出现；详情接口可按产品取舍返回 latest 声明记录或错误 `code=40400`，但不得返回 `canOrder/disabledReason` 这类动作许可字段。
- 评分能在同链服务版本链内聚合到同一个 `sourceServicePinId`。
- MRC20 服务详情返回足够的支付信息，前端无需自行推断 token id 或 payment chain。
- 所有图片 URL 可被前端直接加载。
- 所有时间均为毫秒时间戳。
- 分页 cursor 为 opaque 字符串，前端不解析其内部结构。
- 接口包含 `schemaVersion`，便于后续兼容升级。

## 后端开发建议

建议按可独立验收的 milestone 拆分，便于小步提交和逐步接入：

| Milestone | 内容 | 验收 |
| --- | --- | --- |
| M1 | `meta-socket` wire MVC indexer；索引 `/protocols/skill-service`；按 `originalId` 在同一 `chainName` 内折叠 create/modify/revoke；PebbleDB 持久化当前服务视图 | 构造同链 create+modify+revoke pin，验证聚合视图只保留当前有效服务，revoke 后默认不可见 |
| M2 | provider profile 接入；in-process 读取 `userinfo` 聚合/PebbleDB；补 `providerName/providerAvatar/providerChatPubkey` | 服务 item 含 provider 名称、头像、chat pubkey；request path 不调用远端 manapi |
| M3 | `/protocols/skill-service-rate` 索引与评分聚合；仅聚合列表排序需要的 avg/count；rating 的 `serviceID` 归一到 `sourceServicePinId` | 单元测试覆盖 source id、current id、旧版本 id 三种 rating 输入 |
| M4 | asset URL 解析；支持 `META_SOCKET_ASSET_BASE_URL` 配置 | serviceIcon/providerAvatar 都返回可加载 URL；配置缺省值可用 |
| M5 | HTTP list endpoint；filter/sort/cursor paginate；错误码 envelope | 集成测试覆盖筛选、排序、分页、错误 code |
| M6 | HTTP detail endpoint；声明式 service 字段；provider profile；支付声明字段 | 集成测试覆盖 currentPinId/sourceServicePinId 查询、缺失声明字段透传、MRC20 详情；不返回动作许可判断 |

第一阶段建议交付到 M6。

暂不进入当前实现范围的能力：ratings 分页、revisions 分页、订单统计、退款风险、relatedServices、request schema。只有后续产品界面明确需要对应展示或交互时，才为它们补独立需求和接口。
