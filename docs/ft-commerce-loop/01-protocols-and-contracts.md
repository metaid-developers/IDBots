# 跨系统冻结接口与链上协议契约（01-Protocols and Contracts v1.0）

> **契约纪律**：本文件是 `WS-1`、`WS-2`、`WS-3`、`WS-4`、`WS-5`、`WS-6` 六个开发工作流共享的**唯一真相源（Frozen Contract v1.0）**。任何子 Session 不得自行改名字段、改变精度单位或削弱验链条件；若实测中发现需要调整，必须向主控中心发起契约变更申请。

---

## 契约 C1：同质化代币通用挂单协议（`/protocols/ft-sell` v1.0）

### 1.1 设计目标与协议路径
- **Pin Path**：`/protocols/ft-sell`（固定路径，无后缀，`operation = "create"`）。
- **核心作用**：
  1. 为 MVC 链上无全局索引的 sCrypt `TokenSell` 合约种子锁（见 `docs/token-sell-protocol.md`）提供全网可检索的订单发现层；
  2. 为 **BTC MRC-20** 与 **MVC MetaContract FT** 提供统一的 **ME 积分挂单（`me-escrow`）** 与 **法币担保挂单（`fiat-escrow`）** 声明；
  3. 可选镜像关联 `metaid.market` 的 `btc-psbt` 挂单，实现同一资产三端流动性统一检索。
- **规范资产唯一键（`assetKey`，全系统统一主键，严禁仅用 `symbol` 区分代币）**：
  - **BTC MRC-20**：`mrc20:<mrc20Id>`（例如 `mrc20:4f92...i0`）
  - **MVC MetaContract FT**：`mvc-ft:<codehash>:<genesis>`（全小写 hex）

### 1.2 Payload JSON Schema（v1.0）

```json
{
  "active": true,
  "listingKey": "mvc-ft:a242...01:005d...49:e281d9a2...267b:0",
  "asset": {
    "assetKey": "mvc-ft:a242...01:005d...49",
    "chain": "mvc",
    "standard": "metacontract-ft",
    "codehash": "a242...01",
    "genesis": "005d...49",
    "mrc20Id": null,
    "symbol": "METAID",
    "tokenName": "MetaID Token",
    "decimals": 8
  },
  "lot": {
    "amountBase": "20000000000",
    "amountDisplay": "200",
    "utxoOutpoint": "e281d9a2d0475da86c59e0973ebda42ac3a8fa96b25adad084f59f519e5d267b:0"
  },
  "sellerAddress": "1MVC...",
  "sellerBtcAddress": "bc1q...",
  "sellerMetaId": "idq1...",
  "rails": {
    "mvcTokenSell": {
      "sellTxid": "3663e0f341d08772983c6d195662af7740ed0914854d16ab52aec90ea634c",
      "tokenListTxid": "e281d9a2d0475da86c59e0973ebda42ac3a8fa96b25adad084f59f519e5d267b",
      "tokenListOutputIndex": 0,
      "priceSats": 50000000,
      "sellerAddress": "1MVC..."
    },
    "btcPsbt": null,
    "me": {
      "amountMilli": 29000,
      "autoFulfill": true
    },
    "fiat": null
  },
  "acceptedRails": ["mvc-tokensell", "me-escrow"],
  "batchGroupId": "batch_1795300000_x8k2",
  "batchIndex": 1,
  "batchTotal": 5,
  "note": "老玩家分包出货，积分锁单 24h 自动秒发",
  "createdAt": 1795300000,
  "expiresAt": 1797892000
}
```

### 1.3 覆盖语义与链上真值自动失效规则（硬约束）
1. **主键与撤单**：以 `listingKey`（推荐格式 `<assetKey>:<utxoOutpoint>`）为主键，同一 `sellerAddress` 下最新一条有效 Pin 覆盖旧 Pin。撤单载荷：`{ "active": false, "listingKey": "...", "sellerAddress": "...", "sellerMetaId": "idq1...", "createdAt": 1795303600 }`。
2. **互斥安全原则（防一币双吃冲突）**：
   - 若某颗 MVC FT UTXO 已经锁入 `TokenSell` 合约脚本（即 `rails.mvcTokenSell != null`），此时代币已离开卖家普通 P2PKH FT 余额池，卖家守护进程无法再直接普通转账给 ME 买家 —— **因此同一颗 `utxoOutpoint` 上，`mvc-tokensell`（合约锁仓轨）与 `me-escrow`（钱包直转轨）不得同时置为非空**！若卖家希望同时支持收 SPACE 和收 ME，由经纪人技能将 1000 枚拆成例如“3 包挂 `mvc-tokensell` + 2 包挂 `me-escrow`”，通过同一个 `batchGroupId` 聚合在一张席位卡展示。
   - 同理，BTC 侧若某颗 MRC-20 UTXO 已挂入 `metaid.market`（`rails.btcPsbt != null`），建议与 `me-escrow` 分包隔离，避免买家刚锁 ME 的瞬间该 PSBT 在公开市场被他人抢吃。
3. **UTXO 存活真值过滤（消除脏单）**：
   - 当 `rails.mvcTokenSell != null` 时，`lot.utxoOutpoint` 指向 `tokenListTxid:tokenListOutputIndex`；MetaSo 通过 `higun` 核验该合约 UTXO 未被花费（一旦被 `take` 或 `cancel` 花费，立即置 `effectiveActive = false`）。
   - 当 `rails.me != null` 时，`lot.utxoOutpoint` 指向卖家自己地址持有的可用 FT UTXO（MVC 查 `higun` `/ft/utxos`，BTC 查 `man-p2p` `mrc20_utxo_*` 且 `status == Available`）；一旦该 UTXO 被转走或拆掉，挂单自动失效。

---

## 契约 C2：MetaSo-P2P 代币行情、挂单聚合与全域搜索 HTTP 契约

所有 `/api/ft/market/*` 端点统一返回标准信封：`{ "code": 0, "message": "success", "data": ... }`。

### 2.1 代币市场列表与单币三端聚合行情
- **`GET /api/ft/market/tokens?chain=(all|btc|mvc)&keyword=&verifiedOnly=false&sort=(volume_desc|listed_desc|holders_desc)&cursor=&size=20`**
- **`GET /api/ft/market/token/:assetKey/summary`**（`:assetKey` 需 URL encode）
  - 响应 `data`：
    ```json
    {
      "asset": {
        "assetKey": "mrc20:4f92...i0",
        "chain": "btc",
        "standard": "mrc20",
        "mrc20Id": "4f92...i0",
        "codehash": null,
        "genesis": null,
        "symbol": "METAID",
        "tokenName": "MetaID Coin",
        "decimals": 8,
        "icon": "metafile://...",
        "caVerified": true
      },
      "holderCount": 4280,
      "listedLotCount": 36,
      "listedTotalAmountDisplay": "18400",
      "floors": {
        "btcUnitSats": "9.8",
        "spaceUnitSats": null,
        "meUnitMilli": "145"
      },
      "recentGranularity": {
        "medianLotAmountDisplay": "200",
        "p25LotAmountDisplay": "100",
        "p75LotAmountDisplay": "500"
      },
      "tradeStats24h": {
        "tradeCount": 19,
        "volumeTokenDisplay": "6200",
        "lastUnitPriceMeMilli": "150",
        "lastTradeAt": 1795299100
      }
    }
    ```
  - **关键字段价值**：`recentGranularity`（近期成交单包中位数与四分位数）专门供 `metabot-token-broker` 技能在卖家出货时自动给出**最优智能拆包份数建议**！

### 2.2 在售代币包检索接口（支撑买方背包凑单与三端筛选）
- **`GET /api/ft/market/listings`**
  - Query 参数：
    - `assetKey`（推荐精确传参；若仅传 `symbol`，接口返回匹配列表并附带同名多资产告警 `ambiguousAssets`）
    - `rail`：`"mvc-tokensell"` | `"me-escrow"` | `"btc-psbt"` | `"any"`
    - `seller`：卖家地址或 `globalMetaId`
    - `onlineOnly`：`true` / `false`（对 `me-escrow` 默认建议传 `true`，确保卖家守护进程在线秒发）
    - `maxTotalMeMilli` / `maxTotalSats`（可选整包总价过滤，方便背包凑单预筛）
    - `sort`：`"unit_price_asc"` | `"lot_amount_asc"` | `"newest"`
    - `cursor`, `size`（默认 50，最大 200，满足买方一次拉取深度跑凑单算法）
- **`GET /api/ft/market/trades?assetKey=...&cursor=&size=20`**：聚合 `/protocols/ft-trade` 回执与链上 `TokenSell` 吃单记录。
- **`search_metaweb` 全域检索扩展**：新增 `protocol = "ft-token"` 与 `protocol = "ft-listing"` 文档源。

---

## 契约 C3：ABS 积分买币服务端托管契约（`/v1/me/ft-escrow/*`）

严格继承 `WS-C`（`docs/nft-commerce-loop/30-ws-c-abs-points-escrow.md`）的安全红线：
1. **专用扣款池**：强制使用 `DeductionModeTradePaidOnly`（仅扣买方 `topup -> earned`，严禁动用 `grant / bonus`）；结算后划入卖方绑定主账户 `earned` 池。
2. **禁止买方单方撤单/确认**：所有关联 `tb_me_ft_trade_order` 的冻结单均标记 `system_escrow = 1`，客户端直接调 `/v1/me/release` 或 `/v1/me/capture` 一律返回 `403 ESCROW_GOVERNED_BY_SERVER`。
3. **支持 `X-Bot-Address` 代签**：买卖双方均由各自的 MetaBot 钱包私钥签名发起。

### 3.1 数据表 `tb_me_ft_trade_order` 核心字段
- `order_id` (`VARCHAR(80) UNIQUE NOT NULL`)
- `asset_key` (`VARCHAR(160) NOT NULL`, INDEX — 如 `mrc20:<id>` 或 `mvc-ft:<codehash>:<genesis>`)
- `chain` (`VARCHAR(16) NOT NULL` — `"btc"` | `"mvc"`)
- `token_amount_base` (`VARCHAR(80) NOT NULL` — 十进制无符号大整数字符串，严禁用浮点数！)
- `decimals` (`INT NOT NULL`)
- `listing_pin_id` (`VARCHAR(100)`)
- `locked_utxo_outpoint` (`VARCHAR(100)` — 同一 `locked_utxo_outpoint` 在 `status IN (1,2)` 期间全局互斥锁，防并发双买撞单！)
- `buyer_identity_address` / `buyer_bot_address` / `buyer_receive_address`（买方在目标链实际收币的地址：BTC 为 `bc1.../1...`，MVC 为 `1...`）
- `seller_bot_address` / `seller_source_address`（卖方在目标链实际发币的地址） / `seller_identity_address`
- `amount_milli` (`BIGINT NOT NULL`)
- `status` (`TINYINT NOT NULL` — `1:FROZEN_AWAITING_DELIVERY`, `2:DELIVERY_SUBMITTED`, `3:SETTLED`, `4:EXPIRED_REFUNDED`, `5:CANCELED_REFUNDED`, `6:DISPUTED_HOLD`)
- `delivery_tx_id` (`VARCHAR(80) UNIQUE NULLABLE` — BTC 侧传 `revealTxId`，MVC 侧传 FT 转账 `txId`；全局唯一防一笔转账重放结算两单！)
- `delivery_deadline` (`BIGINT NOT NULL` — 默认 `created_at + 900` 秒)

### 3.2 双链权威到账核验器规范（安全核心！）
1. **`VerifyMvcFtDelivery`（对接 `higun`）**：
   - 查询 `higun` `/db/ft/utxo?txid=<deliveryTxId>` 及 0-conf `/ft/mempool/utxos`（辅以 MVC 节点 `GetTxRaw` 核验 v10 `txid` 真实上链未双花）：
   - 必须存在至少一个有效 FT 输出满足：`codehash == expectedCodehash && genesis == expectedGenesis && ownerAddress == order.BuyerReceiveAddress && BigInt(amountBase) >= BigInt(order.TokenAmountBase)`，且输入侧来源于 `order.SellerSourceAddress`。
2. **`VerifyBtcMrc20Delivery`（对接 `man-p2p` / `metalet-service`）**：
   - **反欺诈重点提示**：在 `man-p2p`（`man/mrc20.go`）中，若一笔 MRC-20 转账 JSON 格式错误或输入余额不足，索引器会执行 `sendAllAmountToFirstOutput()`（可能把币退回给卖家自己），此时链上交易虽然存在，但买家根本没收到有效币！
   - 因此 **严禁仅解析 BTC 原始交易脚本 JSON 字面量**！核验器必须查询经 `man-p2p` 验证器处理后的资产输出（确认或 `TransferPendingIn` 状态），确认 `mrc20Id == expectedMrc20Id && toAddress == order.BuyerReceiveAddress && BigInt(verifiedAmountBase) >= BigInt(order.TokenAmountBase)` 后方可返回 `VERIFIED_OK`。

### 3.3 HTTP 接口清单
- `POST /v1/me/ft-escrow/orders`：预检卖方在 `higun` / `man-p2p` 确有足额可用余额且 `locked_utxo_outpoint` 未被锁定 → 扣锁买方 `topup/earned` 积分 → 返回 `orderId`。
- `GET /v1/me/ft-escrow/orders/:orderId`：买卖双方查询订单状态与验资详情。
- `POST /v1/me/ft-escrow/orders/:orderId/deliver`：卖方提交 `{ deliveryTxId }` → 立即跑双链核验器 → `VERIFIED_OK` 则单事务 `captureInTx` 入账卖方 `earned` 池；若节点可见但索引器差几秒尚未追平，置 `status = 2 (DELIVERY_SUBMITTED)` 交由后台 5 秒清扫协程自动追平完结（**绝不因超时清扫误退处于 `status = 2` 的订单**）。
- `POST /v1/me/ft-escrow/orders/:orderId/reject`：卖方未发币前主动拒单退回买方积分。
- `GET /v1/me/ft-escrow/orders?role=(buyer|seller)&status=...`：订单列表查询。

---

## 契约 C4：IDBots 薄宿主本地安全 RPC 与仪式感卡片语法契约

### 4.1 `metaidRpcServer.ts` 新增本地 RPC 路由（均受 `Authorization: Bearer <IDBOTS_RPC_TOKEN>` 保护）

| 路由路径 | 方法 | 用途与安全门禁 |
|---|---|---|
| `/api/idbots/commerce/ft-mandate-confirm` | `POST` | **统一意图确认闸**：技能在执行任何拆包、挂单、扫货、锁积分前调用，唤起前端 `FtMandateConfirmModal`（若 `rail === "me-escrow"` 且余额不足，原地展开扫码直充 ME）；用户点击确认后签发一次性短期 `mandateToken`（绑定动作、资产、数量与金额上限，5 分钟有效）。 |
| `/api/idbots/wallet/mvc/ft-split` | `POST` | 基于 `walletRawTxService.buildMvcFtTransferRawTx` / `buildMvcOrderedRawTxBundle`，将大额 MVC FT UTXO 按 `lotAmountsBase: string[]` 精确拆分为多颗本钱包独立 UTXO 并广播，返回每颗新 UTXO 的 `outpoint`。需携带已批准的 `mandateToken`。 |
| `/api/idbots/wallet/mvc/token-sell/list` | `POST` | 调用 `mvcTokenSellService.sellToken` 将指定精确面额 FT UTXO 锁入 `TokenSell` 合约（自动跑 `checker mint -> seed -> list`），可选同步广播 `/protocols/ft-sell` Pin。需携带 `mandateToken`。 |
| `/api/idbots/wallet/mvc/token-sell/verify` | `POST` | 只读：调用 `mvcTokenSellService.verifyMvcTokenSellListing` 对链上种子锁与代币输出做 100% 本地字节级验真（防假报价欺诈）。 |
| `/api/idbots/wallet/mvc/token-sell/buy` | `POST` | 校验 `mandateToken` 预算上限与链上 `verify` 通过后，调用 `mvcTokenSellService.takeToken` 用 SPACE 原子吃单。 |
| `/api/idbots/wallet/mvc/token-sell/cancel` | `POST` | 卖家自吃解锁撤回 `TokenSell` 挂单，并自动广播 `/protocols/ft-sell` `active: false` Pin。 |
| `/api/idbots/commerce/ft-watch/register` | `POST` | 将挂出的 `metaid.market` `orderId`、`mvc-tokensell` 种子或本地 `me-escrow` 批次注册进宿主 SQLite 挂单簿（`ft_active_orders`），由 `TokenOrderWatcher` 与 `SellerAutoFulfillDaemon` 接管 24 小时后台值守与手机 Push 通知。 |

### 4.2 四大仪式感对话卡片代码块语法（Markdown Fenced Blocks）
链上技能或工具在回复末尾附加以下 JSON 代码块，渲染层（桌面端 Studio/BotWorks 与移动端）自动解析渲染为可视化交互卡片：

1. **```` ```ft-quote-card ````**（全网三端比价卡）：
   ```json
   {
     "assetKey": "mrc20:4f92...i0",
     "symbol": "METAID",
     "caVerified": true,
     "quotes": [
       { "rail": "btc-psbt", "label": "MetaID.Market (BTC)", "floorUnit": "9.8 sat", "depthDisplay": "12,400", "recommended": true },
       { "rail": "mvc-tokensell", "label": "MVC 链上原子单", "floorUnit": "0.0042 SPACE", "depthDisplay": "5,000", "recommended": false },
       { "rail": "me-escrow", "label": "积分秒发柜台 (ME)", "floorUnit": "0.145 ME", "depthDisplay": "3,200", "recommended": false }
     ],
     "suggestion": "0.01 BTC 预算下推荐走 BTC 通道组合扫入 3 单共 1,000 枚，均价最优"
   }
   ```
2. **```` ```ft-order-card ````**（挂牌席位凭证卡 —— 卖方仪式感与裂变核心）：
   ```json
   {
     "batchGroupId": "batch_1795300000_x8k2",
     "assetKey": "mrc20:4f92...i0",
     "symbol": "METAID",
     "rail": "me-escrow",
     "lotAmountDisplay": "200",
     "totalLots": 5,
     "filledLots": 0,
     "unitPriceLabel": "0.145 ME / 枚（每包 29 ME）",
     "autoFulfill": true,
     "sellerGlobalMetaId": "idq1...",
     "orderRefs": ["pinid_1", "pinid_2", "pinid_3", "pinid_4", "pinid_5"]
   }
   ```
   - 卡片自带实时进度条、**「生成社群推销海报」** 按钮（复用 `PromoAmmoPackModal` 合规分享框架）与 **「一键全部撤单」** 按钮。
3. **```` ```ft-fill-card ````**（成交喜报战报卡）：
   ```json
   {
     "side": "buy",
     "symbol": "METAID",
     "totalTokenDisplay": "1000",
     "filledOrderCount": 3,
     "totalPaidLabel": "0.00942 BTC（含矿工费）",
     "avgUnitPriceLabel": "9.10 sat / 枚",
     "txids": ["tx1...", "tx2...", "tx3..."],
     "nextActions": ["browse_token_goods", "browse_paybuzz"]
   }
   ```

---

## 契约 C5：数字商品支持指定 Token 购买扩展（`/protocols/mrc721sell` v2.2 & A2A 交割）

### 5.1 `/protocols/mrc721sell` v2.2 向后兼容扩展
在现有 v2.1 `prices` 对象中新增可选数组 `tokens`（旧读取器自动忽略未知键，100% 兼容）：

```json
"prices": {
  "me": { "amountMilli": 15000 },
  "fiat": { "currency": "CNY", "amountCents": 990 },
  "tokens": [
    {
      "assetKey": "mrc20:4f92...i0",
      "chain": "btc",
      "standard": "mrc20",
      "mrc20Id": "4f92...i0",
      "symbol": "METAID",
      "decimals": 8,
      "amountBase": "20000000000",
      "amountDisplay": "200",
      "sellerReceiveAddress": "bc1q..."
    },
    {
      "assetKey": "mvc-ft:a242...01:005d...49",
      "chain": "mvc",
      "standard": "metacontract-ft",
      "codehash": "a242...01",
      "genesis": "005d...49",
      "symbol": "SHOW",
      "decimals": 8,
      "amountBase": "50000000000",
      "amountDisplay": "500",
      "sellerReceiveAddress": "1MVC..."
    }
  ]
},
"autoFulfillTokens": true
```
- 当 `prices.tokens` 非空时，`acceptedCurrencies` 包含对应的 `"ft:<assetKey>"`，MetaSo `/api/mrc721/market/listings` 新增过滤参数 `tokenAssetKey`。

### 5.2 A2A 交割协议报文（复用 ```` ```idbots-trade-v1 ```` 通道）
1. **积分买 FT 通知报文**：
   - `ME_FT_ESCROW_LOCKED_V1`（买方 -> 卖方）：`{ type, orderId, assetKey, amountMilli, buyerReceiveAddress }`
   - `ME_FT_DELIVERY_DONE_V1`（卖方 -> 买方）：`{ type, orderId, deliveryTxId }`
2. **Token 买数字商品（MRC-721）双轨报文**：
   - **同链 MVC 原子轨**：`FT_GOODS_ATOMIC_PROPOSAL_V1`（买方拼好带自身 FT 输入 + TransferCheck + 买方收 NFT 输出的半签名交易发给卖方守护进程） -> 卖方 `SellerAutoFulfillDaemon` 校验自身收到的 FT 树根与数量精确等于挂牌价后，自动补签 MRC-721 输入广播上链，回传 `FT_GOODS_ATOMIC_SETTLED_V1(txId)`。
   - **跨链异构秒发轨（如 BTC MRC-20 买 MVC MRC-721）**：
     1. 买方发 `TOKEN_GOODS_RESERVE_V1({ itemPinId, assetKey, buyerNftAddress })`；
     2. 卖方守护进程核实该 `itemPinId` 在库且未被其他活跃托管单锁定，加 5 分钟本地排他锁，回传 `TOKEN_GOODS_RESERVED_V1({ reservationId, sellerReceiveAddress, amountBase, expiresAt })`；
     3. 买方广播 MRC-20 转账后发 `TOKEN_GOODS_PAID_V1({ reservationId, paymentTxId })`；
     4. 卖方守护进程调 `man-p2p` / `metalet-service` 核验 `paymentTxId` 真实向 `sellerReceiveAddress` 转入足额有效 `assetKey`（且 `paymentTxId` 在本地 SQLite 防重放表中未使用过），立即执行 `mrc721_transfer` 并发回 `TOKEN_GOODS_DELIVERED_V1({ reservationId, nftDeliveryTxId })`。

---

## 契约 C6：链上加密付费阅读协议（`/protocols/paybuzz` v1.0 & 双轨自动发钥）

### 6.1 链上加密文章 Pin 结构
- **Pin Path**：`/protocols/paybuzz`（`operation = "create"` | `"modify"`）
- **加密算法**：标准 `AES-256-GCM`（随机 96-bit `iv`，128-bit `authTag`）。对称密钥 `K`（32 bytes）**永不明文上链**，由作者宿主按 `HMAC-SHA256(authorMasterSeed, "paybuzz-key:v1:" + cipherSha256)` 确定性派生（同时写入本机 SQLite 备份），确保作者换设备恢复助记词后所有历史文章自动可继续发钥！
- **Payload JSON Schema**：
  ```json
  {
    "title": "2027 AI Agent 链上微观经济与量化策略深度报告",
    "preview": "公开导读前 300 字……（可被 search_metaweb 全文检索命中）",
    "contentType": "text/markdown",
    "wordCount": 6800,
    "encryption": {
      "algo": "AES-256-GCM",
      "ivHex": "24hex...",
      "authTagHex": "32hex...",
      "cipherSha256": "64hex...",
      "ciphertextPinOrBase64": "metafile://<pinId>.enc"
    },
    "authorMetaId": "idq1...",
    "authorMvcAddress": "1MVC...",
    "unlockRules": {
      "mePriceMilli": 2000,
      "tokenPrices": [
        {
          "assetKey": "mrc20:4f92...i0",
          "chain": "btc",
          "standard": "mrc20",
          "mrc20Id": "4f92...i0",
          "symbol": "METAID",
          "decimals": 8,
          "amountBase": "1000000000",
          "amountDisplay": "10",
          "receiveAddress": "bc1q..."
        }
      ],
      "vipMrc721Collections": [
        {
          "collectionPinId": "<64hex>i0",
          "collectionName": "AI 实战年度专栏权益卡"
        }
      ]
    },
    "createdAt": 1795300000
  }
  ```

### 6.2 双轨自动发钥私聊契约（```` ```idbots-payread-v1 ````，挂接 `privateChatDaemon` 零 LLM 消耗快路径）
1. **轨道 A —— 持 NFT 会员卡 0 元验资秒开（`PAYREAD_VIP_REQ_V1`）**：
   - 读者 Bot 用持有权益卡的钱包私钥对挑战串 `"payread-vip:<paybuzzPinId>:<readerGlobalMetaId>:<timestamp>"`（5 分钟时间窗防重放）签名，向作者 `authorMetaId` 发送：
     `{ "type": "PAYREAD_VIP_REQ_V1", "paybuzzPinId": "...", "collectionPinId": "...", "holderAddress": "1MVC...", "timestamp": 1795300100, "signatureHex": "..." }`
   - 作者 `PayReadFulfillDaemon` 恢复签名地址等于 `holderAddress`，并调 MetaSo `/api/mrc721/address/item?address=<holderAddress>&collectionPinId=<collectionPinId>` 确认当前持有有效未销毁 Item `>= 1` → 立即通过加密私聊（`/protocols/simplemsg` ECDH 端到端加密）回传 `PAYREAD_KEY_GRANT_V1`。
2. **轨道 B —— FT / ME 单篇微支付秒开（`PAYREAD_TOKEN_REQ_V1`）**：
   - 读者完成链上 Token 转账（或 ABS ME 微支付锁单）后发送：
     `{ "type": "PAYREAD_TOKEN_REQ_V1", "paybuzzPinId": "...", "assetKey": "mrc20:4f92...i0", "paymentTxId": "...", "readerGlobalMetaId": "idq1..." }`
   - 作者 `PayReadFulfillDaemon` 校验 `paymentTxId` 未在本地 `paybuzz_used_payments` 表消费过，并调 `man-p2p` / `higun` 核验该笔交易确向作者配置的 `receiveAddress` 转入 `>= amountBase` 的指定代币 → 记录 `paymentTxId` 唯一消费锁，立即通过加密私聊回传：
     `{ "type": "PAYREAD_KEY_GRANT_V1", "paybuzzPinId": "...", "contentKeyHex": "64hex...", "grantedVia": "token" | "vip-nft" }`。
