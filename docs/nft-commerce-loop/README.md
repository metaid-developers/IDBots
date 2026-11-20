# 数字商品（Agent Goods）主流程商业闭环规划包

本目录包含 IDBots **数字商品（老 NFT 盘活兑换 → 个人小店上架 → AI 搜索发现 → 积分全自动交易 / 法币担保交易 → 冷启动分销裂变）** 的完整架构设计与多系统开发任务书。

## 文档索引

| 编号 | 文件 | 用途与读者 |
|---|---|---|
| 入口 | [`HANDOFF.md`](HANDOFF.md) | **总指挥中心入口**：核心拍板结论、红线、跨仓库分工、并行排期、一键派单 Prompt 模板 |
| 全景 | [`00-master-plan.md`](00-master-plan.md) | **主流程全盘方案**：业务背景、四大端到端闭环时序图、超越鼠标电商的 AI 原生 UI/UX 设计 |
| 契约 | [`01-protocols-and-contracts.md`](01-protocols-and-contracts.md) | **跨系统冻结契约**：CA 蓝标扩展、`/protocols/mrc721sell` v2.1、MetaSo-P2P API、ABS 积分托管 API、A2A 私聊协议 |
| WS-A | [`10-ws-a-swap-and-ca.md`](10-ws-a-swap-and-ca.md) | **旧资产自动兑换与官方蓝标验真**（`IDBots` + `SKILLs/nft-swap`） |
| WS-B | [`20-ws-b-metaso-indexer.md`](20-ws-b-metaso-indexer.md) | **数字商品聚合索引、专辑行情与全域搜索**（`metaso-p2p`） |
| WS-C | [`30-ws-c-abs-points-escrow.md`](30-ws-c-abs-points-escrow.md) | **积分（ME）服务端链上验真托管与免订阅直充**（`assist-base-service`） |
| WS-D | [`40-ws-d-idbots-trade-and-ui.md`](40-ws-d-idbots-trade-and-ui.md) | **积分自动交易引擎、卖家自动发货与 Studio/BotWorks 原生 UI**（`IDBots`） |
| WS-E | [`50-ws-e-metaapps-and-onchain-docs.md`](50-ws-e-metaapps-and-onchain-docs.md) | **个人小店 MetaApp、只读价格聚合页、分销弹药包与链上教程/技能**（`METAAPPs` + 链上内容） |
| WS-F | [`60-ws-f-fiat-escrow-phase2.md`](60-ws-f-fiat-escrow-phase2.md) | **Phase 2：法币（CNY）蓝标担保 Bot 三方交易闭环**（`IDBots` + 担保 Bot） |
| 验收 | [`70-acceptance-playbook.md`](70-acceptance-playbook.md) | **主控台验收手册**：分模块门禁、端到端实弹剧本（U1-U5 & B1-B5）、安全反欺诈检查表 |

## 核心仓库本地路径速查

- **IDBots 主客户端与内置技能**：`/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots`
- **本机已安装技能运行时副本**：`/Users/tusm/Library/Application Support/IDBots/SKILLs/{nft-swap,nft-trade}`
- **MetaSo-P2P 主索引与搜索引擎**：`/Users/tusm/Documents/MetaID_Projects/metaso-p2p`
- **ABS（MetaID Energy 积分与支付网关）**：`/Users/tusm/Documents/MetaID_Projects/assist-base-service`
- **背景共识与摸底存档（参考）**：
  - `/Users/tusm/idbots/project/bots/1/2026-11-20/共识-商业闭环与冷启动-2026-11-20.md`
  - `/Users/tusm/idbots/project/bots/1/2026-11-20/技术摸底-兑换与交易模块现状-2026-11-20.md`

## 核心术语对照

| 术语 | 含义与约束 |
|---|---|
| **数字商品（Agent Goods）** | 面向用户的统一产品名称，底层承载为链上 MRC-721 Item Pin（`collection_desc` + `item_desc` + UTXO 所有权）。UI 严禁直接向普通买家展示“NFT”生僻词。 |
| **旧版藏品（MetaContract NFT）** | MVC 链上早期的 Sensible MetaContract 智能合约 NFT（由 `codehash + genesis + tokenIndex` 标识，如 9,560 枚 `MetaBot Avatar`）。老用户冷启动回流兑换的源资产。 |
| **ME（MetaID Energy / 积分）** | ABS 维护的平台积分体系，底层精度为 `milli-ME`（`1 ME = 1000 milli-ME`）。数字商品积分交易仅允许动用买家的 `topup`（充值池）与 `earned`（经营收入池），结算后计入卖家的 `earned` 池。 |
| **官方蓝标 CA** | 锚定在 IDBots 官方根身份 MetaBot `"Bob"`（`metaid = 2379692b...`）签发的 `/protocols/idbots-nft-ca` 链上注册表。同时认证「官方认证数字商品专辑」与「官方服务 Bot（如兑换站 Bot、官方担保席 Bot）」。 |
| **个人小店（Personal Shop）** | 卖家将自己的 Bot 主页替换为橱窗式 MetaApp（店招 + 在售数字商品 + 积分/法币标价 + 在线状态 + 一键加好友/求购），是去中心化成交的主场域。 |
| **行情温度计（Read-Only Market Page）** | 按专辑聚合展示在售数、积分/法币地板价、最近成交与地板价所在小店的只读 MetaApp，**不提供撮合下单按钮**，点击商品引导进入卖家个人小店或唤起 Twin 私聊购买。 |
