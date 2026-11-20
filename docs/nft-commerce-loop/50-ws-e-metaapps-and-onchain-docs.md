# WS-E 开发任务书：个人小店 MetaApp、只读价格聚合页、分销弹药包与链上教程体系

- **负责范围**：个人小店 MetaApp（Bot 主页换壳模板）、只读价格聚合页 MetaApp（行情温度计）、Bot Browser 购买/议价唤起桥扩展、分销弹药包生成器、以及发布到 AI 互联网（MetaWeb）的 3 篇官方标准教程/技能文档
- **建议分支与工作树**：分支 `feat/agent-goods-shop-metaapps`，工作树 `.worktrees/agent-goods-shop-metaapps`（从 `main` 创建）
- **上游契约依赖**：[`01-protocols-and-contracts.md`](01-protocols-and-contracts.md) 全部契约 + [`共识-商业闭环与冷启动`](../../../../../../idbots/project/bots/1/2026-11-20/共识-商业闭环与冷启动-2026-11-20.md) 红线约束

---

## 一、定位与产品红线（必读）

1. **个人小店 = Bot 主页换壳（去中心化成交主场）**：
   - 我们**绝不做**类似 OpenSea 的中心化撮合大市场；每一笔交易都发生在卖家的个人小店或 Bot 私聊里。
   - 当用户的 Twin 拥有了新版数字商品后，只需对 Twin 说一句：“帮我把钱包里的数字商品做成我的个人小店发布上去”，Twin 通过 `search_metaweb` 找到本工作流发布的《个人小店标准模板与发布教程》，即可在 1 分钟内发布专属小店 MetaApp 并绑定为自己的 Bot 主页（`/info/homepage`）。
2. **只读价格聚合页 = 行情温度计（只读不撮合）**：
   - 官方提供的价格聚合页只回答三个客观读数：**某专辑有多少件在售、地板价是多少、最近成交价是多少（以及地板价在哪家小店）**。
   - 页面上**严禁放置任何直接撮合扣款按钮**；用户看中某件商品，点击「去店主小店」或「让我的 AI 去谈」，回到点对点链路成交。
3. **分销弹药包严守合规红线**：
   - 严禁在任何默认海报、标题、三段话术中出现“会涨”、“早买早赚”、“稳赚”、“翻倍”等投资收益暗示；聚焦于“老藏品免费升级盘活”、“我的 AI 24 小时自动看店接单”、“链上真品确权可穿戴可流转”。

---

## 二、详细需求清单（REQ-E）

### REQ-E-01：扩展 `botBrowserBridgeService` 支持小店与 AI 助手无缝联动
- **修改文件**：
  - `src/main/services/botBrowserBridgeService.ts`
  - `src/renderer/features/botBrowser/idbotsBrowserHostAdapter.ts`
  - `SKILLs/metabot-metaapp/references/agent-browser-metaapp.md`
- **新增受控 Bridge 方法（零私钥泄露，全部经宿主 UI 确认）**：
  1. `browser.commerce.askTwinToBuy({ itemPinId, collectionName, itemName, sellerGlobalMetaId, priceMeMilli?, priceCnyCents? })`：
     - 当买家在逛别人的「个人小店 MetaApp」点击某件商品的「用积分购买」或「找店主议价」时，宿主将该购买意图带入当前买家 Twin 会话（或直接唤起 WS-D 的 `GoodsPurchaseConfirmModal`），**用户无需手动复制复杂的 `64hex` PinID 去聊天框粘贴**！
  2. `browser.social.addFriendPrompt({ targetGlobalMetaId, targetName })`：
     - 小店顶部的「+ 加店主 AI 为好友」按钮调用，弹出宿主确认条一键关注/加好友并可留言。
  3. `browser.commerce.openPromoPack({ shopMetaAppPinId, featuredItemPinId? })`：
     - 仅当访问者 `actor.globalMetaId === shopOwnerGlobalMetaId`（店主本人看自己小店）时展示「🎁 领分销弹药包」入口，唤起分享海报与话术面板。

### REQ-E-02：个人小店标准模板 MetaApp（`METAAPPs/personal-goods-shop/`）
- **目录位置**：`METAAPPs/personal-goods-shop/`（纯静态单页自包含 HTML/CSS/JS 架构，零外部构建依赖，确保任何用户的 Twin Bot 都能直接读取模板、替换 `shop-config.json` 并一键打包 `bot_browser_publish_app` 发布上链！）。
- **核心界面模块**：
  1. **店招头部（Shop Header）**：
     - 店主头像（支持官方认证头像框展示）、店主昵称、实时在线状态绿点（调 MetaSo `/api/presence/globalmetaid/:id`）、**自定义一句话店招**（如“老藏家清仓小铺 · 积分拍下 24 小时自动秒发”）、右侧「+ 加好友 / 留言」按钮。
  2. **双栏 Tab 切换**：
     - **Tab 1「在售橱窗（Active Listings）」**：调 MetaSo `GET /api/mrc721/market/listings?seller=<ownerGlobalMetaId>`，网格展示每件在售数字商品的高清图、官方认证专辑金标、名称编号、**积分价（`⚡ X ME`）** 与 **人民币价（`¥ X.XX`）**、「自动秒发」闪电角标；点击商品打开详情抽屉并提供「用积分购买」/「找店主议价」按钮（调用 `browser.commerce.askTwinToBuy`；若在外部普通浏览器打开无 `AgentBrowser`，则优雅降级展示“下载 IDBots 加店主 `idq1...` 一句话购买”引导卡！——确保发到微信群被外部浏览器点开也能种草转化！）。
     - **Tab 2「全部藏品柜（All Holdings）」**：调 MetaSo `GET /api/mrc721/address/item?globalMetaId=<ownerGlobalMetaId>`，展示店主尚未标价的珍藏品，附带「私聊求购」按钮（唤起议价求购）。
  3. **店主专属管理条**：当检测到当前登录 `actor.globalMetaId === shopOwnerGlobalMetaId` 时，顶部浮现「一键领分销弹药包」与「让 AI 帮我改店招/调价」快捷入口。

### REQ-E-03：只读价格聚合页 MetaApp（`METAAPPs/goods-market-thermometer/`）
- **目录位置**：`METAAPPs/goods-market-thermometer/`
- **严格设计约束**：**100% 只读行情读数页，不放任何直接撮合买单按钮**。
- **核心界面模块**：
  1. **认证专辑总览看板**：调 `GET /api/mrc721/market/collections?caOnly=true`，展示专辑封面、官方认证标、已铸造/总供应量、持有人数、**当前在售数**、**积分地板价（ME）**、**法币地板价（¥）**、**24h 成交笔数**。
  2. **专辑深度读数抽屉**：点击任一专辑（如 `MetaBot Avatar`），展示：
     - **在售挂单价格分布列表**（按价格升序，展示商品编号、标价、所属小店昵称与在线绿点，右侧链接为 **「去逛他的小店 →」**，跳转卖家的个人小店主页 `metaid://` 或 `metaapp://`）；
     - **最近真实成交流水**（调 `/api/mrc721/market/trades`）；
     - **藏家持仓榜**（调 `/api/mrc721/collection/holders`，谁手里最多、是否在线一目了然）。

### REQ-E-04：分销弹药包（邀请归因海报 + 合规三段话术组件）
- **新增组件/工具**：`src/renderer/components/commerce/PromoAmmoPackModal.tsx`（或在个人小店模板内嵌 Canvas 海报导出 + 客户端弹窗双入口）
- **交付内容**：
  1. **一键生成邀请种草卡（PNG 可保存/复制）**：
     - 展示店主精选的 1~3 件数字商品封面、一句话店招、店主昵称；
     - 底部二维码指向携带邀请归因参数的落地链接（如 `https://idbots.ai/invite?inviter=<globalMetaId>&shop=<shopPinId>`），并在客户端首次注册/登录流程记录 `inviterGlobalMetaId`（若新用户通过邀请码进入，引导自动添加邀请人 Bot 为好友，对齐冷启动方案 B2）。
  2. **三段式一键复制话术（严守无升值承诺红线）**：
     - **场景 1（发老币圈/老 NFT 群）**：突出“以前老钱包吃灰的 MetaBot Avatar 现在能免费 1:1 升级成 AI 互联网数字商品了，不用懂技术，跟自己的 AI 说句话就能开个 24 小时自动接单的小店换成积分或零花钱，我的小店刚开张：[链接]”。
     - **场景 2（发朋友圈/普通群）**：突出“给我的 AI 分身开了家数字商品小店，我睡觉的时候它自己帮我迎客、议价、发货，来逛逛我的橱窗：[链接]”。
     - **场景 3（答买家怎么买）**：突出“装好 IDBots 不用自己找按钮，直接跟你的 AI 说『去 @某某 的小店帮我买那件 #编号』，两个 AI 几秒钟就自己交割完了”。

### REQ-E-05：编写并准备上链发布的 3 份 AI 互联网标准教程/技能文档
在 `docs/nft-commerce-loop/onchain-publish-payloads/` 目录下产出可直接通过 `metabot-simplenote` / `metabot-post-skillservice` 发布上链的标准 Markdown 载荷（附带一键上链发布脚本 `scripts/publish-commerce-tutorials.mjs`，等主控台在 M2/M3 阶段授权执行上链）：
1. **`01-legacy-nft-swap-guide.md`（《IDBots 官方旧版藏品免费升级兑换指南 — Agent 可执行版》）**：
   - 包含高频检索关键词（`MetaContract`、`兑换`、`升级`、`老 NFT`、`MetaBot Avatar`、`swap`），使任何用户的 Twin 调 `search_metaweb` 必排第一命中；
   - 明确写出各支持专辑的 `(codehash, genesis)`、官方兑换站 `globalMetaId`、金库地址，并**强制指示 Agent 必须先调宿主内置 `nft_swap_verify_official_station` 核验官方蓝标 CA 通过后，再调 `nft_swap_submit_batch` 执行兑换**。
2. **`02-build-personal-shop-guide.md`（《如何为你的主人一键发布个人数字商品小店 MetaApp》）**：
   - 面向所有用户的 Twin Bot：一步步教 Agent 如何拉取主人钱包里的 MRC-721 藏品、询问主人一句话店招、复制标准小店模板源码Pin（标注模板 `pin://...` 占位符，上链时自动回填）、调用 `bot_browser_publish_app` 发布并设为 Bot 主页，以及如何调用 `mrc721_sell_intent` 挂出积分/人民币价格。
3. **`03-agent-goods-buy-and-trade-guide.md`（《AI 互联网数字商品寻源、议价与积分/担保交易全指南》）**：
   - 教买方与卖方 Twin 如何使用 `goods_market_summary`、`goods_market_search`、`goods_holder_lookup`、`goods_buy_with_me`、`goods_send_inquiry` 完成查地板价、找未上架藏品持有人、自动锁积分交割与法币担保交易。

---

## 三、测试与验收要求

1. **离线与沙箱可运行验证**：
   - `METAAPPs/personal-goods-shop/index.html` 与 `METAAPPs/goods-market-thermometer/index.html` 在注入 Mock MetaSo API 数据时，可在无外网构建工具条件下直接渲染出完整的店主橱窗、双币种标价、在线绿点、无 `AgentBrowser` 外部浏览器降级种草页以及只读行情看板。
2. **合规文案扫描测试**：编写单测扫描 `PromoAmmoPackModal` 与 `onchain-publish-payloads/*.md`，确保**零出现**禁用词（`会涨`、`暴涨`、`早买早赚`、`稳赚`、`翻倍`、`保本`），且行情页 DOM 中无撮合购买扣款入口。
3. **Bridge 安全测试**：验证 `browser.commerce.askTwinToBuy` 仅拉起宿主确认流，恶意第三方 MetaApp 无法绕过用户点击静默扣减积分或发送私聊。
