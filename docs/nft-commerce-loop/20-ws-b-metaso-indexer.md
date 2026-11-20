# WS-B 开发任务书：MetaSo-P2P 数字商品上架聚合索引与全域检索

- **目标仓库**：`/Users/tusm/Documents/MetaID_Projects/metaso-p2p`
- **建议分支**：`feat/mrc721-market-aggregation`（基于 `metaso-p2p` 主干创建）
- **上游契约依赖**：[`01-protocols-and-contracts.md`](01-protocols-and-contracts.md) 中的 **契约 C1、C2、C3**

---

## 一、背景与改造目标

`metaso-p2p` 目前已是全网唯一的 MRC-721 权威索引器（`internal/aggregator/mrc721nft` 与 `internal/aggregator/mrc721`），但距离支撑数字商品商业闭环还有 6 个关键能力缺口：
1. `/protocols/mrc721sell` 目前只解析 `priceHintSats`，不索引 **积分（ME）** 与 **法币（CNY）** 结构化定价；
2. 商品在链上发生 UTXO 转移后，旧卖家的挂单仍在列表中显示为 `active: true`（脏挂单）；
3. 缺少以 **专辑（`collectionPinId`）** 为维度的实时聚合指标（积分地板价、法币地板价、在售中位价、在售件数、唯一持有人数、最近成交统计）；
4. `/api/mrc721/address/item` 仅接受链地址，不支持直接按 `globalMetaId` 查询；`item/info` 未附带当前持有人的昵称/在线状态与当前挂单；
5. `/protocols/idbots-nft-ca` 尚未在后端索引，专辑与官方 Bot 的蓝标认证无法在列表接口服务端过滤或直出；
6. `GET /api/metaweb/search` 尚未纳入数字商品专辑与在售商品文档源，导致 Agent 调 `search_metaweb` 搜不到在售商品。

---

## 二、详细需求清单（REQ-B）

### REQ-B-01：配置默认值与启动自检加固
- **文件**：`internal/config/config.go`
- 核查 `METASO_P2P_MRC721_NFT_ENABLED`：将线上/标准节点配置及示例配置明确开启，并确保 `mrc721` 市场聚合器与 `mrc721nft` UTXO 所有权存储实现内存/存储层直接读取联动（注入只读 `OwnershipReader` 接口）。

### REQ-B-02：官方蓝标 CA 索引器（`internal/aggregator/idbotsca`）
- **监听路径**：`/protocols/idbots-nft-ca`（支持 `create` 与 `modify` 操作，仅接受创世/修改者 `metaid == "2379692b225136b2b54e83aac52174f622b80181b17254bb7b5cf7b0aa323212"` 或对应官方 `globalMetaId = "idq1w8ye5psdkqrn6ugxxwvf5p4kkeuzufa6n9tt47"` 的 Pin，其余创建者一律静默丢弃！启动时若本地为空，支持从 MANAPI 按路径或默认创世 Pin `77da77280b9b218cf1edd62f658ca2be561dd7e377f3980182e280487ec38c56i0` 回填）。
- **内存快照查询接口**：
  - `IsCollectionCertified(collectionPinId string) (bool, *CollectionCertEntry)`
  - `GetOfficialBotBadge(globalMetaId string) *OfficialBadgeDTO`
- **暴露 HTTP 路由**：`GET /api/mrc721/ca/registry`（严格对齐契约 C3.1）。
- **全量投影**：
  - 在 `userinfo`、`botsearch`（`POST /api/bots/search`，新增可选过滤 `officialRole`）、`bothomepage`（`GET /api/bot-homepage/:globalMetaId`）输出中注入 `officialBadge`。

### REQ-B-03：升级 `/protocols/mrc721sell` v2.1 索引与 UTXO 转手自动失效
- **文件**：`internal/aggregator/mrc721/`
- **Schema 升级**：
  - 扩展 `SellIntentRecord` 解析并持久化契约 C2.2 新增字段：`Prices.Me.AmountMilli (*int64)`、`Prices.Fiat.Currency (string)`、`Prices.Fiat.AmountCents (*int64)`、`AutoFulfillMe (bool)`、`Negotiable (bool)`、`ShopMetaAppPinId (string)`，同时完全保留 `PriceHintSats`、`AcceptedCurrencies`、`Settlement`、`Note`、`ExpiresAt` 向后兼容。
- **所有权与有效期实时校验（消除脏单核心逻辑）**：
  1. **写时绑定**：收到 `active: true` 的 `/protocols/mrc721sell` Pin 时，记录索引时刻该 `itemPinId` 的 `outpoint`（若 payload 未带则查 `mrc721nft` 当前 outpoint）及 `sellerAddress`。
  2. **转手自动失效钩子**：在 `mrc721nft` 处理链上转移（含 0-conf overlay 转移与区块确认转移）或销毁时，触发回调 `OnItemTransferred(itemPinId, fromAddr, toAddr, newOutpoint)` —— 若该 `itemPinId` 当前挂单处于 `active: true` 且 `toAddr != intent.SellerAddress`，立即将该挂单状态置为 `active = false, inactiveReason = "transferred"`！
  3. **读时双保险过滤**：所有在售查询（`active=true`）均二次核验：① `mrc721nft` 中该商品未销毁且 `currentOwnerAddress == intent.SellerAddress`；② 若设置了 `expiresAt > 0`，要求 `expiresAt > nowSec`。

### REQ-B-04：专辑级聚合指标计算与行情接口（契约 C3.2）
- **新增接口**：
  1. `GET /api/mrc721/market/collections`
  2. `GET /api/mrc721/market/collection/:collectionPinId/summary`
- **聚合指标算法（按 `collectionPinId` 维护轻量内存聚合缓存，挂单变更/过户时增量或按专辑局部重算）**：
  - `holderCount`：遍历该专辑未销毁 Item 的非空 `ownerAddress` 去重计数；
  - `listedCount`：该专辑当前有效在售（`effectiveActive == true`）的商品总数；
  - `floorPriceMeMilli` / `medianPriceMeMilli`：收集该专辑所有有效在售且 `prices.me.amountMilli > 0` 的价格升序数组 `P_me`，取最小值作为地板价，取中位数（偶数长度取中间两数均值并向下取整到 `100` milli-ME）作为 `medianPriceMeMilli`（供客户端 U3“兑换即开店”默认建议价直接使用）；
  - `floorPriceCnyCents` / `medianPriceCnyCents`：同理对 `prices.fiat.amountCents > 0` 计算人民币地板价与中位价；
  - `floorSeller`：地板价商品对应的卖家 `userinfo` 摘要 + 实时 `presence` 在线状态（调用内部全局在线管理器 `IsGlobalMetaIdOnline`）。
- **同步增强旧接口**：在 `/api/mrc721/collection/pageList`、`/collection/info`、`/collection/search` 的 `CollectionDTO` 中一并附带上述 `caVerified`, `holderCount`, `listedCount`, `floorPriceMeMilli`, `floorPriceCnyCents`, `medianPriceMeMilli`, `medianPriceCnyCents` 字段（保持原有 `code: 1` 信封不变）。

### REQ-B-05：多维商品挂单检索接口（契约 C3.3）
- **新增路由**：`GET /api/mrc721/market/listings`
- 支持过滤参数：`collectionPinId`、`seller`（自动识别 `1...` 地址或 `idq1...` `globalMetaId`）、`currency`（`me` / `fiat:CNY` / `any`）、`minPrice`、`maxPrice`、`onlineOnly`、`caOnly`、`keyword`（匹配商品标题、编号如 `1310` 或 `#1310`、卖家昵称、挂单备注）。
- 支持排序：`price_me_asc`、`price_me_desc`、`price_cny_asc`、`price_cny_desc`、`newest`。
- 每条返回自动拼装 `ItemDTO`（封面、名称、metadata）+ `seller`（昵称、头像、`hasChatPubkey`、实时 `isOnline`、`lastSeenAgoSeconds`）+ `caVerified`。

### REQ-B-06：持有人寻址与未上架藏品透视（契约 C3.4）
1. `/api/mrc721/address/item` 与 `/api/mrc721/address/collection` 支持 `?globalMetaId=idq1...` 参数（内部查 `userinfo` 获取对应的 MVC 地址，若未传 `address` 则用解析出的地址查询）。
2. 新增 `GET /api/mrc721/collection/holders?pinId=<collectionPinId>&cursor=&size=`：返回该专辑持有人排行列表及每人持仓数、在售数、昵称与在线状态。
3. 增强 `GET /api/mrc721/item/info?pinId=<itemPinId>`：附加 `ownerProfile`（昵称、头像、`globalMetaId`、`isOnline`、`hasChatPubkey`）与 `activeListing`（当前有效挂单详情或 `null`）。
4. 新增批量在线状态兼容路由 `POST /api/presence/batch`（请求 `{ globalMetaIds: [...] }`，最多 100 个，返回 `{ map: { "idq1...": { online: true, lastSeenAgoSeconds: 5 } } }`），方便客户端卡片列表一次拉取全部卖家在线绿点。

### REQ-B-07：成交记录索引（契约 C3.5）
- 索引路径 `/protocols/mrc721trade`（成交回执 Pin）以及 `/protocols/mrc721offer` 链上交割；
- 当某笔链上 MRC-721 转移 `txId` 发生时：
  - 若匹配 `/protocols/mrc721trade` 回执（且回执中的 `txId` 在 `mrc721nft` 转移记录中核验属实，发送方与接收方吻合），记录真实成交币种与金额（`me` / `fiat:CNY`）；
  - 若匹配有效 `OfferRecord`，记录 `space` 成交金额；
- 暴露 `GET /api/mrc721/market/trades` 并更新专辑的 `tradeStats`（总成交笔数、24h 成交笔数、最近一笔成交价与时间）。

### REQ-B-08：接入 `metaweb_search` 全域搜索引擎（契约 C3.6）
- **文件**：`internal/metawebdoc/document.go`、`internal/aggregator/metaweb/search_index.go`、`internal/aggregator/mrc721/`
- 实现 `metaweb.DocumentSource` 接口，导出两类可检索文档：
  1. `protocol = "mrc721-collection"`（标题：`collectionName + displayTitle`，摘要含描述与当前在售数/地板价）；
  2. `protocol = "mrc721-listing"`（仅导出当前 `effectiveActive == true` 的在售商品；商品下架或转手后在下一次快照刷新时自动从搜索结果移除）。

---

## 三、测试与验收要求

1. **Go 单元测试（必交）**：
   - `mrc721sell` v2.1 解析测试（含仅 ME、仅 CNY、双币种、旧版仅 `priceHintSats` 四种载荷）；
   - UTXO 转手自动失效测试（模拟卖家挂单 → 链上将该 Item 转给买家 → 断言 `/market/listings` 立即不再返回该单，且专辑 `listedCount` 减 1）；
   - 地板价与中位价计算单测（含 0 件、1 件、奇数件、偶数件、过期挂单排除）；
   - CA 注册表创建者伪造拒绝单测（非 Bob `metaid` 写入 `/protocols/idbots-nft-ca` 必须被丢弃）；
   - `metaweb_search` 搜专辑名与在售编号命中测试。
2. **编译与全量回归**：`go build ./...` 退出码 0，`go test ./...` 通过并附上输出摘要。
