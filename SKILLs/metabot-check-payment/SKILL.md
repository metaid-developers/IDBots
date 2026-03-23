---
name: metabot-check-payment
description: Official IDBots MetaBot skill to verify on-chain payments (MVC/SPACE, BTC, DOGE) from a txid against expected amount and recipient address, with optional payer-address check. Use when the user or another party claims they paid (e.g. "I sent you 1 SPACE, txid is …", "verify this payment", "check if I received the transfer", "这笔款到账了吗", "核对 txid 支付是否真实", "收款地址是否收到钱"). If the user only says an amount in "sats" or "聪" without naming the chain, ask whether they mean BTC, SPACE (MVC), or Doge before running the script. Aligns with service-square order payment verification (orderPayment.ts); confirmation uses Metalet address-UTXO fields (BTC `confirmed`, MVC/DOGE `height`).
official: true
---

# MetaBot Check Payment（链上支付校验）

在对话中遇到**声称已付款**、**提供 txid**、或需要判断**本 MetaBot 是否收到指定金额**时，使用本技能。校验逻辑与 IDBots 服务广场订单链路中的 `orderPayment` 一致：通过 Metalet 拉取原始交易、解析输出、比对收款地址与金额（默认 1% 容差）。**已确认 / 未确认**则通过 Metalet **地址 UTXO 列表**接口推断（见下文），**不在结果中返回区块高度或确认数**。

## 网络与货币单位（务必对齐，减少误判）

执行前心里要有这张表，并在回复用户时使用一致术语：

| 网络（全称） | 常用符号 | 主单位 | 与最小单位换算 | 最小单位称呼（避免混用） |
|-------------|----------|--------|----------------|-------------------------|
| **Microvision Chain**（常写作 **MVC**） | MVC | **SPACE** | **1 SPACE = 100,000,000** 最小单位 | 可称 **sats-space**（与 BTC 的 sat 区分） |
| **Bitcoin** | BTC | **BTC** | **1 BTC = 100,000,000** sat | 可称 **sats-btc**；中文常说「聪」、英文常说 **sats** 时，**多数语境默认指 BTC 的 sat** |
| **Dogecoin** | DOGE | **Doge**（单位名与币种同名） | **1 Doge = 100,000,000** 最小单位 | 可称 **sats-doge** |

**脚本参数 `--currency`**：`SPACE` 与 `MVC` 均视为 **MVC 链**；金额参数 `--expected-amount` 始终用**主单位**（SPACE / BTC / Doge），**不要**把「聪」或「sats」直接塞进 `--expected-amount`，除非已换算成主单位小数。

### 「sats / 聪」歧义时必须追问

当用户只说「付了 **xxxx sats**」「**xxxx 聪**」而**未说明链**时，**必须先问清楚**这笔最小单位是 **BTC、SPACE（MVC）还是 Doge** 的 sat，再选定 `--currency` 并把金额换算成主单位后调用脚本。不要默认当成 BTC。

## 执行逻辑（Agent 工作流）

1. **澄清意图**：用户是否在核实一笔转账的真实性、金额、收款方，或是否要继续执行付费后的下一步。
2. **从自然语言抽取字段**（若用户未显式给出，必须追问）：
   - **txid**：64 位十六进制（可含大小写）。正则：`\b[0-9a-fA-F]{64}\b`。
   - **币种 / 网络**：按上表选定 `SPACE`（或 `MVC`）、`BTC`、`DOGE`。
   - **声称金额**：主单位十进制（如 `1` SPACE）；若用户只给 sats/聪，先确认链再换算。
   - **收款地址**：通常是**当前执行技能的 MetaBot** 在该链上的地址；若会话已注入环境变量，可按链选用：
     - `IDBOTS_METABOT_MVC_ADDRESS`（SPACE/MVC）
     - `IDBOTS_METABOT_BTC_ADDRESS`
     - `IDBOTS_METABOT_DOGE_ADDRESS`
   - **付款人地址（可选）**：仅当用户明文给出地址，或系统已注入可靠付款人地址时填写；**无法确定则传空**，不要猜测。
3. **提醒执行方**：在运行脚本前简要列出将要校验的 txid、币种、金额、收款地址、付款人地址（若有），避免张冠李戴。
4. **执行脚本**：调用下方命令，将抽取结果传入参数。**不要**自行伪造 txid 或地址。

## 命令语法

```bash
node "$SKILLS_ROOT/metabot-check-payment/scripts/verify-payment.js" \
  --txid "<64位hex>" \
  --currency SPACE \
  --expected-amount "<金额>" \
  --recipient-address "<收款地址>" \
  [--payer-address "<付款人地址>"] \
  [--tolerance-percent 1]
```

## 参数说明

| 参数 | 说明 | 必填 |
|------|------|------|
| `--txid` | 交易 id（64 字符 hex） | 是 |
| `--currency` | `SPACE`、`MVC`、`BTC`、`DOGE` | 是 |
| `--expected-amount` | 声称支付的**主单位**数量（十进制字符串） | 是 |
| `--recipient-address` | 应收款地址（base58 或 `bc1q` P2WPKH 等脚本可解析形式） | 是 |
| `--payer-address` | 可选；若省略或空字符串则不校验付款人 | 否 |
| `--tolerance-percent` | 金额容差百分比，默认 `1`（与订单校验一致） | 否 |

## 成功输出（stdout JSON）

脚本**正常执行完毕**时退出码为 `0`，stdout **单行 JSON**（勿用 stderr 解析结果）。核心字段：

| 字段 | 含义 |
|------|------|
| `txFound` | Metalet 是否返回了可解析的 raw tx |
| `amountMatch` | `yes` / `no` / `tx_not_found` / `parse_error` — 收款地址收到的最小单位合计是否达到声称主单位换算后的数量（含容差） |
| `payerMatch` | `yes` / `no` / `no_payer_info` / `inconclusive` — 是否匹配传入的付款人；未传付款人时为 `no_payer_info` |
| `recipientReceivedSats` | 该交易中付给 `recipient-address` 的最小单位合计（对 SPACE/BTC/Doge 均为链上 1e8 精度） |
| `recipientOutputVouts` | 付给收款地址的输出索引列表 |
| `confirmationStatus` | `not_found`（无此 tx）\| `fetch_error` \| `confirmed` \| `unconfirmed` \| `unknown` |
| `confirmationReason` | 当 `unknown` 等需要解释时给出机器可读原因 |
| `confirmationNote` | 说明确认状态**如何**从 Metalet 接口推出（见下） |

**关于已确认 / 未确认（无高度、无确认数字段）**：

- **BTC**：`GET .../wallet-api/v3/address/btc-utxo?...&unconfirmed=1` 返回的 UTXO 项含布尔字段 **`confirmed`**。脚本在收款地址的 UTXO 中查找 **本 txid + 付给收款方的 vout**，据此判断整笔支付输出侧是否已确认。
- **MVC（SPACE）/ DOGE**：`.../wallet-api/v4/{mvc|doge}/address/utxo-list` 返回项含 **`height`**；**`height > 0`** 视为已确认，**`height === 0`** 视为未确认（仍在 mempool 或未入账等，依索引器语义）。
- **`unknown`**：例如收款侧 UTXO 列表里**找不到**对应 txid+vout（常见原因：输出**已花费**、索引延迟、或解析到的收款 vout 为空）。此时应告知用户：链上可能仍曾支付成功，但无法仅凭当前接口判定确认状态。

**付款人校验说明**：脚本从输入的 `scriptSig` / SegWit witness 中提取标准公钥并比对地址。多签、复杂 P2SH、部分 RBF 场景可能得到 `inconclusive`。

## 与订单校验代码的关系

服务广场订单在 Main 进程使用 `src/main/services/orderPayment.ts` 的 `checkOrderPaymentStatus`。本技能脚本**独立实现**同等 fetch + 输出解析逻辑，便于在 Cowork/技能沙箱中直接 `node` 调用，**无需**引用 Electron 主进程模块；**确认状态**在技能脚本中额外使用 Metalet **地址 UTXO** 接口。若主流程与脚本行为出现分歧，以主仓 `orderPayment.ts` 为准并应同步更新脚本。

## 示例

**用户说**：「我已给你支付了 1 个 SPACE，txid 是 d91bfcc1b2ead314fce8bca2c8206928615a65ba5b14be002c175c9bf8d4d576」

1. 抽取：`currency=SPACE`，`expected-amount=1`，`txid=...`，`recipient-address` 使用本 MetaBot MVC 地址（如来自 `IDBOTS_METABOT_MVC_ADDRESS`）。
2. 未提供付款人地址 → 不传 `--payer-address`。

```bash
node "$SKILLS_ROOT/metabot-check-payment/scripts/verify-payment.js" \
  --txid "d91bfcc1b2ead314fce8bca2c8206928615a65ba5b14be002c175c9bf8d4d576" \
  --currency SPACE \
  --expected-amount "1" \
  --recipient-address "<IDBOTS_METABOT_MVC_ADDRESS 或用户指定的收款地址>"
```

## AI 行为约束

1. **参数必须来自用户或已注入环境**：不得编造 txid、金额或地址。
2. **收款地址链种与 `--currency` 一致**：SPACE/MVC 用 MVC 地址；BTC/DOGE 同理。
3. **解析结果**：以 JSON 字段为准向用户解释；`amountMatch === "yes"` 且 `txFound` 才表示链上输出侧校验通过；`confirmationStatus` 单独解读。
4. **Shell 转义**：参数用双引号包裹，内容中的 `"`、`` ` ``、`$` 需转义。
5. **脚本路径**：始终使用 `$SKILLS_ROOT/metabot-check-payment/scripts/verify-payment.js`。
