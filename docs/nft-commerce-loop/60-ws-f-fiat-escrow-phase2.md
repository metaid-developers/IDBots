# WS-F 开发任务书（Phase 2）：法币（CNY）蓝标担保 Bot 三方交易闭环

- **启动时机**：Phase 1（积分全自动主闭环 M3）验收跑通后立即启动
- **负责范围**：`IDBots` 跨机 A2A 担保协同协议、官方蓝标担保席 Bot 自动托管守护、买方 Studio 收款码扫码与卖方到账确认放行全链路
- **建议分支与工作树**：分支 `feat/fiat-escrow-a2a-closure`，工作树 `.worktrees/fiat-escrow-a2a-closure`（从当时最新 `main` 创建）
- **现有代码基础**：
  - `src/main/libs/escrowOrderStateMachine.ts` 与 `src/main/libs/escrowAgentTools.ts`（已实现纯状态机与本机 `EscrowOrderStore`、`escrow-card` 渲染）；
  - `src/renderer/components/chat/PaymentCard.tsx` 与 `src/renderer/components/settings/PendingPaymentRecordsPanel.tsx`（已修复桌面端 `alipays://` 拉起白名单与本机收款待核验面板，详见 `docs/s3-fiat-closure-report.md`）；
  - WS-A 已交付的 `officialBotVerifyService.verifyOfficialEscrowGuarantor`（契约 C1 `role === "escrow_guarantor"` 蓝标验真）。

---

## 一、核心原则与合规红线

1. **零资金池触碰（Goods-Only Custody）**：
   - 担保 Bot **只托管链上数字商品（MRC-721 Item）**，**绝不代收、经手、沉淀任何人民币法币资金**！
   - 法币由买方人类通过手机扫码（卖家自己的个人收款码）点对点直接付进卖方个人账户；担保 Bot 仅凭链上商品入库事实与卖方本人的加密签名放行指令（或仲裁决议）移交数字商品。
2. **双在线前置检查**：
   - 法币交易要求买方与卖方（或卖方在线收款通知端）均在线，买方 Twin 在发起法币担保前先调 MetaSo `/api/presence/batch` 确认卖家与选定的官方蓝标担保 Bot 均在线，体验顺畅不卡单。
3. **人类极简感知**：
   - **买方人类视角**：在 Studio 说“我想用人民币买这件” → 双边 Bot 后台谈妥价格并拉好蓝标担保 Bot、确认卖家已把商品锁进担保仓后 → Studio 才弹出卖家的 **`pay-card` 收款二维码（带金额与唯一订单备注码）** → 买方掏手机扫码支付并点一下「我已付款」，坐等几秒商品自动入账！**商品未锁进担保仓前，绝不向买方展示付款二维码！**
   - **卖方人类视角**：收到「买家求购 `#1310` 出价 `¥29.00`，官方蓝标担保席已就位」确认卡 → 点一次「确认托管商品并发收款码」（Twin 自动将商品转入担保仓并把预设收款码发给买方 Bot） → 手机收到支付宝/微信到账提醒后，在 Studio 提醒卡点一次 **「确认已收到 ¥29.00，通知担保人放货」** → 全流程结束！

---

## 二、A2A 三方担保报文契约（C5.3 冻结规范）

所有报文通过 `/protocols/simplemsg` 加密私聊在 `买方 Bot (B)`、`卖方 Bot (S)`、`蓝标担保 Bot (G)` 三方之间点对点同步（每步状态变更由 `G` 同时抄送 `B` 和 `S`，双方本地 `EscrowOrderStore` 实时镜像更新并渲染 `escrow-card`）：

| 步骤 | 报文 `type` | 方向 | 触发条件与核心载荷 |
|---|---|---|---|
| 1 | `FIAT_ESCROW_INVITE_V1` | `B -> G` (抄送 `S`) | 双边谈妥人民币分值 `amountCents`；载荷含 `itemPinId`, `amountCents`, `buyerGlobalMetaId`, `buyerNftAddress`, `sellerGlobalMetaId`, `sellerNftAddress` |
| 2 | `FIAT_ESCROW_OPENED_V1` | `G -> S, B` | `G` 校验自身非买卖任一方、金额未超限、商品确在 `S` 名下，生成 `escrowOrderId`、托管地址 `custodyAddress` 与 `T1`（卖方入仓倒计时 15m） |
| 3 | `FIAT_ESCROW_CUSTODIED_V1` | `S -> G` → `G -> B, S` | **宿主硬校验 `G` 为官方蓝标 `escrow_guarantor`** 后，`S` 调 `mrc721_transfer` 将商品转入 `custodyAddress` 并提交 `custodyTxId`；`G` 链上验真到货后签发 `ITEM_ESCROWED` 凭证 |
| 4 | `FIAT_PAY_QR_V1` | `S -> B` (抄送 `G`) | 仅在收到 `G` 的 `ITEM_ESCROWED` 签章后，`S` 将卖家配置的收款码链接（`https://qr.alipay.com/...`）+ `amountCents` + 备注码 `memoCode` 发给 `B`；`B` 在聊天流渲染 `pay-card` |
| 5 | `FIAT_PAID_NOTICE_V1` | `B -> S, G` | 买方扫码后点击「我已支付」（可选附付款回执尾号/截图 metafile），状态进入 `PAID_EVIDENCE_UPLOADED`，冻结买方超时撤单权，启动 `T3` 卖方核实倒计时 |
| 6 | `FIAT_SELLER_CONFIRM_V1` | `S -> G` | **必须经卖方人类在宿主确认卡点击「我已核实收款到账」**，由宿主用 `S` 私钥对 `"escrow-release:<escrowOrderId>:<buyerNftAddress>"` 生成不可伪造签名发给 `G` |
| 7 | `FIAT_ESCROW_RELEASED_V1` | `G -> B, S` | `G` 验签通过，立即调 `mrc721_transfer` 将商品转给 `buyerNftAddress`，广播 `/protocols/mrc721trade`（`currency: "fiat:CNY"`）并通知双边完结 |

---

## 三、详细需求清单（REQ-F）

### REQ-F-01：跨设备 `EscrowSyncService`（打通本机 `escrowOrderStateMachine` 与异地私聊）
- **新增文件**：`src/main/services/escrowA2ASyncService.ts`
- 将原本仅限单机本地演示的 `escrow_*` 状态机（`src/main/libs/escrowOrderStateMachine.ts`）与 `privateChatDaemon` 打通：买方机器、卖方机器、担保 Bot 机器各自在本地 `escrow_orders` 表维护同一 `escrowOrderId` 的状态投影，所有转换附带对端签名与链上 `txId` 证据。

### REQ-F-02：卖方收款码安全转发与买方 `pay-card` 免二次拦截渲染
- 卖方在 `PaymentReceivingSettings.tsx` 预存自己的收款码 URL；
- 当买方 Bot 收到来自对端卖方 Bot 的 `FIAT_PAY_QR_V1` 时，宿主校验：① 该 `escrowOrderId` 确实处于经官方蓝标担保 Bot 验真签章的 `ITEM_ESCROWED` 状态；② 收款码 URL 严格通过 `isAllowedPaymentLaunchUrl` / `qr.alipay.com` 白名单校验；通过后自动在买方 Studio / BotWorks 会话渲染标准 `pay-card` 卡片（无需买方自己的 Bot 触发 `confirmPaymentCardEmit` 误拦）。

### REQ-F-03：官方蓝标担保席 Bot 自动值守服务（`GuarantorBotDaemon`）
- 为运行官方担保席身份的 MetaBot 提供零人工干预的确定性守护模式：
  - **入仓验真**：收到 `custodyTxId` 后调 MetaSo `/api/mrc721/item/info` + `/item/verify` 确认 `ownerAddress === custodyAddress && creatorMinted === true` 后才签发 `ITEM_ESCROWED`（严禁未到货先让买家付钱！）；
  - **正常放货**：验证 `FIAT_SELLER_CONFIRM_V1` 的卖家 `sellerNftAddress` ECDSA 签名合法后，自动将商品转给 `buyerNftAddress`；
  - **超时未付自动退回卖家**：若在 `ITEM_ESCROWED` 状态下买方超过 `T2`（默认 20 分钟）未提交 `FIAT_PAID_NOTICE_V1`，担保 Bot 自动将数字商品原路 `mrc721_transfer` 退回 `sellerNftAddress` 并关闭订单；
  - **已声明付款争议保护**：一旦买方已发出 `FIAT_PAID_NOTICE_V1`，**严禁自动把商品退回卖家**，超时未确认自动转入 `DISPUTED` 人工仲裁队列冻结保管，保护已付款买方权益。

---

## 四、测试与验收要求

1. **三方状态机与签名伪造单测**：
   - 验证非官方蓝标 `globalMetaId` 冒充担保人时，卖家宿主硬拒绝转出商品；
   - 验证担保仓未确认收到商品前，买方界面绝不渲染 `pay-card`；
   - 验证买方伪造 `FIAT_SELLER_CONFIRM_V1` 签名时，担保 Bot 拒绝放货；
   - 验证 `T2` 未付款自动原路退货 vs 已点付款后进入争议保护不误退货。
2. **三 Bot 实弹演练**：对照 `docs/s3-fiat-closure-report.md` 第 3 节清单，使用 `¥1.00` 真实测试单跑通从拉群/私聊建单到商品入仓、扫码确认、担保放货到账全流程。
