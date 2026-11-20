# WS-D 开发任务书：IDBots 积分自动交易引擎、卖家自动发货守护与 AI 原生交互 UI

- **负责范围**：`IDBots` 主客户端（交易工具链升级、卖家后台自动接单发货守护、Studio 前台协议直通、四大 AI 原生交互卡片与弹窗）
- **建议分支与工作树**：分支 `feat/agent-goods-trade-ui`，工作树 `.worktrees/agent-goods-trade-ui`（从 `main` 创建）
- **上游契约依赖**：[`01-protocols-and-contracts.md`](01-protocols-and-contracts.md) 中的 **契约 C2、C3、C4、C5.2**，以及 [`00-master-plan.md`](00-master-plan.md) 第四节 UI/UX 规范
- **与 WS-A 的文件边界切分**：
  - 请勿大改 `nftCaService.ts` 与 `SKILLs/nft-swap/**`（由 WS-A 负责）；如需读取 CA 标记，通过轻量接口适配层调用。
  - 本工作流主改：`src/main/services/mrc721SellIntentService.ts`、`src/main/services/mrc721Service.ts`、新增 `src/main/services/meNftEscrowService.ts`、新增 `src/main/services/sellerAutoFulfillDaemon.ts`、新增 `src/main/libs/goodsTradeAgentTools.ts`、`src/main/libs/mrc721AgentTools.ts`、`src/renderer/components/chat/NftCard.tsx`（及 `nftCardSyntax.ts`）、新增 `src/renderer/components/commerce/*` 交互组件。

---

## 一、核心体验目标（为什么要比鼠标电商更爽）

1. **卖家视角（躺赚闭环）**：
   - 兑换完旧资产（或铸造新作品）后，弹出一张 **「兑换完成 · 要挂上你的小店吗？」** 卡片，输入框已自动填好该专辑当前的在售中位价（如 `15 ME` / `¥9.90`），点一下「一键挂牌」，即广播 `/protocols/mrc721sell` v2.1 挂单并默认开启 **「积分锁单自动发货」**。
   - 当任何在线买家按挂牌积分价锁单并发来 `ME_ESCROW_LOCKED_V1` 时，卖家的 IDBots 后台守护 `SellerAutoFulfillDaemon` 亲自向 ABS 验资通过后，**无需卖家人工点击**，自动调 `mrc721_transfer` 发货、向 ABS 提交 `txId` 领走积分，并在通知栏/对话流推送一张喜报：「🎉 你的数字商品 `#1310` 已自动售出，到账 `+15 ME`！」
2. **买家视角（一句话发现 + 原地补能 + 秒级收货）**：
   - 在 Studio 或 BotWorks 说：“帮我看看 MetaBot Avatar 现在最便宜的是多少积分？谁在卖？”，Twin 返回带 **ME / ¥ 双价格、官方认证金标、卖家在线绿点** 的精美横向卡片组，并在 Studio 右侧自动打开行情看板或卖家小店。
   - 用户说“买这件”或直接点击卡片上的 **「⚡ 15 ME 立即买」** 胶囊：
     - 弹出 **「确认购买数字商品」** 单步面板；
     - 若 `tradeSpendableMilli`（`topup + earned`）不足，面板**不报错退出**，原地展开 **「差额扫码充 ME」** 二维码，扫码付完自动监测到账、自动锁单、自动通知卖家、数秒内链上收货！
     - 收到商品瞬间弹出 **「买入成功卡（三选一：立即戴上头像 / 一键加价挂转卖 / 去逛权益课程）」**。

---

## 二、详细需求清单（REQ-D）

### REQ-D-01：升级上架意图服务与工具至 v2.1（契约 C2 + C3）
- **修改文件**：`src/main/services/mrc721SellIntentService.ts`、`src/main/libs/mrc721AgentTools.ts`、`src/main/services/mrc721Service.ts`
- **实现要求**：
  1. 升级 `mrc721_sell_intent` 工具参数与底层广播载荷：
     - 新增直观参数：`price_me?: number`（支持小数到 `0.001` 或整数 ME，内部转为 `amountMilli`）、`price_cny_yuan?: number`（内部转为人民币 `amountCents`）、`auto_fulfill_me?: boolean`（默认 `true`）、`negotiable?: boolean`（默认 `true`）、`shop_metaapp_pin_id?: string`。
     - 自动填充 `acceptedCurrencies`（`["me"]` / `["fiat:CNY"]`）与 `settlement`（`["me-escrow"]` / `["fiat-escrow"]`），并在本地 KV 挂单簿 `mrc721_sell_intents:<metabotId>` 中记录 `autoFulfillMe` 授权状态（这是卖家本机授权后台自动发货的本地凭据！）。
  2. 新增/升级市场查询工具（在 `goodsTradeAgentTools.ts` 或 `mrc721AgentTools.ts`）：
     - `goods_market_summary`：调 MetaSo `GET /api/mrc721/market/collection/:collectionPinId/summary` 或 `/market/collections`，获取专辑在售数、积分/人民币地板价与中位价、最近成交、地板价卖家在线状态。
     - `goods_market_search`：调 MetaSo `GET /api/mrc721/market/listings`，支持按专辑、关键词、币种（`me` / `fiat:CNY`）、最高预算、仅看在线卖家（`onlineOnly`）筛选，并自动输出增强版 ```` ```nft-card-group ````。
     - `goods_holder_lookup`：调增强版 `/api/mrc721/item/info` 与 `/collection/holders`，查询任意单品（含**未上架**商品）当前在哪个 `globalMetaId` 手上、昵称叫什么、是否在线、能否私聊求购。
  3. 同步更新 `src/main/services/metawebSearchService.ts` 的 `MetawebSearchProtocol` 类型，纳入 `'mrc721-collection' | 'mrc721-listing' | 'simplequestion' | 'simpleanswer'`。

### REQ-D-02：ABS 积分托管客户端服务与买方一键购买状态机（契约 C4 + C5.2）
- **新增文件**：`src/main/services/meNftEscrowService.ts`、`src/main/libs/goodsTradeAgentTools.ts`
- **签名与身份处理**：
  - 调用 ABS `/v1/me/nft-escrow/*` 时，使用当前会话 MetaBot 的私钥签名（`signMeAction`），同时附带 `X-Bot-Address: <botMvcAddress>`（对齐契约 C4.1，使 ABS 自动扣减/入账绑定的主人 `identityAddress` 持久化资金池）。
- **新增买方核心工具 `goods_buy_with_me`**：
  - 入参：`item_pin_id`, `max_price_me`（用户允许的最高积分价，必填安全上限）, `agreed_order_quote?`（议价模式下的卖家报价单）。
  - 执行流程：
    1. 调 MetaSo `/api/mrc721/item/info?pinId=<item_pin_id>` 实时校验卖家仍持有该商品，并读取当前有效 `activeListing`（若是一口价挂单，校验 `listing.prices.me.amountMilli <= max_price_me * 1000`）。
    2. 预查 ABS `GET /v1/me/balance` 获取 `tradeSpendableMilli`。
    3. **弹出买方宿主意图确认卡（`GoodsPurchaseConfirmModal`）**：
       - 若 `tradeSpendableMilli < amountMilli`：确认卡自动处于 **「扫码补足积分并购买」** 状态（见 REQ-D-05），等待用户完成直充后自动放行；
       - 若余额充足：展示商品图、名称、卖家昵称+在线状态、支付积分额，用户点一次「确认支付」放行（`timeoutDefault: 'deny'`，绝不未授权扣积分）。
    4. 调用 ABS `POST /v1/me/nft-escrow/orders` 锁定积分；
    5. 通过宿主受控协议私聊通道（支持 Studio 与 BotWorks 双模式直发，使用当前 Twin 自身身份）向卖家 `globalMetaId` 发送契约 C5.2 的 `ME_ESCROW_LOCKED_V1` 报文；
    6. 进入短轮询等待（前 30 秒每 3 秒查一次 `GET /v1/me/nft-escrow/orders/:orderId`）：
       - 若卖家在线开启了自动发货，通常 **5~15 秒内** 订单即变为 `status = 3 (SETTLED)`！工具直接返回成交喜报、附带 `BOUGHT` 状态的 `nft-card` 并触发前端展示「买入成功三选一卡」；
       - 若卖家响应较慢（超过 30 秒仍在等待），转入客户端后台追单守护，不阻塞对话，到货即主动弹窗通知买家。
- **补充议价求购工具 `goods_send_inquiry`**：
  - 用于未上架商品求购或砍价：向目标持有人 `globalMetaId` 发送 `GOODS_INQUIRY_V1`（同样允许 Studio Twin 在用户确认报价后以自身身份发出）。

### REQ-D-03：卖家后台自动验资发货守护（`SellerAutoFulfillDaemon`）
- **新增文件**：`src/main/services/sellerAutoFulfillDaemon.ts`
- **触发时机**：
  1. 挂接在 `privateChatDaemon` 消息接收钩子上：当本地任意 MetaBot 收到包含 ```` ```idbots-trade-v1 ```` 且 `type === "ME_ESCROW_LOCKED_V1"` 的私聊消息时立即触发（优先走确定性代码快路径，**不消耗卖家 LLM Token，且延迟低至毫秒级**！）；
  2. 兜底轮询：每 60 秒对存在活跃积分挂单的本地 MetaBot 调一次 `GET /v1/me/nft-escrow/orders?role=seller&status=1` 防私聊漏信。
- **严格六步安全核验（全部通过才自动签名发货！）**：
  1. 本地挂单核验：检查本机 KV 簿 `mrc721_sell_intents:<metabotId>` 中该 `itemPinId` 确实由本机车主主动挂出、`active === true`、`autoFulfillMe === true` 且未过期（或者是卖家刚刚通过 `GOODS_QUOTE_ACCEPT_V1` 明确签发同意的议价单）；
  2. **ABS 权威验资（绝不信私聊报文里的数字！）**：亲自用卖家 Bot 私钥签名调用 ABS `GET /v1/me/nft-escrow/orders/:orderId`；
  3. 校验 `absOrder.status === 1 (FROZEN_AWAITING_DELIVERY)`；
  4. 校验 `absOrder.itemPinId === localIntent.itemPinId` 且 `absOrder.sellerBotAddress === thisBotMvcAddress`；
  5. 校验 `absOrder.amountMilli >= localIntent.prices.me.amountMilli`（实锁积分不少于卖家挂牌价！）；
  6. 幂等互斥锁：按 `orderId` 与 `itemPinId` 加内存+SQLite 锁，防止并发重复发货。
- **自动交割与广播回执**：
  1. 调用 `mrc721Service.transferMrc721({ metabotId, pinId: itemPinId, recipientAddress: absOrder.buyerNftAddress })` 广播链上过户交易，拿到 `deliveryTxId`；
  2. 立即调用 ABS `POST /v1/me/nft-escrow/orders/:orderId/deliver` 提交 `deliveryTxId`，触发 ABS 核验并将积分结算进卖家 `earned` 池；
  3. 可选广播一条 `/protocols/mrc721trade` 轻量成交回执 Pin（供 MetaSo 行情页统计最新成交价），并向买家回传 `ME_DELIVERY_DONE_V1` 私聊报文；
  4. 将本地挂单簿中该 `itemPinId` 标为 `sold`，向渲染进程广播 `goodsTrade:autoSold` 事件，在卖家界面弹出到账通知卡。

### REQ-D-04：增强 `NftCard` 数字商品卡片语法与交互胶囊（Studio & BotWorks 通用）
- **修改文件**：`src/renderer/components/chat/nftCardSyntax.ts`、`src/renderer/components/chat/NftCard.tsx`、`src/main/libs/nftCardMarkdown.ts`
- **升级要点**：
  1. **对外文案去“NFT”化**：默认徽章文案由生硬的 `NFT` 改为友好的 **「数字商品」**（已认证专辑展示金色认证盾牌 `官方认证`）。
  2. **扩展语法字段（向后兼容旧字段）**：支持 `priceMeMilli`、`priceCnyCents`、`sellerGlobalMetaId`、`sellerName`、`sellerOnline` (`true`/`false`)、`shopMetaAppPinId`、`caVerified`。
  3. **卡片视觉与快捷胶囊**：
     - 醒目展示积分价（如 `⚡ 15 ME`）与法币参考价（如 `¥9.90`），右上角展示卖家昵称与实时在线绿点；
     - 在在售商品卡片底部提供轻量交互按钮：
       - **「立即购买」**：点击直接唤起确认购买面板（或向当前会话注入精准购买动作）；
       - **「议价 / 求购」**：点击在输入框预填“帮我联系卖家把这件 `#1310` 谈到 __ ME”；
       - **「逛他小店」**：若存在 `shopMetaAppPinId` 或 `sellerGlobalMetaId`，在 Studio 右侧 Showcase（或 Bot Browser）打开卖家个人小店。

### REQ-D-05：三大核心转化 UI 组件（`src/renderer/components/commerce/`）
1. **`SwapCompleteShopPromptCard.tsx`（U3 兑换即开店引导卡）**：
   - 监听 WS-A 发出的 `nftSwap:orderCompleted` 事件（以及铸造完成场景），展示新到账的数字商品缩略图；
   - 自动请求 `goods_market_summary` 获取同专辑当前在售中位价作为默认推荐值（若全网暂无挂单，默认填入温和起步价如 `10 ME` / `¥6.60`，用户可自由修改）；
   - 主按钮 **「一键挂上我的小店」**（调 IPC 直接完成 `mrc721_sell_intent` 挂单，并在下一步提示生成个人小店与领取宣传包），次按钮「稍后再说」。
2. **`GoodsPurchaseConfirmModal.tsx`（B4 单步意图确认 + 差额原地扫码充 ME）**：
   - 继承复用 `MePurchaseFlow.tsx` / `mePayment.ts` 的二维码渲染与 4 秒轮询能力；
   - 当 `tradeSpendableMilli < requiredMilli` 时，在同一弹窗内直接展示推荐充值包（由于 WS-C 已放开免订阅直充，无需跳去买月卡！）与支付二维码；检测到 `tradeSpendableMilli >= requiredMilli` 后，自动无缝衔接执行锁单购买，全过程零中断。
3. **`PurchaseSuccessActionCard.tsx`（B5 买入成功三选一卡片）**：
   - 交易变为 `SETTLED` 瞬间渲染：
     - 按钮 1：**「立即戴为头像」**（一键设为当前用户或 Twin 的认证头像）；
     - 按钮 2：**「一键转卖挂店」**（弹出快捷标价框，默认按买入价 `+20%` 填入建议价，可自由改价）；
     - 按钮 3：**「逛逛课程与权益卡」**（在右侧 Showcase 打开精选数字课程/权益卡导览或触发 Twin 推荐）。

---

## 三、测试与验收要求

1. **单元测试（必交）**：
   - `tests/mrc721SellIntentV21.test.ts`：覆盖 ME + CNY 挂单序列化、撤单、本地 `autoFulfillMe` 状态持久化。
   - `tests/sellerAutoFulfillDaemon.test.ts`：覆盖全部 6 道安全核验（伪造私聊报文但 ABS 查无此单被拒、锁定金额低于挂牌价被拒、非本机挂单商品被拒、并发双推幂等只发一次货、正常验资自动过户并调 `/deliver` 成功）。
   - `tests/meNftEscrowClient.test.ts`：覆盖 `X-Bot-Address` 签名头生成、余额不足触发补能状态、锁单与超时处理。
   - `tests/nftCardCommerceRender.test.tsx`：覆盖双币种展示、去“NFT”化文案、快捷动作按钮渲染与旧版 `priceSats` 卡片兼容。
2. **全量门禁**：`pnpm run compile:electron`、`tsc --noEmit` 与 `NO_COLOR=1 FORCE_COLOR=0 pnpm test` 无新增红灯。
