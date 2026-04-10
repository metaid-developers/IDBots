---
name: metabot-trade-metaidmarket
description: MetaBot 的 metaid.market 交易技能。只要用户提到 metaid.market、$TOKEN 的挂单列表、最新成交、我的挂单、我的成交、最低价买入、mint、铸造、挂单、取消挂单、查看自己钱包里某个 token 的可用数量或已挂单数量，都应该优先调用这个技能。这个技能把自然语言先转成精确参数，再通过 metaid.market API 和本地 IDBots RPC 完成查询或交易。
official: true
---

# MetaBot Trade MetaidMarket

用于把自然语言交易请求转成 **结构化 CLI 参数**，再调用 `scripts/index.js` 去桥接：

1. `https://api.metaid.market/api-market/api/v1`
2. 本地 `IDBOTS_RPC_URL` 提供的 MetaBot 钱包签名能力

这个技能当前聚焦 10 个高价值能力，不超过 10 个：

1. 查看某个 token 的概览
2. 查看某个 token 的当前挂单列表
3. 查看某个 token 的最新成交
4. 查看当前 MetaBot 钱包里某个 token 的持仓、可用、未确认、已挂单数量
5. 查看当前 MetaBot 自己的有效挂单
6. 查看当前 MetaBot 自己的最新成交历史
7. 以最低单价买入当前最便宜的一笔整单挂单
8. mint 一个 ID-Coin
9. 把钱包中的 token 以指定单价和数量挂单到 market
10. 按订单号取消挂单，并把挂单锁住的 token 解锁回钱包

## 触发判断

当用户出现这些意图时，应该考虑调用本技能：

- “展示 `$METAID` 的挂单列表”
- “看下 `$METAID` 最新成交”
- “帮我以最低价买一份 `$METAID`”
- “帮我 mint 一份 `$METAID`”
- “把我钱包里的 `$METAID` 以 0.0001 BTC 挂 1000 份”
- “看下我现在有多少 `$METAID` 可以卖”
- “看下我自己挂了哪些 `$METAID` 单”
- “显示我自己的 `$METAID` 最新成交”
- “帮我取消这笔挂单”

如果用户只是在讨论市场策略、问该不该买、或者请求和 metaid.market 无关的链上操作，不要调用本技能。

## 执行原则

1. **先抽参数，再调脚本**。不要把整句自然语言直接塞给脚本。
2. **优先确认最少参数**。少了关键信息再追问，别让脚本猜测。
3. **执行类动作默认使用当前会话 MetaBot**。不要向用户索要 `metabot_id`。
4. **默认 network 是 `mainnet`**。除非用户明确说 testnet。
5. **交易和挂单都按结构化值处理**：token、数量、单价、订单号、费率。

## CLI

```bash
node "$SKILLS_ROOT/metabot-trade-metaidmarket/scripts/index.js" \
  --action <overview|orders|trades|wallet|my-orders|my-trades|buy-lowest|mint|list|cancel> \
  [--token-symbol "<symbol>"] \
  [--quantity "<decimal>"] \
  [--unit-price-btc "<decimal>"] \
  [--order-id "<order-id>"] \
  [--network <mainnet|testnet>] \
  [--network-fee-rate "<sat/vB>"] \
  [--limit "<int>"] \
  [--metabot-name "<name>"]
```

## 参数语义

### `--action`

- `overview`: token 概览
- `orders`: 当前挂单
- `trades`: 最新成交
- `wallet`: 当前 MetaBot 钱包该 token 的持仓情况
- `my-orders`: 当前 MetaBot 自己的有效挂单
- `my-trades`: 当前 MetaBot 自己的成交历史
- `buy-lowest`: 买入最低单价的一笔整单挂单
- `mint`: mint 一个 ID-Coin
- `list`: 挂单
- `cancel`: 取消挂单并尝试把 token 解锁回钱包

### `--token-symbol`

- 必须传 token symbol
- 用户写 `$METAID` 时，传 `METAID`
- 脚本内部会先优先尝试把它解析成 ID-Coin；如果不是，再回落到普通 MRC-20

### `--quantity`

- `list` 时表示要挂出去的 token 数量
- `buy-lowest` 时如果用户明确要求“买 1 份 / 买 100 份”，就传这个值
- 注意：这个 quantity 只会匹配 **整笔挂单数量**，不会做部分成交

### `--unit-price-btc`

- 仅 `list` 时使用
- 表示 **每 1 个 token 的 BTC 单价**
- 脚本会根据数量自动换算整笔总价后提交到 market

### `--order-id`

- 仅 `cancel` 时使用
- 如果用户没有提供订单号，不要猜；先追问
- 更推荐先用 `my-orders` 帮用户把自己的挂单和 `orderId` 展示出来，再执行取消

### `--network-fee-rate`

- 可选 BTC 网络费率，单位 `sat/vB`
- 用户没指定时，让脚本用 metaid.market 推荐费率

## 自然语言到参数的典型映射

### 1. 展示挂单

用户：

```text
帮我展示 $METAID 的挂单列表
```

命令：

```bash
node "$SKILLS_ROOT/metabot-trade-metaidmarket/scripts/index.js" \
  --action orders \
  --token-symbol METAID
```

### 2. 看最新成交

用户：

```text
显示 $METAID 的最新成交历史
```

命令：

```bash
node "$SKILLS_ROOT/metabot-trade-metaidmarket/scripts/index.js" \
  --action trades \
  --token-symbol METAID
```

### 3. 以最低价买

用户：

```text
帮我以最低价格购买一份 $METAID
```

处理方式：

- 因为用户明确说了“1 份”，应先尝试匹配数量恰好为 `1` 的整笔挂单
- 如果不存在数量恰好为 `1` 的整笔挂单，脚本会报错说明当前 market 不支持部分成交
- 如果用户没说数量，才按“最低单价的一整笔挂单”执行

命令：

```bash
node "$SKILLS_ROOT/metabot-trade-metaidmarket/scripts/index.js" \
  --action buy-lowest \
  --token-symbol METAID \
  --quantity "1"
```

### 4. mint

用户：

```text
帮我铸造一份 $METAID
```

命令：

```bash
node "$SKILLS_ROOT/metabot-trade-metaidmarket/scripts/index.js" \
  --action mint \
  --token-symbol METAID
```

### 5. 挂单

用户：

```text
帮我把钱包里的 $METAID 以 0.0001 BTC 挂 1000 份
```

命令：

```bash
node "$SKILLS_ROOT/metabot-trade-metaidmarket/scripts/index.js" \
  --action list \
  --token-symbol METAID \
  --quantity "1000" \
  --unit-price-btc "0.0001"
```

### 6. 取消挂单

用户：

```text
帮我取消挂单 7818c13c...
```

命令：

```bash
node "$SKILLS_ROOT/metabot-trade-metaidmarket/scripts/index.js" \
  --action cancel \
  --order-id "7818c13c..."
```

### 7. 看我自己的挂单

用户：

```text
帮我看下我自己挂了哪些 $METAID
```

命令：

```bash
node "$SKILLS_ROOT/metabot-trade-metaidmarket/scripts/index.js" \
  --action my-orders \
  --token-symbol METAID
```

### 8. 看我自己的成交

用户：

```text
显示我自己最近成交的 $METAID
```

命令：

```bash
node "$SKILLS_ROOT/metabot-trade-metaidmarket/scripts/index.js" \
  --action my-trades \
  --token-symbol METAID
```

## 回复策略

脚本成功时会输出一行 JSON，至少包含：

```json
{
  "mode": "overview | orders | trades | wallet | bought | minted | listed | cancelled | unsupported",
  "message": "给用户看的多行文本",
  "data": {}
}
```

你应该：

1. 读出 `message`
2. 用简洁自然语言向用户复述关键结果
3. 如果是执行类动作，突出：
   - 数量
   - 成交/挂单价格
   - 订单号或 TxID

## 当前边界

- `mint` 现在只支持 metaid.market 的 **ID-Coin mint** 流程
- `buy-lowest` 会买入一整笔挂单；如果传了 `--quantity`，只会匹配数量完全相等的整单
- `cancel` 需要明确的 `order-id`
- `list` 如果钱包里没有精确数量的单个 UTXO，脚本会先走 metaid.market 的 MRC20 transfer 流程自转拆分，再挂单
- `cancel` 不只是改 market 状态，还会继续做一次解锁转出，让 token 回到可用余额

## 运行前提

- 最理想的环境是 **IDBots Cowork**
- 宿主应注入：
  - `IDBOTS_METABOT_ID`
  - `IDBOTS_RPC_URL` 可选，默认 `http://127.0.0.1:31200`

如果没有 `IDBOTS_METABOT_ID`，可以传 `--metabot-name "<当前 MetaBot 名称>"` 让脚本通过本地 RPC 自动解析。
