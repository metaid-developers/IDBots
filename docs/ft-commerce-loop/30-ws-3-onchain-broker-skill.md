# WS-3 开发任务书：链上统一交易经纪人技能 `metabot-token-broker`

- **基础源码参考**：`/Users/tusm/Documents/MetaID_Projects/Sunny-Skills/metabot-trade-metaidmarket-v2`
- **新技能名称与目录**：`metabot-token-broker`（作为链上技能发布至 MetaWeb，同时保留本地开发与单测工程）
- **上游契约依赖**：[`01-protocols-and-contracts.md`](01-protocols-and-contracts.md) 中的 **契约 C1、C2、C3、C4**

---

## 一、从 `metaidmarket-v2` 到 `metabot-token-broker` 的四大跨代升级

`metabot-trade-metaidmarket-v2` 已经验证了“自然语言转 CLI 参数 + 调本地 RPC 签名”的可行性，但还停留在单一市场基础命令包装层。`metabot-token-broker` 将升级为真正的 **AI 私人交易经纪人**：

1. **真正开箱即用（消灭首次手动 `npm install`）**：
   - 使用 `esbuild` 将所需纯 JS 库（如 `bitcoinjs-lib`、大整数精度计算库）预打包进单文件 `scripts/broker.bundle.mjs`，用户从链上安装技能后 **0 秒可用，无需本地编译或联网装包**。
2. **全网三端比价与同名代币防伪消歧（`quote`）**：
   - 同时查询 `api.metaid.market`（BTC PSBT）、MetaSo `/api/ft/market/*`（MVC `TokenSell` + 双链 `ME` 积分挂单）及用户本地钱包持仓（`mrc20` + `mvc-ft`）；
   - 若用户口述 `$TOKEN` 命中多个不同 `assetKey`，优先选用官方认证/高持有人主流资产并在回复中明确披露 `assetKey`，若均为非认证小币种则列出候选请用户确认后再报价；
   - 自动输出标准 ```` ```ft-quote-card ```` 代码块。
3. **买方核心武器：预算约束背包凑单算法（`buy-sweep`）**：
   - 输入：`--asset-key`（或 `--token-symbol`）、`--rail <btc-psbt|mvc-tokensell|me-escrow|auto>`、`--max-budget <decimal>`（硬上限，**含矿工费**）、可选 `--max-unit-price <decimal>`、`--target-quantity <decimal>`。
   - **算法要求（精确大整数运算，严禁用 JS `Number` 算金额！）**：
     1. 拉取对应通道按单价升序排列的前 `K`（如 50）张有效整包挂单（对 `me-escrow` 过滤 `onlineOnly=true`）；
     2. 计算每张挂单的**真实全包成本** `totalCost_i = orderPrice_i + estimatedTxFee_i`（BTC 侧计入 taker PSBT 全部输出 + 买家输入 vbytes × 实时费率 + 载体 546/600 sat；MVC 侧计入 checker + take 矿工费；ME 侧为 `amountMilli`）；
     3. 剔除单价超过 `maxUnitPrice` 或单张已超总预算的大单，在 `sum(totalCost) <= maxBudget` 约束下用动态规划/贪心回溯求 **单位均价最低且最接近目标数量（或预算内可得币量最大）的订单子集**；
     4. 先调宿主 `/api/idbots/commerce/ft-mandate-confirm` 弹出 **1 张合并确认卡** 拿到 `mandateToken`；
     5. 逐单做签名前安全硬核验（BTC 侧继承 v2 的 PSBT 卖方地址/金额/utxoId 强校验；MVC 侧调宿主 `/token-sell/verify`），连续执行吃单并汇总输出 ```` ```ft-fill-card ````（若中途某单被别人抢先吃掉，自动跳过或重选次优单，绝不超支预算）。
4. **卖方核心武器：流动性颗粒度分析与智能拆包多轨挂单（`list-lots`）**：
   - 输入：`--asset-key`、`--total-quantity <decimal>`、`--lot-count <int>`（可选，未传时读取 MetaSo `recentGranularity.medianLotAmountDisplay` 自动推荐最佳拆包份数，通常控制在 `1..10` 份以内以节省拆分手续费）、`--rail <btc-psbt|mvc-tokensell|me-escrow>`、`--unit-price <decimal>`。
   - **执行流水线**：
     1. 调 `/api/idbots/commerce/ft-mandate-confirm` 让卖家一次性确认拆包份数、单价、通道与总预估拆分矿工费；
     2. **BTC `btc-psbt` 轨**：若钱包无现成精确面额 UTXO，先通过 `metaid.market` MRC-20 transfer 或本地 `mrc20/transfer` 拆分为 `N` 颗精确面额 UTXO，逐颗构造 `SIGHASH_SINGLE|ANYONECANPAY` 卖单提交市场，并调用 `/api/idbots/commerce/ft-watch/register` 注册后台成交监控；
     3. **MVC `mvc-tokensell` 轨**：调本地 `/api/idbots/wallet/mvc/ft-split` 拆出精确面额 UTXO，逐颗调 `/api/idbots/wallet/mvc/token-sell/list` 锁入链上合约并广播 `/protocols/ft-sell` Pin，注册后台成交监控；
     4. **双链 `me-escrow` 轨**：拆出对应面额独立 UTXO（保持在卖家自己钱包地址下），广播 `/protocols/ft-sell`（`rails.me = { amountMilli, autoFulfill: true }`），注册进本地 `SellerAutoFulfillDaemon` 实现 **24 小时免打扰自动收积分发币**；
     5. 输出带 `batchGroupId` 的 ```` ```ft-order-card ````，引导卖家一键生成社群推销海报。

---

## 二、CLI 动作清单（精炼为 9 个高内聚动作）

```bash
node "$SKILLS_ROOT/metabot-token-broker/scripts/broker.bundle.mjs" \
  --action <quote|orders|wallet|my-orders|my-trades|buy-sweep|list-lots|cancel|mint> \
  [结构化参数...]
```

- 完整保留 `metabot-trade-metaidmarket-v2` 已有的 `wallet`、`my-orders`、`my-trades`、`cancel`（支持按 `orderId` 或 `batchGroupId` 批量撤回 BTC PSBT / MVC TokenSell / ME 挂单）、以及 ID-Coin `mint` 能力。

---

## 三、测试与验收要求

1. **离线确定性单元测试（`tests/`）**：
   - **背包凑单算法单测**：构造典型 UTXO 挂单簿（如预算 `0.01 BTC`，场上挂单 `[200@8sat, 500@9sat, 5000@9.2sat(超预算!), 300@10sat]`），断言算法精准跳过 5000 大单、选中 `200+500+300=1000` 枚且计入矿工费后严格 `<= 0.01 BTC`；
   - **PSBT 与 TokenSell 欺诈拦截单测**：篡改服务端返回 PSBT 的卖方收款输出或假造低价 `TokenSell` 种子锁，断言签名前 100% 抛错终止；
   - **零依赖沙箱运行测试**：将打包产物复制到空临时目录（无 `node_modules`），验证全部 CLI 动作正常加载运行。
2. **SKILL.md 编写规范**：清晰定义触发词、经纪人主动建议话术模板（何时建议拆单、何时提示三端价差）及安全确认铁律。
