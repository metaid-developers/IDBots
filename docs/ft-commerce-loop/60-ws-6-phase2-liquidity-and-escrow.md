# WS-6 开发任务书（Phase 2 深化蓝图）：流动性池服务化、跨链桥路由与高阶 AI 经济

- **启动时机**：Phase 1A（三轨点对点买卖）与 Phase 1B（Token 买数字商品 + 付费阅读）合入 `main` 并完成首批老用户冷启动验证后按需启动
- **涉及仓库**：
  - `/Users/tusm/Documents/MetaID_Projects/mvcswap-core`（及参考 `mvcswap`）
  - `/Users/tusm/Documents/MetaID_Projects/octopus-bridge`
  - `/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots`

---

## 一、子模块 6.1：`MVCSwap` 无前端 Agent 化重生（Headless Pool Sequencer）

### 1.1 技术本质与改造路径
- **为什么不能纯客户端无协调直连**：MVC 链上的恒定乘积 AMM 池（`x * y = k`）状态保存在单条连续演进的合约 UTXO 链上，且合约解锁依赖池子 Rabin 签名与状态树证明。若多个 Bot 无协调并发花费同一颗池子 UTXO，必然引发双花冲突。
- **Agent 化极简架构（零 Web 前端负担）**：
  1. 基于 `mvcswap-core`（优先聚焦稳定可靠的 V1 恒定乘积 `contracts/swap/` 与 `contracts/tokenSwap/`，剥离缺失 4 个辅助文件的遗留 `swapRange` 模块，升级适配 Node 24 LTS）封装一个轻量无状态前端的 **Pool Sequencer HTTP 服务**（暴露标准 JSON 接口：`GET /v1/pools`、`GET /v1/pools/:pairId/quote`、`POST /v1/pools/:pairId/build-swap`、`POST /v1/pools/build-add-liq`、`POST /v1/pools/build-remove-liq`）；
  2. **非托管签名边界**：Sequencer 仅负责对池子状态 UTXO 排队加毫秒级串行锁并提供池子侧 Rabin 签名与合约模板；用户资金输入与滑点保护最小输出（`minAmountOut`）完全在用户本机 IDBots 内校验签名；
  3. 发布链上技能 **`metabot-mvcswap`**：支持用户对 TwinBot 说“帮我给 `$TOKEN / SPACE` 建个流动性池放 100 SPACE 进去”或“把 50 个 `$TOKEN` 在池子里换成 SPACE，滑点不超 1%”，并与 `metabot-token-broker` 的全网比价路由自动打通（当小额交易走 AMM 池比吃整包挂单更划算时自动路由至池子）。

---

## 二、子模块 6.2：`Octopus Bridge` 异步跨链路由技能（`metabot-octopus-bridge`）

### 2.1 运维前置评估与异步架构
1. **生产开关评估**：根据 `/Users/tusm/Documents/MetaID_Projects/octopus-bridge/README.md`，目前 `api.octopus.space` 的 `MVC → BTC`（Redeem）正常在线，而 `BTC → MVC`（Mint）处于 `ENABLE_MINT=false` 暂停状态。启动双向自动搬砖前，先完成 `bridge-node`（`v0.0.107+`）与网关账本巡检，按需分币种白名单开启双向通道（或初期先开放 `MVC → BTC` 单向提币挂 `metaid.market` 卖高价路径）。
2. **后台跨链状态机（绝不阻塞对话）**：
   - 跨链涉及 BTC 区块确认（10~60 分钟），严禁在单轮脚本里 `sleep` 死等；
   - 在 IDBots 宿主复用长期任务/追单框架（参考 `SwapOrderTracker`），当 TwinBot 发起跨链订单后立即返回跨链进度卡，后台轮询 `api.octopus.space` 到账完成后自动唤醒 TwinBot 执行下一跳（如自动在目标链挂单或 Swap）并推送手机通知。

---

## 三、子模块 6.3：法币（CNY）蓝标担保 Bot 扩展支持 FT 场外大宗交易

- 100% 复用数字商品 Phase 2 `WS-F`（`docs/nft-commerce-loop/60-ws-f-fiat-escrow-phase2.md`）的 **`GuarantorBotDaemon` 与 A2A 七步状态机**：
- **严守合规铁律**：官方蓝标认证担保 Bot **只托管链上 FT / MRC-20 资产，绝不经手任何人民币资金**！
- 流转仅替换托管标的校验与放货动作：卖方将指定数量 FT 转入担保仓地址 → 担保 Bot 通过 `higun` / `man-p2p` 核验足额真币已入担保仓后签发 `ITEM_ESCROWED` → 买方界面才弹出卖方个人收款码 `pay-card` → 卖方人工核实收款签名确认后，担保 Bot 自动将代币转入买方地址。

---

## 四、子模块 6.4：A2A 持仓防女巫门槛与 MetaTask v1.3 贡献度自动分币

1. **主权持仓门卫（Token-Gated A2A Policy）**：
   - 在 `privateChatDaemon` 与 `groupTaskDaemon` 入站前置过滤层支持配置主权准入策略：`minTokenHolding: { assetKey, minAmountBase }` 或 `requiredNftCollectionPinId`；
   - 陌生远程 Bot 请求唤醒我方大模型或拉群协作时，先调 `higun` / `man-p2p` / `metaso` 缓存毫秒级验资，未达标者直接礼貌拒回验资要求，零算力损耗抵御全网女巫垃圾号。
2. **MetaTask 任务发币与结算清单自动分润**：
   - 对接 IDBots 已实现的 `MetaTask v1.3.0` 确定性重放引擎（`docs/metaid_protocols/metatask-v1.3.0-alignment.md`）；
   - 支持任务发起人在创建根任务时绑定奖池 Token（或一键部署专属项目 FT），任务终态重放产出全网一致的 `CANONICAL_SHA256` 贡献权重清单后，由发起人 TwinBot 一键生成多收款人 `buildMvcOrderedRawTxBundle` 按比例精准空投结算。
