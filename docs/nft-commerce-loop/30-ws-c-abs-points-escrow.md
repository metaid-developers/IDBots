# WS-C 开发任务书：ABS（`assist-base-service`）积分服务端托管、Bot 签名与免订阅直充

- **目标仓库**：`/Users/tusm/Documents/MetaID_Projects/assist-base-service`
- **建议分支**：`feat/me-nft-escrow-and-open-topup`（基于主干创建）
- **上游契约依赖**：[`01-protocols-and-contracts.md`](01-protocols-and-contracts.md) 中的 **契约 C4**

---

## 一、现状问题与核心安全红线

通过审计 `assist-base-service` 现有代码（`controller/me_controller.go`、`service/me_service/consume_service.go`、`service/me_service/deduction.go`、`service/me_service/janitor_service.go`、`service/me_service/topup_service.go`），直接复用现有 `/v1/me/freeze` + `/v1/me/capture` 做双边陌生人 Bot 数字商品交易存在 **5 个阻断级问题**：

1. **买方单方控制权漏洞（Fatal）**：`MeCapture`（`me_controller.go:416`）与 `MeRelease`（`me_controller.go:450`）目前仅校验 `freeze.IdentityAddress == identity`（只有买家能确认付款或释放退款）。若卖家先把链上不可逆的数字商品转给买家，恶意买家可调 `release` 拿回积分，或拒不调 `capture` 等 24 小时自动超时退回，造成“财货两空”。
2. **免费额度刷单套现漏洞（Fatal）**：`PlanDeduction`（`deduction.go:8-101`）默认按 `grant（每周免费额度） -> bonus -> topup -> earned` 扣款，而 `Capture` 会将全额计入卖家的永久 `earned` 池（`consume_service.go:632`）。若不隔离资金池，攻击者可批量建号把每周免费 `grant` 通过虚假买卖洗入大号的永久 `earned` 池。
3. **发货与超时自动退款竞态（Critical）**：`ExpireDueFreezes`（`janitor_service.go:14-43`）到期无脑自动退款；若卖家在到期临界点广播了链上转移或索引器延迟数秒，可能发生“商品已上链发给买家、积分却被定时任务退回买家”的双输事故。
4. **Bot 签名与主账户分离（Blocker）**：自动交易由用户的 MetaBot 进程发起（持有 `botAddress` 私钥），而用户充值的 ME 存在主账户 `identityAddress` 下（通过 `tb_traffic_address_binding` 绑定）。当前 `/v1/me/*` 不识别 `X-Bot-Address` 代签。
5. **新用户直充拦截（Blocker）**：`SubmitTopupOrder`（`topup_service.go:185-193`）强制要求 `activePaidSubscription`，未买月卡的新用户直接充 ME 会被 `SUBSCRIPTION_REQUIRED` 拒之门外，阻断冷启动现金流转化。

---

## 二、详细需求清单（REQ-C）

### REQ-C-01：新增 `PersistentPaidOnly` 扣款模式与 `tradeSpendableMilli` 余额展示
- **修改文件**：
  - `service/me_service/deduction.go`
  - `service/me_service/pools_service.go` / `controller/me_controller.go`（`GET /v1/me/balance`）
- **实现要求**：
  1. 在 `DeductionMode` 中新增 `DeductionModeTradePaidOnly`：仅规划从 `topup` 池与 `earned` 池扣减（顺序：`topup -> earned`），`grantMilli = 0`，`bonusMilli = 0`。若 `topup + earned < amountMilli`，返回标准 `INSUFFICIENT_ME` 错误并在详情中标明 `tradePoolOnly: true, neededMilli, haveMilli: topup+earned`（前端据此精准引导差额充值）。
  2. 在 `GET /v1/me/balance` 返回体中新增 `tradeSpendableMilli: topupMilli + earnedMilli`（保持原有全部字段不变）。

### REQ-C-02：扩展 `/v1/me/*` 鉴权支持 `X-Bot-Address` 绑定代签（契约 C4.1）
- **修改文件**：`controller/auth/traffic_auth.go`、`controller/me_controller.go`
- **实现要求**：
  1. 提取可选头 `X-Bot-Address`。
  2. 当 `X-Bot-Address` 非空时：
     - 使用 `VerifyTrafficIdentitySignature` 校验签名恢复地址等于 `X-Bot-Address`；
     - 查询 `tb_traffic_address_binding`（`status = active`）获取 `accountId`，再查 `tb_traffic_account` 解析出绑定的主账户 `identityAddress`；
     - 若存在有效绑定，将上下文的 `effectiveIdentityAddress` 设为该主账户 `identityAddress`，同时记录 `actorBotAddress = X-Bot-Address`；
     - 若该 `X-Bot-Address` 未绑定任何主账户（如独立测试 Bot），则回退 `effectiveIdentityAddress = X-Bot-Address`。
  3. 同样提供内部辅助函数 `ResolvePayeeIdentityAddress(addr string) string`：当卖方收款地址传入的是卖家的 `botAddress` 时，若其已绑定到卖家主账户 `identityAddress`，自动将 `earned` 积分结算进卖家主账户（方便卖家统一在个人中心查看收益）。

### REQ-C-03：新增数字商品积分托管订单表 `tb_me_nft_trade_order` 与防篡改护栏
- **新增文件**：`models/me_nft_trade_order_model.go`
- **GORM 幂等建表字段**：
  - `id` (BIGINT PK AUTO_INCREMENT)
  - `order_id` (VARCHAR(80) UNIQUE NOT NULL — 与 `tb_me_freeze.order_id` 1:1 对应)
  - `item_pin_id` (VARCHAR(100) NOT NULL, INDEX)
  - `collection_pin_id` (VARCHAR(100) NOT NULL, INDEX)
  - `listing_pin_id` (VARCHAR(100))
  - `buyer_identity_address` (VARCHAR(64) NOT NULL, INDEX)
  - `buyer_bot_address` (VARCHAR(64))
  - `buyer_nft_address` (VARCHAR(64) NOT NULL — 链上实际接收 MRC-721 的地址)
  - `seller_bot_address` (VARCHAR(64) NOT NULL — 链上当前持有 MRC-721 的发货地址)
  - `seller_identity_address` (VARCHAR(64) NOT NULL, INDEX — 积分最终入账 `earned` 的主地址)
  - `amount_milli` (BIGINT NOT NULL)
  - `status` (TINYINT NOT NULL, INDEX — `1:FROZEN_AWAITING_DELIVERY`, `2:DELIVERY_SUBMITTED`, `3:SETTLED`, `4:EXPIRED_REFUNDED`, `5:CANCELED_REFUNDED`, `6:DISPUTED_HOLD`)
  - `delivery_tx_id` (VARCHAR(80), UNIQUE NULLABLE — 非空时全局唯一，严防同一笔链上过户重放结算两张订单！)
  - `delivery_deadline` (BIGINT NOT NULL — 默认 `created_at + 900` 秒，可传参范围 `300..7200`)
  - `verify_attempts` (INT DEFAULT 0)
  - `verify_detail` (VARCHAR(512))
  - `settlement_entry_id` (VARCHAR(80))
  - `settled_at` (BIGINT)
  - `created_at` / `updated_at` (BIGINT)
- **修改 `tb_me_freeze` 与旧接口护栏**：
  - 在 `tb_me_freeze` 幂等增加布尔列 `system_escrow TINYINT(1) NOT NULL DEFAULT 0`（或通过 `ref_type = 'mrc721_escrow_v1'` 识别）。
  - **关键拦截**：在原有 `POST /v1/me/release` 和 `POST /v1/me/capture` 入口检查：凡 `system_escrow == 1`（或关联在 `tb_me_nft_trade_order` 名下）的冻结记录，**一律拒绝客户端直接调用 `MeRelease` / `MeCapture`**，返回 `403 ESCROW_GOVERNED_BY_SERVER`！

### REQ-C-04：服务端链上 MRC-721 过户核验器（`mrc721_verifier.go`）
- **新增文件**：`service/me_service/mrc721_verifier.go`
- **配置项**：在 `conf/` 增加 `metaso_indexer_base_url`（默认 `https://so.metaid.io`，支持本地/内网高速节点地址配置）。
- **两项核验能力**：
  1. **锁单前持仓预检 `VerifySellerCurrentlyOwns(ctx, itemPinId, expectedSellerAddress)`**：
     - 调 `GET /api/mrc721/item/info?pinId=<itemPinId>`，确认商品存在、`!burned`，且当前 `ownerAddress == expectedSellerAddress`（且无指向其他人的 `pending` 转出）。
  2. **发货后过户核验 `VerifyDeliveryTransfer(ctx, order, deliveryTxId)`**：
     - 标准化剥离 `:0:0` 后缀比对 64 位 hex `txId`；
     - 优先通过 `MvcBaseConn.GetTxDetail`（或 `GetTxRaw`）确认 `deliveryTxId` 在 MVC 网络真实存在且未被双花拒绝；
     - 结合 `metaso-p2p` `/api/mrc721/item/info?pinId=<itemPinId>` 与 `/api/mrc721/item/transfers?pinId=<itemPinId>` 核验：
       - **已确认或 0-conf 已索引**：`item.ownerAddress == order.BuyerNftAddress` 且转移列表中存在 `txId == deliveryTxId && fromAddress == order.SellerBotAddress && toAddress == order.BuyerNftAddress`；
       - **0-conf Mempool Pending 覆盖层**：`item.pending != nil && item.pending.txId == deliveryTxId && item.pending.fromAddress == order.SellerBotAddress && item.pending.toAddress == order.BuyerNftAddress`。
     - 返回三种结论：`VERIFIED_OK`（立即放款）、`INDEXER_LAGGING_RETRY`（交易在节点可见但索引器尚未追平，进入后台 5 秒重试队列）、`INVALID_DELIVERY`（接收地址不对或并非该 Item 的转移，拒绝该 `txId`）。

### REQ-C-05：实现 `/v1/me/nft-escrow/*` 全套接口与后台超时/重试守护（契约 C4.3）
- **新增文件**：`service/me_service/nft_escrow_service.go`、`controller/me_nft_escrow_controller.go`
- **路由挂载（`controller/http_controller.go`）**：
  - `POST /v1/me/nft-escrow/orders`（创建并按 `DeductionModeTradePaidOnly` 冻结，`freeze.ExpiresAt` 设为 `deliveryDeadline + 7200s` 安全缓冲）
  - `GET /v1/me/nft-escrow/orders/:orderId`（买卖双方均可查询验资）
  - `POST /v1/me/nft-escrow/orders/:orderId/deliver`（提交 `deliveryTxId` 并立即尝试核验结算，成功则在同一 MySQL 事务内调 `captureInTx` 将积分记入 `order.SellerIdentityAddress` 的 `earned` 池，同时确保 `tb_me_ledger` 严格追加且通过 `ComputeConservation()` 守恒校验！）
  - `POST /v1/me/nft-escrow/orders/:orderId/reject`（卖方未发货前主动拒单，立即 `releaseInTx` 退回买方）
  - `GET /v1/me/nft-escrow/orders`（按买方/卖方筛选订单列表）
- **定时守护与竞态保护（修改 `service/me_service/janitor_service.go` & `service/task/`）**：
  1. **严禁 `ExpireDueFreezes` 盲退处于 `DELIVERY_SUBMITTED (status=2)` 的订单**！
  2. 新增每 5~10 秒执行一次的 `SweepPendingNftEscrowOrders` 任务：
     - 对 `status = 2 (DELIVERY_SUBMITTED)` 的订单重试 `VerifyDeliveryTransfer`，一旦索引追平立即自动 `Capture` 完结；若重试超过 30 分钟仍无法在链上找到该 `txId` 且链上 `item.ownerAddress` 仍是卖家，方才安全回退；若商品已到买家地址则强制 `Capture`。
     - 对 `status = 1 (FROZEN_AWAITING_DELIVERY)` 且 `now > deliveryDeadline` 的超时未发货订单：退款前**先调一次 `item/info` 复核链上持有人**——若卖家其实已经把货转给了 `buyerNftAddress`（只是漏调了 `/deliver` 接口！），自动补走 `Capture` 保护卖家；确认商品未发给买家后，在同一事务内调 `releaseInTx` 退回买方并将订单置为 `status = 4 (EXPIRED_REFUNDED)`！

### REQ-C-06：开放免订阅直充 ME 与冷启动小额包（契约 C4.4）
- **修改文件**：`service/me_service/topup_service.go`（第 185-193 行附近）
- **实现要求**：
  1. 在 `tb_me_config` 增加动态配置键 `allow_topup_without_subscription`（默认值 **`true`**）。
  2. 当 `allow_topup_without_subscription == true` 时，`SubmitTopupOrder` 允许未订阅（`me_free`）用户直接下单购买充值包，不再返回 `ErrSubscriptionRequired`。
  3. 在种子迁移中确保存在适合数字商品冷启动的低门槛充值档位（如 ¥9.9 档），且保留现有支付宝（`alipay`）、`paypal` 及凭证通道正常工作。

---

## 三、测试与验收要求

1. **必须覆盖的 Go 单元测试（`service/me_service/nft_escrow_service_test.go`）**：
   - **资金池隔离测试**：买方有 `100,000` `grant` + `50,000` `bonus` + `0` `topup/earned` 时创建托管单必须返回 `INSUFFICIENT_ME`；充值 `20,000` `topup` 后锁 `15,000` 成功，结算后卖方 `earned` 精确增加 `15,000`，且 `ComputeConservation()` 账本守恒误差为 `0`！
   - **防买方白嫖测试**：创建托管单后，买方直接调 `POST /v1/me/release` 或 `POST /v1/me/capture` 必须被 `403 ESCROW_GOVERNED_BY_SERVER` 拦截。
   - **防重放与防一物二卖测试**：同一 `itemPinId` 并发下第二单返回 `ITEM_ALREADY_LOCKED`；同一 `deliveryTxId` 提交给另一张单被唯一键拦截；同一主账户下的两个不同 `botAddress` 自买自卖返回 `SELF_TRADE_FORBIDDEN`。
   - **竞态安全测试**：模拟卖家已链上发货但未调 `/deliver` 而订单到达 `deliveryDeadline`，验证清扫任务自动识别商品已到买家名下并执行 `Capture` 而非误退款。
   - **免订阅直充测试**：无订阅新用户调用 `SubmitTopupOrder` 成功创建订单并经 Webhook 入账 `topup` 池。
2. **交付命令证据**：`go build ./...` 退出码 0，`NO_COLOR=1 go test ./service/me_service/... ./controller/...` 全绿报告。
