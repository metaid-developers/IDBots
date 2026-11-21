# 数字货币（FT）AI 经纪人交易与实用化商业闭环规划包

本目录包含 IDBots **数字货币（BTC MRC-20 + MVC MetaContract FT）AI 私人经纪人点对点交易、ME 积分双向互通、以及数字货币与数字商品/链上内容深度结合** 的完整全景架构方案、跨系统冻结契约与分工作流开发任务书。

> **定位与关系**：本规划包是 [`docs/nft-commerce-loop/`](../nft-commerce-loop/README.md)（数字商品主流程商业闭环）的姊妹篇。两者共同构成基于区块链 AI 互联网的 **「数字商品（NFT / 内容 / 服务） × 平台积分（ME） × 链上数字货币（FT）」三元经济闭环**。

---

## 文档索引

| 编号 | 文件 | 用途与读者 |
|---|---|---|
| 入口 | [`HANDOFF.md`](HANDOFF.md) | **总指挥中心入口**：2026-11-21 核心共识与拍板裁定、架构红线、全生态仓库分工矩阵、并行拓扑排期、子 Session 派单口令 |
| 全景 | [`00-master-plan.md`](00-master-plan.md) | **主流程全盘方案**：三元经济战略、全生态代码与索引器家底摸底、五大端到端时序图、AI 经纪人四张仪式感卡片规范、长远实用化演进 |
| 契约 | [`01-protocols-and-contracts.md`](01-protocols-and-contracts.md) | **跨系统冻结契约 v1.0**：`/protocols/ft-sell`、MetaSo 代币行情与存活索引 API、ABS `ft-escrow` 托管 API、IDBots 本地 RPC 与卡片语法、`mrc721sell` v2.2 Token 定价、`/protocols/paybuzz` 加密付费阅读协议 |
| WS-1 | [`10-ws-1-idbots-host-and-ui.md`](10-ws-1-idbots-host-and-ui.md) | **IDBots 薄宿主底座、自动交割/盯单守护、四张仪式感卡片与移动端 Push 通知**（`IDBots`） |
| WS-2 | [`20-ws-2-metaso-and-abs-escrow.md`](20-ws-2-metaso-and-abs-escrow.md) | **MetaSo 代币挂单聚合索引与 ABS 积分买币链上验真托管**（`metaso-p2p` + `assist-base-service`，对接 `higun` / `man-p2p`） |
| WS-3 | [`30-ws-3-onchain-broker-skill.md`](30-ws-3-onchain-broker-skill.md) | **链上统一交易经纪人技能 `metabot-token-broker`**（三端比价、背包凑单扫货、智能拆包挂单、社群裂变弹药包） |
| WS-4 | [`40-ws-4-token-for-goods.md`](40-ws-4-token-for-goods.md) | **实用标杆 1：用指定 Token 直接购买数字商品/NFT**（MVC 同链原子互换 + 跨链验币自动发货 + 个人小店多币展示） |
| WS-5 | [`50-ws-5-paybuzz-content-unlock.md`](50-ws-5-paybuzz-content-unlock.md) | **实用标杆 2：链上加密付费阅读 `/protocols/paybuzz`**（FT 单篇微支付 + NFT 会员卡免单双轨自动发钥 + `metabot-payread` 技能） |
| WS-6 | [`60-ws-6-phase2-liquidity-and-escrow.md`](60-ws-6-phase2-liquidity-and-escrow.md) | **Phase 2 深化规划**：无前端 `MVCSwap` 池子序列器复活、`Octopus` 跨链桥异步路由、法币蓝标担保席支持 FT、持仓防女巫与 MetaTask 分币 |
| 验收 | [`70-acceptance-playbook.md`](70-acceptance-playbook.md) | **主控台验收手册**：工程门禁、链上资产防伪/防双花红线检查表、五大端到端实弹验收剧本 |

---

## 全生态关联仓库本地路径与职责地图

在推进本规划时，优先在既有专业仓库上做精准迭代或直接调用现有权威接口，**严禁重复造轮子**：

| 层次 | 仓库本地路径 | 既有核心能力 | 在本规划中的角色 |
|---|---|---|---|
| **AI 宿主端** | `/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots` | MetaBot 多链钱包、本地安全 RPC (`metaidRpcServer.ts`)、MVC `TokenSell` 合约拼装 (`mvcTokenSellCore.ts`)、MVC FT 拆包转账 (`walletRawTxService.ts`)、MRC-20 转账 (`mrc20Service.ts`)、`SellerAutoFulfillDaemon`、移动端 FCM Push | **WS-1 / WS-4 / WS-5**：薄宿主底座原语、确认闸、对话流仪式感卡片与后台确定性守护 |
| **聚合与搜索层** | `/Users/tusm/Documents/MetaID_Projects/metaso-p2p` | MetaWeb 全域搜索、`mrc721` 市场聚合、Bot 在线状态 (`presence`)、官方 CA 蓝标注册表 (`idbotsca`)、加密私聊 (`privatechat`) | **WS-2 / WS-4 / WS-5**：索引 `/protocols/ft-sell` 与 `/protocols/paybuzz`，聚合代币地板价、深度与成交统计 |
| **积分与支付层** | `/Users/tusm/Documents/MetaID_Projects/assist-base-service` | ME 积分四资金池 (`topup/earned/grant/bonus`)、`X-Bot-Address` 代签、`tb_me_nft_trade_order` 服务端托管、免订阅扫码直充 | **WS-2**：新增 `/v1/me/ft-escrow/*` 订单表与双链 FT 到账核验器，实现积分与链上代币零担保双向交割 |
| **MVC 底层索引** | `/Users/tusm/Documents/MetaID_Projects/higun` | 高性能 PebbleDB 多链 UTXO + **MVC MetaContract FT / NFT 全量索引与 0-conf Mempool 追踪**（`/ft/balance`、`/ft/utxos`、`/db/ft/utxo`、`/db/ft/income/valid`、`/ft/mempool/*`） | **权威验真源（MVC 侧）**：供 ABS、MetaSo 与宿主守护进程核验 MVC FT UTXO 存活、花费状态及转账真实到账金额 |
| **MRC-20 底层索引** | `/Users/tusm/Documents/MetaID_Projects/man-p2p` | MetaID Pin 主索引 + **完整 BTC MRC-20 验证与状态索引**（`mrc20_utxo_*`、`Available / TransferPending`、`TransferPendingIn`、Shovel/Teleport 校验） | **权威验真源（BTC 侧）**：供 ABS、MetaSo 与宿主守护进程核验 MRC-20 资产 UTXO 有效性及 `revealTxId` 真实入账输出 |
| **钱包聚合网关** | `/Users/tusm/Documents/MetaID_Projects/metalet-service` | 统一钱包网关（`wallet-api/v3` & `v4`），向上层封装 `higun`（MVC FT/NFT/UTXO）与 `man-p2p`（MRC-20/Pin）及费率广播 | 现有客户端与技能默认的读写网关；若需补聚合查询路由优先在此层或 `metaso-p2p` 暴露 |
| **链上交易技能** | `/Users/tusm/Documents/MetaID_Projects/Sunny-Skills/metabot-trade-metaidmarket-v2` | 已上链（`pin://e0de9db6127dfa14f907e295bc11fac0d04917bbea365f0abd227ec8a8b306bdi0`）的 `metaid.market` v2 技能（`X-Session` 登录、PSBT 卖方强校验、自转拆分挂单） | **WS-3 演进基座**：在此基础上升级为统一的零外部安装依赖链上技能 `metabot-token-broker` |
| **BTC 挂单市场** | `/Users/tusm/Documents/MetaID_Projects/metaid-market-service`（及 `metaid-market-frontend`） | 在线运行的 BTC MRC-20 / ID-Coin PSBT 订单簿后端（`api.metaid.market`） | **Phase 1 直接复用线上 API**：无需改动前端，由 `metabot-token-broker` 直接通过 API 完成智能拆包挂单与背包凑单扫货 |
| **MVC AMM 池** | `/Users/tusm/Documents/MetaID_Projects/mvcswap-core`（及 `mvcswap`） | MVC 链上 MetaContract FT 的 sCrypt 恒定乘积 AMM 池合约、Rabin 验签与前端接口定义（原生产后端已下线） | **WS-6（Phase 2）**：改造为无前端的轻量池子状态序列器（Headless Pool Sequencer）+ 链上技能 `metabot-mvcswap` |
| **跨链资产桥** | `/Users/tusm/Documents/MetaID_Projects/octopus-bridge` | MVC MetaContract FT ↔ BTC MRC-20 跨链桥（`api.octopus.space`，当前 `MVC→BTC` Redeem 在线，`BTC→MVC` Mint 配置为 `ENABLE_MINT=false`） | **WS-6（Phase 2）**：封装为带异步追单唤醒的链上技能 `metabot-octopus-bridge`，视安全评估按需重开双向跨链 |
| **历史移动钱包** | `/Users/tusm/Documents/MetaID_Projects/Metalet-APP` | 老社区用户过去管理 BTC / MVC / MRC-20 / FT 的移动钱包参考实现 | 冷启动存量用户迁移动线与助记词/派生路径（`m/44'/10001'/0'/0/0` 等）兼容对齐参考 |

---

## 核心术语对照

| 术语 | 含义与设计约束 |
|---|---|
| **薄宿主 + 链上经纪人技能** | IDBots 客户端不设中心化“交易所”入口，宿主仅内置确定性的钱包拆分/签名 RPC、确认闸、卡片渲染与后台守护；路由比价、拆包凑单策略封装为链上 Skill 按需安装。 |
| **智能凑单扫货（Smart Sweep）** | 针对 UTXO 订单簿（`metaid.market` PSBT 与 MVC `TokenSell`）只能“整包吃单、不可部分成交”的特性，由 Agent 在用户总预算与最高单价约束内自动求解最优订单组合并一次确认连续吃单。 |
| **智能拆包挂单（Smart Lot Split）** | 针对大额单颗 Token UTXO 难以被散户整单吃下的痛点，由 Agent 分析近期成交颗粒度，先通过自转拆分成 `N` 份标准小额 UTXO，再批量挂入链上合约或市场。 |
| **三端结算轨（Tri-Rail Settlement）** | `/protocols/ft-sell` 支持的三种点对点结算方式：① `btc-psbt`（收 BTC）、② `mvc-tokensell`（收 SPACE，纯链上 sCrypt 合约原子交割）、③ `me-escrow`（收 ME 积分，ABS 验链托管秒发）。 |
| **双轨内容解锁（Dual-Rail PayBuzz）** | `/protocols/paybuzz` 支持的链上加密内容商业模式：**FT 微支付按篇解锁**（低门槛引流尝鲜） + **持指定 MRC-721 会员卡免单解锁**（高价值可转让长期权益）。 |
