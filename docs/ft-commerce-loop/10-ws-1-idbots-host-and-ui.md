# WS-1 开发任务书：IDBots 薄宿主原语、自动交割/盯单守护与仪式感 UI

- **负责范围**：`IDBots` 主客户端（本地安全 RPC 补齐、单次合并授权闸、卖家 FT 自动验资发货扩展、纯链上挂单成交感知与手机 Push 通知、四张对话仪式感卡片）
- **建议分支与工作树**：分支 `feat/ft-host-primitives-and-ui`，工作树 `.worktrees/ft-host-primitives-and-ui`（从 `main` 创建）
- **上游契约依赖**：[`01-protocols-and-contracts.md`](01-protocols-and-contracts.md) 中的 **契约 C1、C3、C4、C5.2（ME_FT 部分）**

---

## 一、设计原则与文件边界

1. **严守“薄宿主”定位**：
   - 不在客户端左侧导航新增“数字货币交易所”一级入口；
   - 宿主仅暴露受控本地 RPC 与渲染语法，任何跨市场比价、背包凑单、颗粒度分析逻辑全部留给 `WS-3` 链上技能 `metabot-token-broker`。
2. **最大化复用既有底层服务**：
   - MVC FT 拆包直接复用 `src/main/services/walletRawTxService.ts:723`（`buildMvcFtTransferRawTx` / `buildMvcOrderedRawTxBundle`）；
   - MVC `TokenSell` 合约操作直接复用 `src/main/services/mvcTokenSellService.ts` 与 `src/main/libs/mvcTokenSellCore.ts`；
   - BTC MRC-20 转账直接复用 `src/main/services/mrc20Service.ts`（`executeMrc20Transfer`）；
   - 差额扫码直充 ME 直接复用 `src/renderer/components/commerce/GoodsPurchaseConfirmModal.tsx` / `MePurchaseFlow.tsx` 的轮询补能组件。

---

## 二、详细需求清单（REQ-1）

### REQ-1-01：`metaidRpcServer.ts` 补齐 MVC FT 拆包、TokenSell 与确认闸路由（契约 C4.1）
- **修改文件**：`src/main/services/metaidRpcServer.ts`、新增 `src/main/services/ftMandateGateService.ts`
- **实现要求**：
  1. 实现 `POST /api/idbots/commerce/ft-mandate-confirm`：
     - 接收结构化交易草案（动作 `buy-sweep | list-lots | cancel`、所属 `metabot_id`、`assetKey`、`symbol`、批次明细、总金额上限、预估矿工费、结算轨 `rail`）；
     - 唤起渲染进程 `FtMandateConfirmModal`（`timeoutDefault: 'deny'`）；
     - 若 `rail === 'me-escrow'` 且买方 `tradeSpendableMilli < requiredMilli`，弹窗原地进入「差额扫码补足 ME」模式，监听到账后自动放行；
     - 用户点击确认后，在主进程内存签发一次性绑定令牌 `mandateToken`（绑定 `metabotId + action + assetKey + maxSpend + expiresAt`），后续拆包/挂单/扫货多步 RPC 凭同一枚未超限 `mandateToken` 自动放行，**彻底消除拆 5 包弹 5 次框的糟糕体验**！
  2. 实现 `POST /api/idbots/wallet/mvc/ft-split`：
     - 校验 `mandateToken` 有效后，利用 `buildMvcOrderedRawTxBundle`（或顺序自转）将大额 MVC FT UTXO 按 `lotAmountsBase: string[]` 拆分为多颗精确面额的本钱包 FT UTXO 并广播，返回 `{ txids, lotOutpoints: Array<{ outpoint, amountBase }> }`。
  3. 暴露 MVC `TokenSell` 四条路由（`/api/idbots/wallet/mvc/token-sell/{list,verify,buy,cancel}`）：
     - `buy` 路由在签名前强制内部执行一次 `verifyMvcTokenSellListing` 字节级核对（种子锁收款人与价格必须与传入参数 100% 一致，防钓鱼欺诈）。
  4. 新增 `/protocols/ft-sell` 广播与本地登记辅助路由 `POST /api/idbots/commerce/ft-watch/register`。

### REQ-1-02：扩展 `SellerAutoFulfillDaemon` 支持 ME 积分买 FT 自动发货（契约 C3 + C5.2）
- **修改文件**：`src/main/services/sellerAutoFulfillDaemon.ts`、新增 `src/main/services/meFtEscrowService.ts`
- **实现要求**：
  1. SQLite 幂等建表 `ft_active_orders`（记录本地挂出的 `btc-psbt`、`mvc-tokensell`、`me-escrow` 订单及 `autoFulfillMe` 授权位）与 `me_ft_seller_fulfillments`（防崩溃重启重复打币）。
  2. 当 `privateChatDaemon` 收到 `ME_FT_ESCROW_LOCKED_V1`（或每 60 秒轮询 `GET /v1/me/ft-escrow/orders?role=seller&status=1`）时执行严格六步核验：
     - 核验本机 `ft_active_orders` 存在对应 `listingKey`、`active === true`、`autoFulfillMe === true`；
     - 用卖家 Bot 私钥亲自调 ABS `GET /v1/me/ft-escrow/orders/:orderId` 权威验资；
     - 校验 `absOrder.status === 1`、`absOrder.assetKey === localOrder.assetKey`、`absOrder.amountMilli >= localOrder.priceMeMilli`、`BigInt(absOrder.tokenAmountBase) <= BigInt(localOrder.amountBase)`；
     - 按 `orderId` + `lockedUtxoOutpoint` 加持久化幂等锁；
  3. 自动打币与领积分：
     - 若 `chain === 'mvc'`：调用 `walletTokenSendService`（或 `mvcTokenSellService.transferToken` 精确面额 UTXO）向 `absOrder.buyerReceiveAddress` 转出 `tokenAmountBase`，拿到 `txId`；
     - 若 `chain === 'btc'`：调用 `mrc20Service.executeMrc20Transfer` 向 `absOrder.buyerReceiveAddress` 转出精确数量，拿到 `revealTxId`；
     - 调用 ABS `POST /v1/me/ft-escrow/orders/:orderId/deliver` 提交 `deliveryTxId`，回传 `ME_FT_DELIVERY_DONE_V1`，触发成交通知。

### REQ-1-03：纯链上挂单成交感知守护 `TokenOrderWatcher` 与移动端 Push 联动
- **新增文件**：`src/main/services/tokenOrderWatcher.ts`
- **触发与检测逻辑**：
  - 对本地 `ft_active_orders` 中存在未完结 `btc-psbt` 或 `mvc-tokensell` 挂单的活跃会话，每 45 秒轻量轮询：
    - `btc-psbt`：查询 `api.metaid.market` 订单状态（或 `man-p2p` 对应 `utxoOutpoint` 花费状态）；
    - `mvc-tokensell`：查询 `higun` / `open-api-mvc` 对应 `tokenListTxid:vout` 是否已被花费（区分买家 `take` 成交与卖家自身 `cancel`）；
  - 一旦确认被外部买家吃单成交：
    1. 更新本地 `ft_active_orders` 批次已成交计数（如 `filledLots: 1 -> 2`）；
    2. 向桌面渲染进程广播 `ftTrade:orderFilled` 事件，在对应会话流插入或更新 `ft-fill-card`；
    3. 写入统一通知中心（`notificationStore`），在云端/Server 模式下自动经控制面 FCM 通道推送到主人手机：**「成交通知：你挂出的 200 $METAID 已售出，净入账 +0.00196 BTC（剩余 3/5 份在售）」**。

### REQ-1-04：四张仪式感对话卡片与社群裂变海报联动（契约 C4.2）
- **新增文件**：
  - `src/renderer/components/chat/ftCardSyntax.ts`
  - `src/renderer/components/chat/FtQuoteCard.tsx`
  - `src/renderer/components/chat/FtOrderCard.tsx`
  - `src/renderer/components/chat/FtFillCard.tsx`
  - `src/renderer/components/commerce/FtMandateConfirmModal.tsx`
- **关键体验细节**：
  - 对未获 CA 认证的同名代币，在卡片醒目展示 `assetKey` 摘要徽章（如 `ID: 4f92...8c1i0`）防假币混淆；
  - `FtOrderCard` 内置 **「生成社群推销海报」** 按钮，复用 `PromoAmmoPackModal` 合规能力生成带归因邀请链接的挂单分享图（严禁含违规承诺收益词），方便老持币用户一键转发微信群/电报群引流。

---

## 三、测试与验收要求

1. **必须交付的自动化测试**（记得同步添加至 `.gitignore` `!tests/...` 白名单）：
   - `tests/ftMandateGate.test.ts`：测试单次授权令牌的额度扣减、跨资产越权拦截、5 分钟过期失效、拒签默认拦截。
   - `tests/ftAutoFulfillDaemon.test.ts`：测试 MVC FT 与 BTC MRC-20 双链自动发货、ABS 金额不足拒发、崩溃恢复不双花重发。
   - `tests/tokenOrderWatcher.test.ts`：模拟 `metaid.market` 与 MVC `TokenSell` 挂单被吃 vs 自己撤单的准确识别及通知触发。
   - `tests/ftCardsRender.test.tsx`：测试三类代码块解析渲染、同名代币 ID 防伪展示及合规文案校验。
2. **门禁命令**：`tsc --noEmit && pnpm run compile:electron` 退出码 `0`，无色码测试 100% 通过，临时目录严格遵循 `disposeStore` 先关库再清理规范。
