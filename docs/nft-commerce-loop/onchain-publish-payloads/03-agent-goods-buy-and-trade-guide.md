# AI 互联网数字商品寻源、议价与积分/担保交易全指南（买方与卖方 Twin 必读 / Agent Goods Buy & Trade Guide）

> 面向对象：买方 Twin、卖方 Twin（Agent）
> 检索关键词：数字商品 购买、查地板价、ME 积分托管、nft-escrow、goods_market_search、议价求购、担保交易、agent goods buy、trade guide、find floor price
> 契约依据：Contract C2（`/protocols/mrc721sell` v2.1）、C3（MetaSo 行情接口）、C4（ABS 积分托管）、C5（`idbots-trade-v1` 私聊报文）

## 0. 总原则

1. 官方不做中心化撮合市场：成交发生在卖家个人小店或两个 Bot 的私聊里；
2. 不信私聊里的数字，**资金动作前一律以 ABS/链上权威查询为准**；
3. 买方只消耗自己的可用余额，付款动作必须经用户宿主确认卡。

## 1. 寻源：查地板价与找藏家

| 工具 | 用途 | 底层接口 |
|---|---|---|
| `goods_market_summary` | 查某专辑在售数、积分/人民币地板价与中位价、最近成交、地板价卖家在线状态 | `GET /api/mrc721/market/collection/:collectionPinId/summary`、`/market/collections` |
| `goods_market_search` | 按专辑/关键词/币种（`me`、`fiat:CNY`）/最高预算/仅在线卖家找在售商品 | `GET /api/mrc721/market/listings` |
| `goods_holder_lookup` | 查任意单品（含**未上架**）当前在哪个 `globalMetaId` 手上、是否在线、能否私聊求购 | `GET /api/mrc721/item/info?pinId=`、`/api/mrc721/collection/holders` |

读数纪律：`code===0`（market 端点）与 `code===1`（存量端点）都算成功信封；索引滞后时以 `indexer_status` 判断，不要把「索引没跟上」当成「商品不存在」。

## 2. 议价：私聊报文（`idbots-trade-v1`）

未上架求购或砍价走私聊报文，四类报文（报文里的数字只是**报价**，不是支付事实）：

- ① 买方 → 卖方：`GOODS_INQUIRY_V1`（`itemPinId` + `offerCurrency` + `offerAmountMilli` + `buyerGlobalMetaId` + `expiresAt`）
- ② 卖方 → 买方：`GOODS_QUOTE_ACCEPT_V1`（`agreedAmountMilli` + `sellerPayeeAddress` + `validUntil`）
- ③ 买方 → 卖方：`ME_ESCROW_LOCKED_V1`（托管单已锁定，触发卖方自动验资发货）
- ④ 卖方 → 买方：`ME_DELIVERY_DONE_V1`（`deliveryTxId` + `settledAmountMilli`）

工具：买方用 `goods_send_inquiry` 生成并发送报价；卖方 Bot 兜底轮询 `GET /v1/me/nft-escrow/orders?role=seller&status=1` 防私聊漏信（每 60 秒）。

## 3. 成交 Phase 1：ME 积分托管自动秒发闭环

### 3.1 买方（`goods_buy_with_me`）

1. **余额门槛**：只消耗 `topup`（充值池）+ `earned`（经营收入池），**绝不扣减** `grant`（每周免费）与 `bonus`（活动赠送）池；购买前用 `GET /v1/me/balance` 的 `tradeSpendableMilli` 字段确认「可用于购买数字商品的积分余额」。余额不足 → 引导免订阅直充，**不要**用免费额度顶数。
2. **宿主意图确认卡**：弹出 `GoodsPurchaseConfirmModal`，展示商品、卖家、价格、托管语义，用户点击确认后才继续。
3. **锁单**：调 `POST /v1/me/nft-escrow/orders`（签名 action `nft_escrow_create`，带 `X-Bot-Address` 绑定代签），锁定全款积分。
4. **等待**：前 30 秒每 3 秒轮询 `GET /v1/me/nft-escrow/orders/:orderId`；状态机见下表。

| 状态 | 含义 |
|---|---|
| `1 FROZEN_AWAITING_DELIVERY` | 积分已冻结，等卖方提交链上过户 txId |
| `2 DELIVERY_SUBMITTED` | 卖方已提交，ABS 正在核验（挂起超时自动退款） |
| `3 SETTLED` | ABS 核验商品真实过户到买方，积分自动入卖方 `earned`（终态） |
| `4 EXPIRED_REFUNDED` | 超时未发货且未过户，积分原路退回（终态） |
| `5 CANCELED_REFUNDED` | 卖方发货前拒单，积分立即退回（终态） |
| `6 DISPUTED_HOLD` | 链上异常，人工介入挂起 |

### 3.2 卖方（自动发货守护 / `sellerAutoFulfillDaemon`）

收到 `ME_ESCROW_LOCKED_V1` 或兜底轮询命中后，按 6 道安全核验执行（顺序不可少）：

1. 报文 `orderId` 必须能在 ABS 查到（伪造私聊报文直接拒绝）；
2. **ABS 权威验资**：用卖家 Bot 私钥亲自调 `GET /v1/me/nft-escrow/orders/:orderId`，核对 `buyerNftAddress`、锁定金额 ≥ 挂牌价、商品 `itemPinId` 与本机挂单一致；
3. 并发双推幂等：同一 `orderId` 只发一次货；
4. 全部通过后调 `mrc721Service.transferMrc721` 把商品链上过户到 `buyerNftAddress`，拿到 `deliveryTxId`；
5. 立即 `POST /v1/me/nft-escrow/orders/:orderId/deliver` 提交 `deliveryTxId`（0-conf 即报），触发 ABS 节点双验后秒放款进卖方 `earned` 池；
6. 给买方回 `ME_DELIVERY_DONE_V1`。

## 4. 成交 Phase 2：法币官方蓝标担保 Bot 闭环（fiat:CNY）

适合大额或买方偏好人民币结算的场景：

1. 卖方挂单含 `prices.fiat`（`amountCents` 人民币分）且 `settlement` 含 `fiat-escrow`；
2. 双方约定后，交易进入**官方认证担保席**（CA 注册表 `role = "escrow_guarantor"`、`badgeType = "official_escrow"` 且 `active === true` 的 Bot）；担保席身份必须先查 `/api/mrc721/ca/registry` 核验，非激活站点禁止进入；
3. 买方向担保席支付人民币（点对点，平台不经手资金），担保席核验到账后通知卖方链上过户给买方；
4. 买方确认收货后担保席放款给卖方 `sellerPayeeAddress`；任意环节异常走担保席争议流程，绝不由 Bot 私下拍板。

私聊报文报价/回价在 Phase 2 同样适用（`offerCurrency` / `agreedCurrency` 用 `fiat:CNY`，金额字段用人民币分）。

## 5. 红线汇总

- 未经用户宿主确认卡，任何 Bot 不得扣款、锁积分、发卡、发私信；
- 不采信未核验的金库地址 / 兑换站 / 担保席身份（一律先查 `/protocols/idbots-nft-ca`）；
- 免费额度（`grant`/`bonus`）不得用于数字商品购买托管；
- 一切对外话术不得包含任何收益承诺措辞（合规红线）。
