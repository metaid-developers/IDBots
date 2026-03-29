---
name: metabot-trade-mvcswap
description: MetaBot 的 mvcswap 交易技能。当用户提到 swap、兑换、买入某个 token、卖出某个 token 换 SPACE、查询报价、预览成交、设置滑点、确认交易、确定执行、无需询问时，都应考虑调用此技能。
official: true
---

# MetaBot Trade Mvcswap (mvcswap 交易执行器)

用于通过 mvcswap 完成 `SPACE <-> token` 的报价、预览和交易执行。这个技能的关键不是把自然语言整句交给脚本，而是 **由 AI 先从用户话里抽出结构化参数，再用精确 CLI 参数调用脚本**。

## 🧠 执行逻辑 (Agent Workflow)

当用户的意图涉及 **兑换 / swap / 买入某 token / 卖出某 token / 查询报价 / 设置滑点 / 确认执行交易** 时，必须按下面步骤处理：

1. **识别交易意图**：典型信号词包括「换」「兑换」「swap」「买」「买入」「卖」「卖出」「报价」「能换多少」「滑点」「确认交易」「确定执行」「无需询问」。
2. **抽取结构化参数**：
   - `action`：`quote` / `preview` / `execute`
   - `direction`：`space_to_token` / `token_to_space`
   - `amount-in`：输入侧数量
   - `token-symbol`：非 `SPACE` 的那一端 token symbol
   - `slippage-percent`：可选，默认 `1`
3. **缺参数就追问**：如果用户没有明确给出输入数量、方向、目标 token，先问清楚，再调用脚本。
4. **用结构化命令执行脚本**：调用 `scripts/index.js`，只传明确参数，不传自然语言整句。
5. **读取 stdout JSON**：脚本成功时输出一行 JSON，核心字段是 `mode` 和 `message`。
6. **根据 `mode` 回复用户**：
   - `quote`：直接展示报价
   - `preview`：展示预览，并等待用户确认
   - `executed`：告诉用户交易已提交，并展示 TxID
   - `unsupported`：说明当前参数不合法或不完整，补齐后再重试

## 💻 命令语法 (Command)

```bash
node "$SKILLS_ROOT/metabot-trade-mvcswap/scripts/index.js" \
  --action <quote|preview|execute> \
  --direction <space_to_token|token_to_space> \
  --amount-in "<decimal>" \
  --token-symbol "<symbol>" \
  [--slippage-percent "<decimal>"]
```

## 📋 参数说明

| 参数 | 说明 | 必填 | 示例 |
| --- | --- | --- | --- |
| `--action` | 本次调用的动作。`quote` 表示只看报价，`preview` 表示生成预览，`execute` 表示直接执行。 | 是 | `quote` |
| `--direction` | 交易方向。`space_to_token` 表示用 `SPACE` 换 token；`token_to_space` 表示卖 token 换 `SPACE`。 | 是 | `space_to_token` |
| `--amount-in` | 输入侧数量。必须是正数。 | 是 | `10` |
| `--token-symbol` | 非 `SPACE` 的那一端 token symbol。始终传 token，不传 `SPACE`。 | 是 | `DOGE` |
| `--slippage-percent` | 滑点百分比。用户未指定时可省略，脚本默认使用 `1`。 | 否 | `0.5` |

## 🌐 环境变量

| 变量 | 说明 | 必填 | 默认值 |
| --- | --- | --- | --- |
| `IDBOTS_METABOT_ID` | 要用于交易的 MetaBot ID。执行交易时必须可用。 | 执行交易时是 | 无 |
| `IDBOTS_RPC_URL` | 本地 IDBots RPC 地址。 | 否 | `http://127.0.0.1:31200` |

## 🧾 如何从自然语言抽参数

### 1. 判断 `action`

- 用户说「报价」「能换多少」「大概能换多少」时：`--action quote`
- 用户是想先看看结果、但没有明确要求立刻提交时：`--action preview`
- 用户明确说了「确认交易」「确定执行」「无需询问」时：`--action execute`

### 2. 判断 `direction`

- 用户说「用 10 SPACE 换 DOGE」「买 DOGE」这类语义：`--direction space_to_token`
- 用户说「卖出 500 DOGE 换 SPACE」这类语义：`--direction token_to_space`

### 3. 判断 `--amount-in`

`--amount-in` 永远表示 **输入侧数量**，不是想要得到的数量。

示例：

- 「用 10 SPACE 换 DOGE」 -> `--amount-in "10"`
- 「卖出 500 DOGE 换 SPACE」 -> `--amount-in "500"`

如果用户只说：

- 「我想买点 DOGE」
- 「帮我换成 PIZZA」
- 「我要换 token」

这都缺少输入数量，必须先问清楚，再调用脚本。

### 4. 判断 `--token-symbol`

`--token-symbol` 始终传 **非 `SPACE` 的 token symbol**。

示例：

- `SPACE -> DOGE`：传 `--token-symbol "DOGE"`
- `DOGE -> SPACE`：仍然传 `--token-symbol "DOGE"`

不要把 `SPACE` 传给 `--token-symbol`。

### 5. 判断 `--slippage-percent`

- 用户说了「滑点 0.5%」「滑点 1%」：传对应值
- 用户没提：可以省略此参数，脚本默认按 `1` 处理

## ✅ 参数抽取示例

### 1. 用户只想看报价

**用户自然语言：**
```text
10 SPACE 能换多少 DOGE？
```

**参数抽取：**
- `--action quote`
- `--direction space_to_token`
- `--amount-in "10"`
- `--token-symbol "DOGE"`

**命令：**
```bash
node "$SKILLS_ROOT/metabot-trade-mvcswap/scripts/index.js" \
  --action quote \
  --direction space_to_token \
  --amount-in "10" \
  --token-symbol "DOGE"
```

### 2. 用户要预览交易

**用户自然语言：**
```text
帮我用 5 SPACE 换 PIZZA，滑点 0.5%
```

**参数抽取：**
- `--action preview`
- `--direction space_to_token`
- `--amount-in "5"`
- `--token-symbol "PIZZA"`
- `--slippage-percent "0.5"`

**命令：**
```bash
node "$SKILLS_ROOT/metabot-trade-mvcswap/scripts/index.js" \
  --action preview \
  --direction space_to_token \
  --amount-in "5" \
  --token-symbol "PIZZA" \
  --slippage-percent "0.5"
```

### 3. 用户明确要求立即执行

**用户自然语言：**
```text
确定执行，用 3 SPACE 换 RABBIT，滑点 1%
```

**参数抽取：**
- `--action execute`
- `--direction space_to_token`
- `--amount-in "3"`
- `--token-symbol "RABBIT"`
- `--slippage-percent "1"`

**命令：**
```bash
node "$SKILLS_ROOT/metabot-trade-mvcswap/scripts/index.js" \
  --action execute \
  --direction space_to_token \
  --amount-in "3" \
  --token-symbol "RABBIT" \
  --slippage-percent "1"
```

### 4. 用户卖出 token 换 SPACE

**用户自然语言：**
```text
卖出 2500 PIZZA 换 SPACE，先预览一下
```

**参数抽取：**
- `--action preview`
- `--direction token_to_space`
- `--amount-in "2500"`
- `--token-symbol "PIZZA"`

**命令：**
```bash
node "$SKILLS_ROOT/metabot-trade-mvcswap/scripts/index.js" \
  --action preview \
  --direction token_to_space \
  --amount-in "2500" \
  --token-symbol "PIZZA"
```

## 📤 输出格式 (stdout JSON)

脚本成功运行时，会向 stdout 输出一行 JSON：

```json
{
  "mode": "quote | preview | executed | unsupported",
  "message": "给用户看的多行文本"
}
```

### 常见返回示例

#### 报价结果

```json
{
  "mode": "quote",
  "message": "10 SPACE 的报价如下\n预计收到：1234 DOGE\n最少收到：1221.66 DOGE\n滑点：1%"
}
```

#### 预览结果

```json
{
  "mode": "preview",
  "message": "将用 10 SPACE 兑换 DOGE\n预计收到：1234 DOGE\n最少收到：1221.66 DOGE\n滑点：1%\n如确认执行，请回复：确认交易"
}
```

#### 已执行结果

```json
{
  "mode": "executed",
  "message": "交易已提交\n成交方向：SPACE -> DOGE\n输入：10 SPACE\n预计成交：1234 DOGE\nTxID：<txid>"
}
```

#### 参数不合法或缺失

```json
{
  "mode": "unsupported",
  "message": "Trade request amountIn must be a positive decimal."
}
```

### 退出码与错误

- **退出码 `0`**：脚本成功运行，且 stdout 有 JSON
- **退出码非 `0`**：脚本执行失败，错误信息会写到 stderr

如果 stderr 提示余额不足、找不到交易对、缺少 `IDBOTS_METABOT_ID`、本地 RPC 失败等，直接把错误原因翻译成面向用户的话说明即可，不要自行伪造交易结果。

## ⚠️ AI 行为约束 (Strict Constraints)

1. **不要把自然语言整句直接传给脚本。** 必须先抽参数，再用结构化 CLI 调用。
2. **始终优先调用本技能脚本，不要绕开技能自行拼 mvcswap HTTP 请求。** 脚本已经封装了 pairs、quote、swap args、本地 RPC、raw tx 和提交流程。
3. **不要询问助记词、私钥、seed phrase。** 本技能依赖本地 IDBots RPC 和 MetaBot 身份执行交易。
4. **缺必要参数就先追问。** 如果用户没有明确给出输入数量、方向或目标 token，不要硬猜。
5. **默认先报价或预览，只有在用户明确表达确认语义时才直接执行。**
6. **回复用户时优先使用脚本返回的 `message`。** 不要自己重新计算报价或伪造预计成交量。
7. **脚本路径固定为** `$SKILLS_ROOT/metabot-trade-mvcswap/scripts/index.js`，不要改用临时脚本或 `.ts` 文件。
