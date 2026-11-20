# 跨系统冻结接口与链上协议契约（01-Protocols and Contracts v1.0）

> **契约纪律**：本文件是 `WS-A`、`WS-B`、`WS-C`、`WS-D`、`WS-E`、`WS-F` 六路开发 Session 共享的**唯一真相源（Frozen Contract v1.0）**。任何子 Session 不得自行改名字段、改变状态码或新增未约定必填项；若实测中发现不可行项，必须向主控中心发起契约变更申请。

---

## 契约 C1：官方蓝标认证注册表扩展（`/protocols/idbots-nft-ca` v1.1）

### 1.1 设计原则与向后兼容性
- 沿用现有已上线的 `/protocols/idbots-nft-ca` 协议（参见 `docs/idbots-nft-ca-protocol.md` 与 `src/main/services/nftCaService.ts`），**不新开链上路径**。
- 利用 v1 第 2 节预留规则（*"future optional keys may be added; clients must ignore unknown keys"*），在根 JSON 对象中保留 `collections`，新增可选数组 **`officialBots`**。
- **唯一根信任锚（Trust Root）**：官方 MetaBot `"Bob"`：
  - `metaid`: `2379692b225136b2b54e83aac52174f622b80181b17254bb7b5cf7b0aa323212`
  - `globalMetaId`: `idq1w8ye5psdkqrn6ugxxwvf5p4kkeuzufa6n9tt47`
  - `mvcAddress`: `1BNesCuvJeW2DAF42xkyCU1ifZVuNZ61mv`
  - 默认创世 PinID：`77da77280b9b218cf1edd62f658ca2be561dd7e377f3980182e280487ec38c56i0`（通过 `operation=modify` 在同路径更新全量内容，最新 Pin 生效）。
- **红线校验**：任何非 `OFFICIAL_IDBOTS_METAID` 创建或修改的同路径 Pin 一律视为无效伪造，客户端与索引器均必须丢弃。

### 1.2 Payload JSON Schema（v1.1）

```json
{
  "collections": [
    {
      "collectionPinId": "<collection_desc pinId, 64hex>i<n>",
      "collectionName": "metabot-avatar",
      "displayTitle": "MetaBot 官方初代头像",
      "legacySeries": {
        "codehash": "e205939ad9956673ce7da9fbd40514b30f66dc35",
        "genesis": "005d69cba8c80e6978157e146f998c21288a9d49",
        "swapStationGlobalMetaId": "idq1gtxzx45ktj8s738s6wjak0ha27d98g8h2n059n"
      },
      "note": "IDBots 官方认证冷启动数字商品专辑",
      "certifiedAt": 1795200000
    }
  ],
  "officialBots": [
    {
      "globalMetaId": "idq1gtxzx45ktj8s738s6wjak0ha27d98g8h2n059n",
      "metaId": "<64hex optional>",
      "mvcAddress": "176C9RPWDggnvdVcWG3wrZEJcm1bHTcKM5",
      "role": "swap_station",
      "badgeType": "official_tool",
      "badgeLabel": "官方兑换站",
      "swapConfig": {
        "vaultAddress": "1Mw6q8iZ2dYXd6vYwdYfd3ybUKNnWKj8ET",
        "supportedSeries": [
          {
            "collectionSlug": "metabot-avatar",
            "targetCollectionPinId": "<collection_desc pinId>",
            "codehash": "e205939ad9956673ce7da9fbd40514b30f66dc35",
            "genesis": "005d69cba8c80e6978157e146f998c21288a9d49",
            "maxTokenIndex": 9560,
            "minConfirmations": 1
          }
        ]
      },
      "active": true,
      "certifiedAt": 1795200000
    },
    {
      "globalMetaId": "idq1...",
      "mvcAddress": "1MVC...",
      "role": "escrow_guarantor",
      "badgeType": "official_escrow",
      "badgeLabel": "官方认证担保席",
      "escrowConfig": {
        "custodyAddress": "1MVC...",
        "supportedCurrencies": ["fiat:CNY"],
        "maxOrderCnyCents": 500000
      },
      "active": true,
      "certifiedAt": 1795200000
    }
  ]
}
```

### 1.3 字段规则
- `role` 枚举（v1.1 冻结）：`"swap_station"` | `"escrow_guarantor"` | `"official_announcer"`（严守“官方身份仅出现在公告、兑换工具、行情读数三处 + 法币担保席”红线，禁止给普通卖家打官方标）。
- `active`：`false` 表示已吊销，客户端硬拦截任何向 `active !== true` 的兑换站或担保席转入资产的动作。

---

## 契约 C2：数字商品上架协议扩展（`/protocols/mrc721sell` v2.1）

### 2.1 协议路径与基础规则（继承 v2 冻结纪律）
- **Pin Path**：`/protocols/mrc721sell`（固定路径，无后缀，仅 `CREATE` 操作生效）。
- **覆盖语义**：以 payload 中的 `itemPinId` 为主键，链上顺序**最新一条有效 Pin 覆盖旧 Pin**；撤单 = 广播一条同 `itemPinId` 且 `"active": false` 的新 Pin。
- **不重复写元数据**：payload 内不含 `protocol` / `version` 字段。
- **所有权真值规则（新增硬约束）**：上架意图仅在 `mrc721nft` 当前实时持有人 `item.ownerAddress === intent.sellerAddress && !item.burned` 时视为有效在售（`effectiveActive = true`）。一旦商品链上过户（无论是成交还是普通转账），旧挂单自动失效，即使新持有人把商品转回原卖家，也必须重新广播新挂单才恢复在售。

### 2.2 Payload JSON Schema（v2.1，完全兼容 v2 旧读取器）

```json
{
  "active": true,
  "itemPinId": "<64hex>i<n>",
  "collectionName": "metabot-avatar",
  "collectionPinId": "<collection_desc pinId>",
  "itemOutpoint": { "txid": "<64hex>", "vout": 0, "satoshis": 546 },
  "sellerAddress": "1MVC...",
  "sellerMetaId": "idq1...",
  "prices": {
    "me": {
      "amountMilli": 15000
    },
    "fiat": {
      "currency": "CNY",
      "amountCents": 990
    }
  },
  "autoFulfillMe": true,
  "negotiable": true,
  "shopMetaAppPinId": "<optional 64hex>i0",
  "priceHintSats": 750000,
  "acceptedCurrencies": ["me", "fiat:CNY"],
  "settlement": ["me-escrow", "fiat-escrow"],
  "note": "稀有金框墨镜部件，积分秒自动发货",
  "createdAt": 1795200000,
  "expiresAt": 1797792000
}
```

### 2.3 定价与字段校验规则
1. **`prices.me.amountMilli`**：可选正整数（单位 `milli-ME`，`1 ME = 1000 milli-ME`，最小挂牌价 `1000` 即 `1 ME`）。存在时 `acceptedCurrencies` 必含 `"me"`，`settlement` 必含 `"me-escrow"`。
2. **`prices.fiat`**：可选对象，`currency` 当前固定支持 `"CNY"`，`amountCents` 为正整数（单位：人民币分，如 `990` = `¥9.90`，最小 `100` 即 `¥1.00`）。存在时 `acceptedCurrencies` 必含 `"fiat:CNY"`，`settlement` 必含 `"fiat-escrow"`。
3. **`autoFulfillMe`**：布尔值（默认 `true`）。为 `true` 且设置了 `prices.me.amountMilli` 时，表示卖家授权本地 IDBots 守护进程在核实 ABS 托管单锁定金额 `>= prices.me.amountMilli` 后自动执行链上发货。
4. **撤单简写载荷**：`{ "active": false, "itemPinId": "<64hex>i<n>", "sellerAddress": "1MVC...", "sellerMetaId": "idq1...", "createdAt": 1795203600 }`。

---

## 契约 C3：MetaSo-P2P 数字商品行情、持有人与全域搜索 HTTP 契约

所有新增/升级的 `/api/mrc721/market/*` 与 `/api/mrc721/ca/*` 端点统一返回标准信封：
`{ "code": 0, "message": "success", "data": ... }`（注：原有 `/api/mrc721/collection/*`、`/item/*`、`/address/*` 维持 `{ "code": 1, "message": "ok", "data": ... }` 以保证存量 `mrc721Service.ts` 零破坏兼容！客户端辅助函数同时兼容 `code === 0 || code === 1`）。

### 3.1 官方 CA 注册表查询
- **`GET /api/mrc721/ca/registry`**
  - 响应 `data`:
    ```json
    {
      "verified": true,
      "pinId": "<latest_ca_pin_id>",
      "officialMetaId": "2379692b225136b2b54e83aac52174f622b80181b17254bb7b5cf7b0aa323212",
      "updatedAt": 1795200000,
      "collections": [ ... ],
      "officialBots": [ ... ]
    }
    ```
- **透出字段注入**：
  - 在 `/api/mrc721/collection/*` 的 `CollectionDTO` 中追加：`caVerified: boolean`, `caDisplayTitle?: string`, `holderCount: number`, `listedCount: number`, `floorPriceMeMilli: number | null`, `floorPriceCnyCents: number | null`, `medianPriceMeMilli: number | null`, `medianPriceCnyCents: number | null`。
  - 在 `/api/info/*`、`POST /api/bots/search`、`GET /api/bot-homepage/:globalMetaId` 中追加：`officialBadge: { verified: boolean, role: string, badgeType: string, badgeLabel: string } | null`。

### 3.2 专辑级行情聚合接口（支撑“只读价格聚合页”与“兑换即开店默认中位价”）
- **`GET /api/mrc721/market/collections?caOnly=true&keyword=&sort=(listed_desc|volume_desc|floor_me_asc|newest)&cursor=&size=20`**
- **`GET /api/mrc721/market/collection/:collectionPinId/summary`**
  - 响应 `data`:
    ```json
    {
      "collectionPinId": "<64hex>i0",
      "collectionName": "metabot-avatar",
      "displayTitle": "MetaBot 官方初代头像",
      "cover": "metafile://...",
      "caVerified": true,
      "totalSupply": 9560,
      "mintedCount": 312,
      "burnedCount": 0,
      "holderCount": 148,
      "listedCount": 42,
      "listedMeCount": 38,
      "listedCnyCount": 19,
      "floorPriceMeMilli": 12000,
      "medianPriceMeMilli": 18000,
      "floorPriceCnyCents": 880,
      "medianPriceCnyCents": 1500,
      "floorSeller": {
        "globalMetaId": "idq1...",
        "address": "1MVC...",
        "name": "小林的Twin",
        "avatar": "metafile://...",
        "isOnline": true,
        "shopMetaAppPinId": "<optional_pin_id>",
        "itemPinId": "<64hex>i0",
        "itemName": "MetaBot Avatar #1310"
      },
      "tradeStats": {
        "totalTrades": 27,
        "trades24h": 6,
        "volumeMeMilli24h": 92000,
        "lastSalePriceMeMilli": 15000,
        "lastSaleAt": 1795198000
      }
    }
    ```

### 3.3 在售商品列表检索接口（支持按专辑、卖家、币种、在线状态、价格排序）
- **`GET /api/mrc721/market/listings`**
  - Query 参数：
    - `collectionPinId`（可选，精确匹配专辑）
    - `seller`（可选，支持 `sellerAddress` 或 `sellerMetaId` 即 `idq1...`）
    - `currency`（可选：`"me"` | `"fiat:CNY"` | `"any"`，默认 `"any"`）
    - `minPrice` / `maxPrice`（可选整数；当 `currency=me` 时按 `milli-ME` 过滤，当 `currency=fiat:CNY` 时按 `cents` 过滤）
    - `onlineOnly`（可选布尔值，`true` 仅返回卖家当前全局在线的挂单）
    - `caOnly`（可选布尔值，`true` 仅返回官方 CA 认证专辑的商品）
    - `keyword`（可选，匹配 `itemName` / `desc` / `note` / `#编号`）
    - `sort`：`"price_me_asc"` | `"price_me_desc"` | `"price_cny_asc"` | `"price_cny_desc"` | `"newest"`（默认 `"newest"`）
    - `cursor`, `size`（默认 20，最大 100）
  - 响应行 `ListingDTO`：
    ```json
    {
      "intentPinId": "<64hex>i0",
      "itemPinId": "<64hex>i0",
      "collectionPinId": "<64hex>i0",
      "collectionName": "metabot-avatar",
      "caVerified": true,
      "itemName": "MetaBot Avatar - Glasses #1310",
      "cover": "metafile://...",
      "metadata": "{...}",
      "prices": {
        "me": { "amountMilli": 15000 },
        "fiat": { "currency": "CNY", "amountCents": 990 }
      },
      "autoFulfillMe": true,
      "negotiable": true,
      "acceptedCurrencies": ["me", "fiat:CNY"],
      "settlement": ["me-escrow", "fiat-escrow"],
      "note": "稀有金框墨镜部件",
      "shopMetaAppPinId": "<optional>",
      "seller": {
        "address": "1MVC...",
        "globalMetaId": "idq1...",
        "name": "小林的Twin",
        "avatar": "metafile://...",
        "hasChatPubkey": true,
        "isOnline": true,
        "lastSeenAgoSeconds": 12
      },
      "listedAt": 1795200000,
      "expiresAt": 1797792000,
      "confirmed": true
    }
    ```

### 3.4 持有人查询与未上架商品寻址接口
1. **`GET /api/mrc721/address/item` 与 `/api/mrc721/address/collection` 增强**：
   - 新增可选参数 `globalMetaId=idq1...`（服务端通过 `userinfo` 解析出对应的 MVC 地址集合进行查询，使个人小店 MetaApp 和 Agent 仅凭 `globalMetaId` 即可查出对方持有的全部已上架+未上架数字商品）。
2. **`GET /api/mrc721/collection/holders?pinId=<collectionPinId>&cursor=&size=50`**：
   - 返回 `{ holderCount, list: [{ address, globalMetaId, name, avatar, isOnline, hasChatPubkey, itemCount, listedItemCount }] }`（按持有数量降序）。
3. **单品详情富化（`GET /api/mrc721/item/info?pinId=`）**：
   - 在保持原响应字段不变的前提下，附加 `ownerProfile: { globalMetaId, name, avatar, isOnline, hasChatPubkey }` 与 `activeListing: ListingDTO | null`（让 Bot 查任意编号——无论上架与否——一次请求拿到当前在谁手上、是否在线、挂没挂单、卖多少钱！）。

### 3.5 成交记录上报与查询接口
- **`GET /api/mrc721/market/trades?collectionPinId=&itemPinId=&party=&cursor=&size=20`**
  - 索引两类真实链上交割：① 命中 `/protocols/mrc721offer` 的链上成交；② 带有成交回执协议 `/protocols/mrc721trade`（由 ABS 或买卖 Bot 在链上过户确认后广播的轻量回执，或关联匹配有效 `SellIntentRecord` 在挂单期间发生的 `sellerAddress -> buyerAddress` 过户）。
  - 返回字段：`txId`, `itemPinId`, `itemName`, `cover`, `collectionPinId`, `sellerAddress`, `sellerMetaId`, `buyerAddress`, `buyerMetaId`, `currency` (`"me"` | `"fiat:CNY"` | `"space"`), `amountMilli?`, `amountCents?`, `priceSats?`, `settledAt`, `verifiedSource` (`"abs_escrow"` | `"chain_offer"` | `"escrow_bot"`).

### 3.6 `search_metaweb`（`GET /api/metaweb/search`）新增协议类型
在现有 8 种协议基础上新增 2 种 `protocols` 枚举：
- `"mrc721-collection"`：索引专辑标题、slug、描述、CA 标签、地板价摘要；
- `"mrc721-listing"`：索引当前有效在售单的商品名称、编号、备注、价格文本、卖家昵称。

---

## 契约 C4：ABS（`assist-base-service`）积分服务端托管与直充 API 契约

基础路径：`https://www.metaso.network/assist-open-api`（开发环境可由 `IDBOTS_ASSIST_OPEN_API_BASE` 覆盖）。

### 4.1 统一鉴权扩展（支持 `X-Bot-Address` 绑定代签）
在保持现有 `X-Identity-Address` + `X-Timestamp` + `X-Signature`（签名原文 `"me:<action>:<tsSeconds>"`）100% 兼容的基础上，新增可选请求头：
- **`X-Bot-Address: <MetaBot MVC Address>`**
- 当携带 `X-Bot-Address` 时：
  1. 服务端校验 `X-Signature` 的恢复地址等于 `X-Bot-Address`；
  2. 查询 `tb_traffic_address_binding` 确认该 `botAddress` 已激活绑定到某个 `accountId`，并查 `tb_traffic_account` 解析出主账户 `identityAddress`（若请求头同时传了 `X-Identity-Address`，二者必须一致；若未传 `X-Identity-Address`，自动填充该主账户 `identityAddress`）；
  3. 扣款、冻结与收款统一记在主账户 `identityAddress` 名下，并在流水备注记录操作的 `botAddress`。
  - **兜底兼容**：若某独立运行的测试 Bot 尚未绑定主人 `tb_traffic_address_binding`，则将 `botAddress` 自身作为独立 `identityAddress` 处理（保持现有 `meChargeService.ts` 单测与独立钱包语义兼容）。

### 4.2 交易专用扣款池规则（`PersistentPaidOnly`）
- 凡涉及数字商品购买托管（`/v1/me/nft-escrow/*`），**严格启用 `PersistentPaidOnly` 模式**：
  - 扣款顺序固定为：**`topup`（充值池） → `earned`（经营收入池）**；
  - **禁止扣减 `grant`（每周免费额度）和 `bonus`（活动赠送池）**！
  - 在 `GET /v1/me/balance` 响应中新增显式字段 **`tradeSpendableMilli`** = `max(0, topupMilli + earnedMilli)`，供客户端在购买前精准展示“可用于购买数字商品的积分余额”。

### 4.3 服务端链上验真托管接口（`/v1/me/nft-escrow/*`）

#### 订单状态枚举
| 状态码 | 枚举名 | 含义 |
|---|---|---|
| `1` | `FROZEN_AWAITING_DELIVERY` | 买方积分已从 `topup+earned` 冻结，等待卖方提交链上 MRC-721 转移 `txId` |
| `2` | `DELIVERY_SUBMITTED` | 卖方已提交 `deliveryTxId`，ABS 正在核验链上/索引器过户状态（此状态挂起超时自动退款！） |
| `3` | `SETTLED` | ABS 已核验 `itemPinId` 真实过户至 `buyerNftAddress`，积分已自动划入卖方 `earned` 池（终态） |
| `4` | `EXPIRED_REFUNDED` | 超过 `deliveryDeadline` 卖方未发货（且链上商品未过户给买方），积分已原路退回买方 `topup/earned`（终态） |
| `5` | `CANCELED_REFUNDED` | 卖方在发货前主动拒单取消，积分立即原路退回买方（终态） |
| `6` | `DISPUTED_HOLD` | 链上交易异常（如发错地址或长时无法解析），人工介入挂起 |

#### (1) 创建托管单并冻结买方积分（买方调用）
- **`POST /v1/me/nft-escrow/orders`**（签名 action：`nft_escrow_create`）
- 请求体：
  ```json
  {
    "orderId": "ord_mrc721_1795200000_a1b2c3",
    "itemPinId": "<64hex>i0",
    "collectionPinId": "<64hex>i0",
    "sellerBotAddress": "1SellerBotMVC...",
    "sellerPayeeAddress": "1SellerPayeeMVC_or_same...",
    "buyerNftAddress": "1BuyerBotMVC...",
    "amountMilli": 15000,
    "deliveryTimeoutSec": 900,
    "listingPinId": "<optional_mrc721sell_pin_id>"
  }
  ```
- 服务端前置校验：
  1. `orderId` 幂等（同一买方相同参数重放返回原单，`applied: false`）；
  2. 同一 `itemPinId` 当前不能存在另一笔处于 `status IN (1, 2)` 的活跃订单（防一物二卖锁单冲突，冲突返回 `ITEM_ALREADY_LOCKED`）；
  3. 解析买方最终 `buyerIdentityAddress` 与卖方最终收款 `sellerIdentityAddress`（若 `sellerPayeeAddress` 是绑定在某主账户下的 `botAddress`，自动归一到该主账户 `identityAddress`），要求 `buyerIdentityAddress !== sellerIdentityAddress`（拦截自买自卖，返回 `SELF_TRADE_FORBIDDEN`）；
  4. 向 `metaso-p2p` `/api/mrc721/item/info?pinId=<itemPinId>` 实时核验该商品未销毁且当前 `ownerAddress === sellerBotAddress`（不匹配返回 `SELLER_NOT_CURRENT_OWNER`）；
  5. 从买方 `topup -> earned` 冻结 `amountMilli` 写入 `tb_me_freeze`（标记 `escrowManaged = true`，**禁止买方通过 `/v1/me/release` 或 `/v1/me/capture` 私自操作该冻结单**！）。
- 响应 `data`:
  ```json
  {
    "orderId": "ord_mrc721_1795200000_a1b2c3",
    "status": 1,
    "statusName": "FROZEN_AWAITING_DELIVERY",
    "itemPinId": "<64hex>i0",
    "collectionPinId": "<64hex>i0",
    "buyerIdentityAddress": "1BuyerIdentity...",
    "buyerNftAddress": "1BuyerBotMVC...",
    "sellerBotAddress": "1SellerBotMVC...",
    "sellerIdentityAddress": "1SellerIdentity...",
    "amountMilli": 15000,
    "createdAt": 1795200000,
    "deliveryDeadline": 1795200900,
    "applied": true
  }
  ```

#### (2) 查询托管单详情（买卖双方或公开凭 `orderId` 验资）
- **`GET /v1/me/nft-escrow/orders/:orderId`**（签名 action：`nft_escrow_get`，允许买方或卖方签名读取）
- 响应：同上订单结构 + `deliveryTxId`, `settledAt`, `settlementEntryId`, `verifyDetail`。
- **卖家验资黄金准则**：卖家 Bot 绝不轻信私聊文字，必须亲自调用本接口确认 `status === 1 (FROZEN_AWAITING_DELIVERY)` 且 `sellerBotAddress`、`itemPinId`、`amountMilli` 完全符合预期后，才调用 `mrc721_transfer` 发货！

#### (3) 提交发货链上凭证并触发自动结算（卖方调用，买方也可代触发催结）
- **`POST /v1/me/nft-escrow/orders/:orderId/deliver`**（签名 action：`nft_escrow_deliver`）
- 请求体：`{ "deliveryTxId": "<64hex>" }`
- 服务端处理：
  1. 校验 `deliveryTxId` 未被其他历史订单使用过（数据库唯一键防重放）；
  2. 将订单置为 `status = 2 (DELIVERY_SUBMITTED)`，记录 `deliveryTxId`；
  3. 立即执行链上核验（`VerifyMrc721Delivery`）：
     - 查询 `metaso-p2p` `GET /api/mrc721/item/info?pinId=<itemPinId>` 与 `/api/mrc721/item/transfers?pinId=<itemPinId>`（结合 `MvcBaseConn.GetTxDetail` 校验交易存在且未双花）；
     - 判据（满足其一即通过，支持 0-conf 秒级体验）：
       - 实时持有人 `item.ownerAddress === order.buyerNftAddress` 且最新转移记录的 `txId`（剥离 `:0:0` 后缀）等于 `deliveryTxId`；
       - 或 `item.pending.txId === deliveryTxId && item.pending.fromAddress === order.sellerBotAddress && item.pending.toAddress === order.buyerNftAddress`（0-conf 内存池有效过户）。
  4. **验证通过**：在同一数据库事务内调用 `captureInTx` 将 `amountMilli` 划入 `order.sellerIdentityAddress` 的 `earned` 池，订单置为 `status = 3 (SETTLED)`，同步返回 `{ status: 3, statusName: "SETTLED", settlementEntryId: "...", payeeEarnedAfter: ... }`！
  5. **若索引器尚未同步（几秒延迟）**：保持 `status = 2 (DELIVERY_SUBMITTED)` 并由 ABS 后台每 5 秒轮询核验任务自动完成 `SETTLED`，绝不因短暂索引延迟误退积分。

#### (4) 卖方发货前主动拒单取消（卖方调用）
- **`POST /v1/me/nft-escrow/orders/:orderId/reject`**（签名 action：`nft_escrow_reject`）
- 仅在 `status === 1` 且无 `deliveryTxId` 时允许卖方调用，立即 `releaseInTx` 原路退回买方 `topup/earned` 池，置为 `status = 5 (CANCELED_REFUNDED)`。

#### (5) 我的托管买卖订单列表
- **`GET /v1/me/nft-escrow/orders?role=(buyer|seller|all)&status=&limit=20`**（签名 action：`nft_escrow_list`）

### 4.4 免订阅直充 ME 契约
- ABS 配置项 `allow_topup_without_subscription` 默认设为 `true`：未开通付费订阅（`me_free`）的用户调用 `POST /v1/me/topup/orders` 不再抛 `SUBSCRIPTION_REQUIRED`。
- 预置小额冷启动充值档位（例如 `¥9.9 → 100 ME`、`¥29.9 → 320 ME`、`¥99 → 1100 ME`，具体汇率走 `tb_me_topup_package` 表配置）。

---

## 契约 C5：Bot↔Bot 结构化私聊协议报文规范（A2A Wire Protocol）

为确保双边 Bot（不同 LLM 模型也能 100% 稳定解析，不靠自然语言猜字段），所有跨 Bot 业务协同在 `/protocols/simplemsg` 私聊正文中采用 **可读自然语言摘要 + 标准围栏 JSON 载荷** 格式：

### 5.1 旧资产兑换报文（Twin Bot ↔ 官方兑换站 Bot）

**① 兑换申领单（用户 Twin → 兑换站 Bot）**：
````markdown
你好，我已将旧版藏品转入官方金库，申请升级兑换为新版数字商品：
```idbots-swap-v1
{
  "type": "SWAP_CLAIM_V1",
  "requestId": "swap_1795200000_x9f2",
  "collectionSlug": "metabot-avatar",
  "codehash": "e205939ad9956673ce7da9fbd40514b30f66dc35",
  "genesis": "005d69cba8c80e6978157e146f998c21288a9d49",
  "recipientAddress": "1UserTwinMVC...",
  "recipientGlobalMetaId": "idq1...",
  "items": [
    { "tokenIndex": "1310", "depositTxId": "<64hex>" }
  ]
}
```
````

**② 兑换完成回执（兑换站 Bot → 用户 Twin）**：
````markdown
你的数字商品升级兑换已完成，新版商品已发往你的钱包地址：
```idbots-swap-v1
{
  "type": "SWAP_COMPLETED_V1",
  "requestId": "swap_1795200000_x9f2",
  "collectionSlug": "metabot-avatar",
  "collectionPinId": "<64hex>i0",
  "results": [
    {
      "tokenIndex": "1310",
      "status": "sent",
      "itemPinId": "<64hex>i0",
      "deliveryTxId": "<64hex>",
      "itemName": "MetaBot Avatar - Glasses #1310",
      "cover": "metafile://..."
    }
  ]
}
```
````

### 5.2 积分交易与议价报文（买家 Bot ↔ 卖家 Bot）

**① 议价/求购单（买家 Bot → 卖家 Bot，用于未上架求购或砍价；若按挂牌一口价购买可跳过此步直接锁单）**：
````markdown
我想求购你的数字商品，报价如下：
```idbots-trade-v1
{
  "type": "GOODS_INQUIRY_V1",
  "inquiryId": "inq_1795200100_k3m1",
  "itemPinId": "<64hex>i0",
  "offerCurrency": "me",
  "offerAmountMilli": 12000,
  "buyerNftAddress": "1BuyerBotMVC...",
  "buyerGlobalMetaId": "idq1...",
  "expiresAt": 1795201900
}
```
````

**② 卖家同意报价回执（卖家 Bot → 买家 Bot）**：
````markdown
同意该报价，请在有效期内锁定积分托管单：
```idbots-trade-v1
{
  "type": "GOODS_QUOTE_ACCEPT_V1",
  "inquiryId": "inq_1795200100_k3m1",
  "itemPinId": "<64hex>i0",
  "agreedCurrency": "me",
  "agreedAmountMilli": 12000,
  "sellerBotAddress": "1SellerBotMVC...",
  "sellerPayeeAddress": "1SellerPayeeMVC...",
  "validUntil": 1795201900
}
```
````

**③ 积分托管已锁定通知（买家 Bot → 卖家 Bot，触发卖家自动验资发货）**：
````markdown
我已在平台积分托管系统锁定全款积分，请核验订单并发货：
```idbots-trade-v1
{
  "type": "ME_ESCROW_LOCKED_V1",
  "orderId": "ord_mrc721_1795200000_a1b2c3",
  "itemPinId": "<64hex>i0",
  "amountMilli": 15000,
  "buyerNftAddress": "1BuyerBotMVC...",
  "sellerBotAddress": "1SellerBotMVC..."
}
```
````

**④ 已发货成交通知（卖家 Bot → 买家 Bot）**：
````markdown
数字商品已链上转出并完成积分结算，感谢惠顾！
```idbots-trade-v1
{
  "type": "ME_DELIVERY_DONE_V1",
  "orderId": "ord_mrc721_1795200000_a1b2c3",
  "itemPinId": "<64hex>i0",
  "deliveryTxId": "<64hex>",
  "settledAmountMilli": 15000
}
```
````
