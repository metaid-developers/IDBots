---
name: metabot-mm-basic
description: MetaBot 的基础做市技能。用于 BTC/SPACE 与 DOGE/SPACE 的做市询价、支持交易对查询、exact-in 按市价兑换、报价后确认成交、以及退款结果解释。当用户提到“支持什么交易对”“最新价格”“按市价买入/卖出”“兑换 BTC/SPACE/DOGE”“做市”“流动性提供”“退款原因”等，都应优先考虑使用本技能。
official: true
---

# MetaBot MM Basic

让 MetaBot 在第一阶段扮演一个库存驱动的一次性兑换做市商。它不是 AMM，也不是订单簿，而是一个会按实时公允价、库存偏移和固定点差来报价并完成单次换币的技能。

当前 Phase 1 支持：

- `BTC/SPACE`
- `DOGE/SPACE`
- `BTC -> SPACE`
- `SPACE -> BTC`
- `DOGE -> SPACE`
- `SPACE -> DOGE`

当前 Phase 1 不支持：

- `BTC <-> DOGE`
- exact-out
- 部分成交
- AMM 池子 / LP 份额

## 何时触发

当用户意图属于以下任一类时，应该触发本技能：

1. 询问做市商支持哪些交易对。
2. 询问某个交易方向的最新价格、最新买价、最新卖价、按市价大概能换多少。
3. 明确要求把 `BTC`、`SPACE`、`DOGE` 中的一种兑换成另一种，且落在本技能支持的交易方向内。
4. 用户先问过价格，然后又说“确定”“确认兑换”“按刚才报价成交”等，需要进入执行。
5. 用户在问为什么被退款、退款手续费由谁承担、为什么没有成交。

如果用户只是笼统地说“交易”“换币”，但没有明确到 `BTC/SPACE` 或 `DOGE/SPACE` 这一类方向，也应该先尝试用本技能承接，并补问缺失参数。

## Agent Workflow

当你决定使用本技能时，严格按下面顺序工作：

1. 先识别用户是“查询支持交易对”“询价”“直接按市价执行”“基于先前报价确认成交”中的哪一种。
2. 从用户输入里抽取结构化参数。
3. 如果缺少执行必需参数，必须先追问，不要猜。
4. 构造 `--payload` JSON。
5. 调用 `scripts/index.js`。
6. 解析 stdout JSON。
7. 用自然语言把结果翻译回用户可理解的话。

## 参数抽取规则

### 一、公共参数

| 字段 | 含义 | 何时必需 |
| --- | --- | --- |
| `mode` | `quote` 或 `execute` | 始终必需 |
| `service.pair` | 交易对，只能是 `BTC/SPACE` 或 `DOGE/SPACE` | 除“支持交易对查询”外必需 |
| `service.direction` | 交易方向，例如 `btc_to_space` | 除“支持交易对查询”外必需 |
| `order.amount_in` | 用户实际打算支付的输入币数量 | 普通询价和执行都必需 |

### 二、执行参数

以下字段只在 `mode=execute` 时必需：

| 字段 | 含义 |
| --- | --- |
| `order.pay_txid` | 用户已经支付的输入链转账 txid |
| `order.payer_globalmetaid` | 付款方 globalmetaid |
| `order.payout_address` | 做市 bot 成交后向其打款的输出币地址 |
| `order.refund_address` | 若需退款，原路退回的输入币地址 |

### 三、报价上下文参数

如果是“先询价，再确认成交”，应额外带：

| 字段 | 含义 |
| --- | --- |
| `quote_context.has_prior_quote` | 设为 `true` |
| `quote_context.slippage_bps` | 允许滑点，单位 bps |
| `quote_context.quoted_output` | 之前报价时的预计输出数量 |
| `quote_context.quoted_at` | 之前报价时间 |

如果是直接按市价成交，没有先前报价，则：

```json
{
  "quote_context": {
    "has_prior_quote": false
  }
}
```

## 缺参时必须追问什么

### 一、查询支持交易对

用户如果只是问“你支持什么交易对”，不需要追问，直接查询。

### 二、询价

如果缺少下面任一项，必须追问：

1. 交易方向不清楚。
2. 输入币数量不清楚。

典型追问：

- “你是想把 BTC 换成 SPACE，还是把 SPACE 换成 BTC？”
- “你打算支付多少 BTC / SPACE / DOGE 来兑换？”

### 三、执行

如果用户要求执行，但缺少以下任一项，必须追问：

1. `pay_txid`
2. `payer_globalmetaid`
3. `payout_address`
4. `refund_address`

不要假装这些字段可以凭空推断出来。

补充说明：

- 在未来完整服务广场集成里，这些地址原则上应由主进程基于付款方 `globalmetaid` 自动解析。
- 但在当前 Phase 1 普通技能测试模式下，脚本层仍然需要收到这些结构化字段。

## 精确命令格式

运行时配置文件默认路径：

```text
$IDBOTS_USER_DATA_PATH/metabot-mm-basic/config.json
```

仓库内提供了一份可直接复制并修改的样例：

```text
$SKILLS_ROOT/metabot-mm-basic/config.example.json
```

### 1. 查询支持交易对

```bash
node "$SKILLS_ROOT/metabot-mm-basic/scripts/index.js" \
  --payload '{"mode":"quote","query":{"kind":"supported_pairs"}}'
```

### 2. 普通询价

以 `0.1 BTC -> SPACE` 为例：

```bash
node "$SKILLS_ROOT/metabot-mm-basic/scripts/index.js" \
  --payload '{
    "mode": "quote",
    "service": {
      "pair": "BTC/SPACE",
      "direction": "btc_to_space"
    },
    "order": {
      "amount_in": "0.1"
    }
  }'
```

### 3. 直接按市价执行

```bash
node "$SKILLS_ROOT/metabot-mm-basic/scripts/index.js" \
  --payload '{
    "mode": "execute",
    "service": {
      "pair": "BTC/SPACE",
      "direction": "btc_to_space"
    },
    "order": {
      "amount_in": "0.1",
      "pay_txid": "<64位txid>",
      "payer_globalmetaid": "<payer-globalmetaid>",
      "payout_address": "<SPACE收款地址>",
      "refund_address": "<BTC退款地址>"
    },
    "quote_context": {
      "has_prior_quote": false
    }
  }'
```

### 4. 报价后确认执行

```bash
node "$SKILLS_ROOT/metabot-mm-basic/scripts/index.js" \
  --payload '{
    "mode": "execute",
    "service": {
      "pair": "BTC/SPACE",
      "direction": "btc_to_space"
    },
    "order": {
      "amount_in": "0.1",
      "pay_txid": "<64位txid>",
      "payer_globalmetaid": "<payer-globalmetaid>",
      "payout_address": "<SPACE收款地址>",
      "refund_address": "<BTC退款地址>"
    },
    "quote_context": {
      "has_prior_quote": true,
      "slippage_bps": 100,
      "quoted_output": "99",
      "quoted_at": "2026-03-29T12:00:00Z"
    }
  }'
```

## 字段语义和术语

请保持这些术语一致：

- `fair value`：外部行情推导出的公允价
- `mid`：库存偏移后的中间价
- `spread_bps`：总点差，单位 bps
- `bid`：做市 bot 买入 base asset 的价格
- `ask`：做市 bot 卖出 base asset 的价格

方向与价格侧映射：

- `BTC -> SPACE` 用 `bid`
- `SPACE -> BTC` 用 `ask`
- `DOGE -> SPACE` 用 `bid`
- `SPACE -> DOGE` 用 `ask`

## stdout JSON 格式

脚本成功时只会输出一行 JSON 到 stdout。

### 一、支持交易对查询成功

```json
{
  "mode": "quoted",
  "supportedPairs": [
    {
      "pair": "BTC/SPACE",
      "bid": "990",
      "ask": "1010",
      "mid": "1000",
      "source": "market"
    }
  ],
  "message": "Supported pairs: BTC/SPACE bid 990 / ask 1010. Execution always settles at the latest price."
}
```

### 二、单次询价成功

```json
{
  "mode": "quoted",
  "quote": {
    "pair": "BTC/SPACE",
    "direction": "btc_to_space",
    "side": "bid",
    "price": "990",
    "bid": "990",
    "ask": "1010",
    "output_amount": "99",
    "fair_value_source": "market"
  },
  "message": "Quote for BTC/SPACE btc_to_space: estimated 99 SPACE. Final settlement uses the latest price at payment verification."
}
```

### 三、执行成功

```json
{
  "mode": "executed",
  "lifecycle": ["pending_payment_proof", "validated", "executed"],
  "payoutTxid": "<txid>",
  "quote": {
    "side": "bid",
    "price": "990",
    "output_amount": "99"
  },
  "message": "Executed 0.1 BTC -> 99 SPACE at the latest bid price. Payout txid: <txid>."
}
```

### 四、退款成功

```json
{
  "mode": "refunded",
  "reason": "amount_mismatch",
  "lifecycle": ["pending_payment_proof", "refund_required", "refunded"],
  "refundTxid": "<refund-txid>",
  "message": "Paid amount did not exactly match the requested amount. Refunded 0.1 BTC. Refund is net of the refund-chain fee. The payer (Bot A) bore the refund fee. Refund txid: <refund-txid>."
}
```

### 五、查不到付款证明，作废

```json
{
  "mode": "void",
  "lifecycle": ["pending_payment_proof", "void"],
  "needsOperatorReconciliation": true,
  "message": "Payment proof could not be found after retry. The attempt was marked void and needs operator reconciliation."
}
```

### 六、打款或退款失败

```json
{
  "mode": "payout_failed",
  "message": "Payout failed after payment verification: ... Operator action may be required."
}
```

```json
{
  "mode": "refund_failed",
  "message": "Refund failed after settlement rejected the trade: ... Operator should handle this manually."
}
```

## AI 收到结果后应该怎么回复用户

### 一、当 `mode = quoted`

你应该：

1. 说清支持的交易对，或当前这次的预计输出数量。
2. 明确提醒“最终成交按支付校验时的最新价格执行”。
3. 如果这是普通询价，最后补一句“如果你确认成交，请提供支付后的 txid”或等效表达。

### 二、当 `mode = executed`

你应该：

1. 明确告诉用户已成交。
2. 说清输入币数量、输出币数量和方向。
3. 告知 payout txid。

### 三、当 `mode = refunded`

你应该：

1. 明确告诉用户本次没有成交，已退款。
2. 说清退款原因。
3. 说清退款手续费由谁承担。
4. 如有 refund txid，告诉用户。

特别注意：

- `amount_mismatch` 时，应强调退款链上手续费由付款方承担。
- `inventory_shortage` 时，应强调退款手续费由做市方承担。

### 四、当 `mode = void`

你应该：

1. 明确说明暂时没有查到付款证明，因此本次尝试已作废。
2. 告知这是需要运营侧对账的情况，不要把它说成成交成功。

### 五、当 `mode = payout_failed` 或 `refund_failed`

你应该：

1. 明确说明链上执行失败。
2. 明确提示需要人工处理或运营介入。
3. 不要假装用户资金已经安全处理完毕。

## 严格约束

1. 本技能只支持 `BTC/SPACE` 和 `DOGE/SPACE`，不要编造成支持其他交易对。
2. `service.pair` 与 `service.direction` 是权威字段；如果有 `order.asset_in` 且冲突，应视为无效请求。
3. Phase 1 只支持 exact-in。
4. 直接按市价执行时，不要把旧报价当作锁价承诺。
5. 只有 `has_prior_quote = true` 时，才应用滑点保护。
6. 金额不匹配时，处理方式是退款，不是拒绝不处理。
7. 退款和成交都要以脚本 stdout JSON 为准，不要自行脑补状态。
8. 始终使用：

```bash
node "$SKILLS_ROOT/metabot-mm-basic/scripts/index.js" --payload '...'
```

不要改成别的入口，也不要直接调用内部模块。
