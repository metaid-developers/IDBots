# WS-2 开发任务书：MetaSo 代币挂单聚合索引与 ABS 积分买币托管

- **目标仓库**：
  1. `/Users/tusm/Documents/MetaID_Projects/metaso-p2p`（建议分支：`feat/ft-sell-market-aggregator`）
  2. `/Users/tusm/Documents/MetaID_Projects/assist-base-service`（建议分支：`feat/me-ft-escrow`）
- **直接复用的权威底层索引源（只读调用，不重复造轮子）**：
  - MVC FT 权威源：`/Users/tusm/Documents/MetaID_Projects/higun`（线上 `open-api-mvc` / 内网 `higun` HTTP 接口）
  - BTC MRC-20 权威源：`/Users/tusm/Documents/MetaID_Projects/man-p2p` 及 `/Users/tusm/Documents/MetaID_Projects/metalet-service`
- **上游契约依赖**：[`01-protocols-and-contracts.md`](01-protocols-and-contracts.md) 中的 **契约 C1、C2、C3**

---

## 一、Part A：`metaso-p2p` 代币挂单聚合与检索需求（REQ-2A）

### REQ-2A-01：新增 `ftmarket` 聚合器索引 `/protocols/ft-sell` 与 `/protocols/ft-trade`
- **目录位置**：`internal/aggregator/ftmarket/`
- **核心逻辑**：
  1. 监听并解析 `/protocols/ft-sell`（契约 C1）：
     - 校验必填字段与互斥规则（同一 `utxoOutpoint` 不得同时声明锁仓型 `mvcTokenSell` 与钱包直转型 `me`）；
     - 以 `listingKey` 为键存入 PebbleDB，同时维护按 `assetKey`、按 `symbol`（大写归一化）、按 `sellerAddress` 的二级索引。
  2. **UTXO 存活联动自动失效（防脏单核心）**：
     - 写入时与后台周期性巡检（对活跃挂单批量核查）+ 读时缓存核验：
       - 若 `asset.chain == "mvc"`：向 `higun` 查询 `lot.utxoOutpoint` 是否仍未花费（对 `mvc-tokensell` 额外核验合约输出存在且未 spend）；
       - 若 `asset.chain == "btc"`：向 `man-p2p`（或本地 BTC 索引/上游 MAN API）查询该 MRC-20 `utxoOutpoint` 是否仍处于 `Available`（若已变为 spent 或挂单已撤，立即置 `effectiveActive = false`）。
  3. **官方/知名代币标识投影**：扩展 `idbotsca` 读取可选 `certifiedTokens` 清单（或内置主流创世资产映射如 `$METAID`），为正牌资产标记 `caVerified: true`，帮助买方识别同名李鬼币。

### REQ-2A-02：暴露三端行情聚合与挂单查询 API（契约 C2）
- 实现以下路由并统一返回 `{ code: 0, message: "success", data: ... }`：
  1. `GET /api/ft/market/tokens`
  2. `GET /api/ft/market/token/:assetKey/summary`：
     - 实时计算该代币在 `mvc-tokensell`（SPACE 单价）与 `me-escrow`（ME 单价）的地板价，可选缓存拉取 `api.metaid.market` 对应 `mrc20Id` 的 BTC 地板价快照做一站式汇总；
     - 统计最近 50 笔有效挂单/成交的 `lot.amountDisplay` 分位数（`p25 / median / p75`），输出 `recentGranularity` 供经纪人技能智能拆包决策。
  3. `GET /api/ft/market/listings`：支持按 `assetKey`、`symbol`（若同名命中多个不同 `assetKey`，返回 `ambiguousAssets` 列表提醒技能消歧）、`rail`、`seller`（支持地址或 `idq1...`）、`onlineOnly`（联动全局 `presence` 管理器）过滤与单价升序排序。
  4. `GET /api/ft/market/trades`
- **接入 `search_metaweb`**：实现 `metaweb.DocumentSource`，导出 `"ft-token"` 与有效在售的 `"ft-listing"`。

---

## 二、Part B：`assist-base-service`（ABS）积分买币托管需求（REQ-2B）

### REQ-2B-01：数据表 `tb_me_ft_trade_order` 与资金池安全护栏（契约 C3.1）
- **新增文件**：`models/me_ft_trade_order_model.go`、`service/me_service/ft_escrow_service.go`、`controller/me_ft_escrow_controller.go`
- **硬性安全不变量**：
  1. 100% 复用 `DeductionModeTradePaidOnly`（仅扣买方 `topup -> earned`，`grant = 0, bonus = 0`）；
  2. 100% 复用 `X-Bot-Address` 绑定代签与 `ResolvePayeeIdentityAddress`（积分入卖家主账户 `earned` 池）；
  3. 禁止自买自卖（买方与卖方解析出的主账户 `identityAddress` 相同时返回 `SELF_TRADE_FORBIDDEN`）；
  4. 同一 `locked_utxo_outpoint` 在订单处于 `FROZEN_AWAITING_DELIVERY (1)` 或 `DELIVERY_SUBMITTED (2)` 期间加唯一排他校验，防止两个买家同时锁同一包库存；
  5. `delivery_tx_id` 全局唯一索引，严防卖家拿同一笔转币交易去结算两张积分订单；
  6. 旧 `/v1/me/release` 与 `/v1/me/capture` 同样硬拦截所有 `ft_escrow` 冻结单（`403 ESCROW_GOVERNED_BY_SERVER`）。

### REQ-2B-02：基于 `higun` 与 `man-p2p` 的双链权威到账核验器（契约 C3.2）
- **新增文件**：`service/me_service/ft_chain_verifier.go`
- **MVC MetaContract FT 核验路径**：
  - 调用配置的 `higun_base_url`（生产 `open-api-mvc` / 内网 `higun` 节点）：
    - 锁单前预检：调 `/ft/utxos` 确认 `seller_source_address` 当前持有该 `codehash + genesis` 的可用余额 `>= token_amount_base`；
    - 交割后核验：通过 MVC 节点确认 `deliveryTxId` 有效存在，并调 `higun` `/db/ft/utxo` 或 0-conf `/ft/mempool/utxos`（及 `/db/ft/mempool/address/income/valid`）确认存在指向 `buyer_receive_address`、匹配 `codehash + genesis` 且 `BigInt(amount) >= BigInt(order.TokenAmountBase)` 的有效入账 FT UTXO。
- **BTC MRC-20 核验路径**：
  - 调用配置的 `man_indexer_base_url` / `metalet_wallet_api_url`：
    - 锁单前预检：确认卖家 BTC 地址在该 `mrc20Id` 下的 `Available` 余额充足；
    - 交割后核验：查询 `deliveryTxId`（即 MRC-20 转账的 `revealTxId`）在 `man-p2p` 中的验证结果 —— **必须核实 `man-p2p` 已为 `buyer_receive_address` 生成对应的 `mrc20_utxo` 或 `TransferPendingIn` 记录且 `verifiedAmount >= order.TokenAmountBase`**（严禁仅读 OP_RETURN/witness 原始文本，彻底免疫无效转账回退卖家的欺诈攻击！）。

### REQ-2B-03：超时与索引延迟竞态保护清扫器
- 新增每 5 秒执行的 `SweepPendingFtEscrowOrders`：
  - 对 `status = 2 (DELIVERY_SUBMITTED)` 订单持续重试核验，追平即自动 `Capture`；
  - 对 `status = 1` 到达 `delivery_deadline` 的超时单，退款前先查一次卖家向买家的近期转账历史，确认未发生漏报的真实发币后才 `releaseInTx` 退回买方积分。

---

## 三、测试与验收要求

1. **`metaso-p2p` 单测**：
   - `/protocols/ft-sell` 互斥校验测试（同 UTXO 双声明锁仓轨与直转轨被拒）；
   - UTXO 花费后挂单自动失效与地板价实时重算测试；
   - 同名 `symbol` 不同 `assetKey` 消歧提示测试；
   - `recentGranularity` 分位数计算单测。
2. **`assist-base-service` 单测**：
   - `grant/bonus` 隔离与 `ComputeConservation() == 0` 账本守恒测试；
   - 伪造 MRC-20 失败转账（币退回卖家）被 `VerifyBtcMrc20Delivery` 精准识破拒付测试；
   - 同一 `delivery_tx_id` 重放拦截与并发双锁同一 `utxoOutpoint` 互斥测试。
3. **编译回归**：两个 Go 仓库各自 `go build ./...` 退出码 `0`，`NO_COLOR=1 go test ./...` 全绿。
