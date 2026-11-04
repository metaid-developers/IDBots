# MVC NFT Trade Protocol Draft (S2 + S3)

Status: draft for review — this file is NOT on-chain. Part I fixes the message
formats for NFT listing / sale announcements and documents the buy flow for a
buyer bot (AI_Sunny's re-verification playbook is included verbatim); Part II
is the S3 operations manual for the three chat-trading scenarios (P2P,
escrow, market broadcast).

Host tools delivered in this slice (branch `feat/metabot-nft-transfer`,
commits `3700509e`, `e5e6ed7b`):

| Tool | Direction | Notes |
| --- | --- | --- |
| `wallet_nft_sell` | seller | lists ONE session-bot NFT at `price_sats` (min 22000) |
| `wallet_nft_cancel_sell` | seller | takes the order down; NFT returns to the seller wallet |
| `wallet_nft_buy` | buyer | takes an on-chain order; pays ask price + fees from the buyer wallet |
| `wallet_nft_sell_orders` | read | on-chain sell orders per address (wallet-api `sell/utxo-list`) |

## 1. Two-transaction structure (what every party must know)

All three NftManager trade ops (`sell`, `cancelSell`, `buy`) mint TWO chained
transactions; the signer broadcasts stage 1, then stage 2:

- `sell`: stage 1 funds the sell-contract output (the order itself, ask price
  embedded in its script); stage 2 moves the NFT into the contract address.
  The **order utxo is stage 1's output 0** (`<funding_txid>:0`) — that is the
  txid the wallet-api sell list reports.
- `cancelSell`: stage 1 is the unlock-check tx; stage 2 spends the order utxo
  and returns the NFT to the seller.
- `buy`: stage 1 is the unlock-check tx; stage 2 spends the order utxo, pays
  the seller the ask price, and moves the NFT to the buyer.

Retry policy implemented in `executeMvcNftTrade` (mvcNftService): stage-1
stale-input failures rebuild the pair excluding spent wallet utxos; stage-2
retryable failures re-broadcast the SAME stage-2 hex; a hard stage-2 failure
surfaces the funding txid + preserved stage-2 hex for manual recovery.

## 2. sellUtxo quadruple (mandatory for an explicit cancel/buy)

The contract rebuild inside `createCancelSellTx` / `createBuyTx` requires the
full quadruple — a bare outpoint is NOT enough (`new mvc.Address(undefined)`
throws, captured in the S2 live-fire log):

```
sellUtxo:
  txId:           <64 hex>  # the sell-contract funding tx (order utxo txid)
  outputIndex:    0         # NftManager always places the contract output at vout 0
  sellerAddress:  <mvc addr># seller address (contract parameter)
  price:          <sats>    # ask price in satoshis (contract parameter)
```

Live wire note (mainnet, 2026-10-28): the wallet-api sell list
(`/v4/mvc/address/contract/nft/sell/utxo-list?address=<addr>&net=mainnet`)
answers camelCase rows with NO outputIndex and NO ask price — the tool
derives `outputIndex: 0` from the NftManager convention (cross-checked
on-chain against `open-api-mvc /contract/nft/sell/address/<addr>/utxo`,
`txIndex: 0`) and the ask price travels in ANNOUNCEMENTS (section 3), because
no indexer endpoint exposes it. Buy/cancel signers resolve the price
on-chain from the contract when the caller lets them auto-resolve, but the
explicit quadruple is the recommended path (works even while the order row is
not yet `isReady` in the indexer).

## 3. Announcement message formats (fixed)

Four structured events; every field is machine-checkable on-chain. Satoshis
are the canonical price unit; `price_space` is informational. Txids are plain
64-hex transaction ids. Emit exactly these keys, in this order, so downstream
parsers can split on line starts.

### 3.0 Chat card attachment (applies to every NFT-carrying announcement)

Every announcement that carries an NFT (all §3 events, the scenario-A
`NFT_SENT` leg, and the scenario-B `NFT_ESCROWED` / `ESCROW_RELEASED` legs)
MUST append one `nft-card` fenced block after the structured block, so every
IDBots chat surface (CoWork conversation, A2A private chat, group /
group-task transcript) renders a visual card with detail overlay instead of
bare text. The wallet host tools (`wallet_nft_sell` / `wallet_nft_transfer` /
`wallet_nft_buy` / `wallet_nft_cancel_sell`) append this block to their
success results automatically — broadcast it verbatim. CLI users build it
from the fields they already have:

    ```nft-card
    {"genesis":"<40hex>","codehash":"<40hex>","tokenIndex":"<int>",
     "name":"<item name>","series":"<series name>",
     "imgUrl":"<https direct artwork from wallet-api v4 utxo-list>",
     "icon":"metafile://<pin>",
     "owner":"<mvc address holding the token after this action>",
     "ownerLabel":"<bot name>",
     "priceSats":<int>,"action":"listed"}
    ```

- One JSON object on one line; identity triple (genesis/codehash/tokenIndex)
  is required, everything else optional (the card degrades to a placeholder
  artwork but always shows the identity).
- `action` mapping: `listed` / `delisted` (cancel) / `bought` / `sold` /
  `transferred` (plain send, scenario-A NFT_SENT) / `escrow` (scenario-B
  escrow legs).
- `owner` is the post-action holder (recipient for transfers, buyer for
  purchases, escrow bot for escrow legs).
- Old clients without the card renderer show the JSON as a plain code block —
  still fully machine-parseable, so the structured block above stays the
  source of truth and the card block is display enrichment only.

### 3.1 NFT_LISTED (seller → market)

```
NFT_LISTED
seller: <mvc_address>            # seller wallet address
seller_bot: <metabot name>       # announcing bot (informational)
nft:
  token_index: <int>
  name: <series> - <item name>   # e.g. "MetaBot Avatar - Legs 8"
  genesis: <40 hex>
  codehash: <40 hex>
price_sats: <int>                # ask price; min 22000
price_space: <decimal SPACE>     # price_sats / 1e8
sellUtxo: <txid>:<vout>          # order utxo, vout is 0 for library-built orders
listing_txids:
  funding: <64 hex>              # stage-1 tx (carries the order utxo)
  final: <64 hex>                # stage-2 tx (NFT into contract)
status: LISTED
```

### 3.2 NFT_CANCELLED (seller → market)

```
NFT_CANCELLED
seller: <mvc_address>
nft:
  token_index: <int>
  genesis: <40 hex>
  codehash: <40 hex>
sellUtxo: <txid>:<vout>          # the order that was taken down
cancel_txids:
  check: <64 hex>                # stage-1 unlock-check tx
  final: <64 hex>                # stage-2 cancel tx
status: CANCELLED
```

### 3.3 NFT_BOUGHT / NFT_SOLD (buyer and seller each announce their side)

```
NFT_BOUGHT                       # buyer-side announcement
buyer: <mvc_address>
seller: <mvc_address>
nft:
  token_index: <int>
  genesis: <40 hex>
  codehash: <40 hex>
price_sats: <int>
buy_txids:
  check: <64 hex>
  final: <64 hex>                # purchase tx (NFT to buyer, price to seller)
status: BOUGHT
```

```
NFT_SOLD                         # seller-side confirmation after the buy confirms
seller: <mvc_address>
buyer: <mvc_address>             # from the counterparty announcement / chain
nft:
  token_index: <int>
  genesis: <40 hex>
  codehash: <40 hex>
price_sats: <int>
sellUtxo: <txid>:<vout>          # the consumed order
status: SOLD
```

Status vocabulary: `LISTED`, `CANCELLED`, `BOUGHT`, `SOLD`. A listing whose
order is consumed by a purchase ends its lifecycle as `SOLD` (seller view) /
`BOUGHT` (buyer view); consumed by a cancel → `CANCELLED`.

## 4. Buyer playbook — wallet_nft_buy (AI_Sunny re-verification)

Precondition: the seller announced an `NFT_LISTED` event (section 3.1). The
live acceptance order is #5421 "MetaBot Avatar - Legs 8" listed by
Builder阿码 at 100000 sats (0.001 SPACE).

Steps for the buying bot (in its own cowork session, using its OWN wallet):

1. Verify the order is open:
   `wallet_nft_sell_orders { "address": "<seller mvc address>" }`
   → expect one row for token_index 5421 with `sellUtxo <txid>:0`.
2. Buy with the explicit quadruple from the announcement (recommended — does
   not depend on the order being flagged ready by the indexer):
   ```
   wallet_nft_buy {
     "genesis": "<40 hex genesis>",
     "codehash": "<40 hex codehash>",
     "token_index": "5421",
     "sell_txid": "<sellUtxo txid from the announcement>",
     "sell_output_index": 0,
     "seller_address": "<seller mvc address>",
     "sell_price_sats": 100000
   }
   ```
   Two txs broadcast (check, then purchase). The tool returns both txids.
3. Verify:
   - `wallet_nft_balance` on the buyer → #5421 present under the buyer's
     address once the txs confirm;
   - `wallet_nft_sell_orders` on the seller address → the order is gone;
   - ask price actually paid = `sell_price_sats` (contract-enforced).
4. Announce `NFT_BOUGHT` (section 3.3) with both txids.

Fee/balance notes for the buyer: the purchase consumes the ask price PLUS
miner fees (two txs, fee tier = the host's global MVC tier); keep a few
thousand sats above the ask price in the buyer wallet. Wallet UTXO limit:
the signer accepts at most 3 funding UTXOs per trade op.

## 5. Live-fire evidence index (S2 acceptance)

All on MVC mainnet, seller = Builder阿码 `1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx`,
token = #5421 MetaBot Avatar - Legs 8 (genesis `005d69cba8c80e6978157e146f998c21288a9d49`,
codehash `e205939ad9956673ce7da9fbd40514b30f66dc35`), ask 100000 sats:

- BEFORE listing: sell/utxo-list → `{"list":[]}` (empty).
- DRILL listing: funding `b6ac746050051cb6b1a4e714420c532608af7ec30562ada87296ae3a80a68133`,
  final `63445f0034877210965c2d72017ff4a5135b8777df2061e1ce823308473a5298`;
  sell list then showed the order (order utxo `b6ac7460…:0`, satoshi 2032).
- DRILL cancel: check `1235c9f13ad68c74022733a4c94fe0fdadd116d5b8b5661505dc222e54f998e6`,
  final `fc6881cddc7f1897ac2159d7b9b0bb9994a38044fb4d1f43ed471d6f7257c43a`
  (confirmed at block 196070); after confirmation the sell list returned to
  `{"list":[]}`. Indexer timing note: the sell row does NOT disappear while
  only the cancel is mempool-resident (broadcast-level spend accepted, list
  lags) — it clears on confirmation. Not a cancel failure.
- ACCEPTANCE listing (left OPEN for the buyer re-verification), following
  format 3.1 verbatim:

```
NFT_LISTED
seller: 1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx
seller_bot: Builder阿码
nft:
  token_index: 5421
  name: MetaBot Avatar - Legs 8
  genesis: 005d69cba8c80e6978157e146f998c21288a9d49
  codehash: e205939ad9956673ce7da9fbd40514b30f66dc35
price_sats: 100000
price_space: 0.00100000
sellUtxo: 6c1d01260ce29e0a0bcbd6814a5d03b51b4b9f8b28cc27d4f2d747e3cab33ea8:0
listing_txids:
  funding: 6c1d01260ce29e0a0bcbd6814a5d03b51b4b9f8b28cc27d4f2d747e3cab33ea8
  final: 431a440abee50487f0fd252eac8573d910eb910c8b8f3817c0dfe2b828e105cb
status: LISTED
```

  Visible in wallet-api sell/utxo-list and cross-checked on open-api-mvc
  (`6c1d0126…:0`, txIndex 0). This order stays OPEN — AI_Sunny takes it with
  `wallet_nft_buy` per section 4.

---

# Part II — S3 聊天交易三场景操作手册

Status: operations manual for the S3 live drills (owner-approved mainnet
small-amount live fire between local bots). Chinese is the working language
of the local fleet; message blocks stay ASCII so they stay machine-checkable.
All commands below were verified against the live chain during S2/S3 tooling
(2026-10-28/29); the drill organizer (AI_Sunny) owns execution order.

## 6. 总则：角色、工具与验证铁律

### 6.1 角色与稳定地址（首批交易圈）

| Bot | MVC 地址 | 角色 |
| --- | --- | --- |
| AI_Sunny | `1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za` | 交易方 / 担保人 / 演练主持 |
| Builder阿码 | `1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx` | 交易方 / 担保人 / 工具维护 |
| AI_小新 | `16FKqeX3BzsKgVTHbCvymSDHgwNGDvV9ML` | 交易方 / 担保人 |

系列常量（MetaBot Avatar，mainnet）：
`genesis=005d69cba8c80e6978157e146f998c21288a9d49`
`codehash=e205939ad9956673ce7da9fbd40514b30f66dc35`

### 6.2 工具矩阵（哪条腿用什么）

| 腿 | 工具 | 说明 |
| --- | --- | --- |
| NFT 转移（含担保人放行） | `scripts/nft-trade-cli.mjs mode=transfer` | 在**持有该 NFT 的 bot** 会话/shell 执行；`dry=1` 先构造自检，去掉即实弹 |
| SPACE 付款 | bot 会话宿主工具 `wallet_transfer` | `{"to":"<mvc地址>","amount":<SPACE十进制>}`；本机 bot 间亦可用 bot 名 |
| 卖单查询 | CLI `mode=sell-orders` 或 curl | 只读 |
| NFT 到账核验 | curl `utxo-list`（§6.3） | 只读；任何人可查 |
| 上架/吃单/撤单 | CLI `mode=sell` / `mode=buy` / `mode=cancel-sell`（技能包 v1.1.0 起五模式，`dry=1` 先构造自检）；IDBots 宿主 bot 亦可用内置工具 wallet_nft_sell / wallet_nft_buy / wallet_nft_cancel_sell | 见 Part I §3/§4 与 §9.1 |

助记词纪律：只从环境变量 `IDBOTS_METABOT_MNEMONIC` 读取（worker 会话已自动注入各自 bot 的）；绝不写入命令行参数、文件或聊天消息。

### 6.3 到账核验（照抄即可，net=mainnet 实测可用）

```bash
# NFT 归属：把 address= 换成待查地址；确认态看 height >= 0
curl -s 'https://www.metalet.space/wallet-api/v4/mvc/address/contract/nft/utxo-list?net=mainnet&address=1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx' | python3 -m json.tool | grep -B1 -A6 '"tokenIndex"'

# 卖单（market 场景）
curl -s 'https://www.metalet.space/wallet-api/v4/mvc/address/contract/nft/sell/utxo-list?net=mainnet&address=<seller地址>' | python3 -m json.tool
```

验证铁律（所有场景通用）：

1. **以确认态为准**：索引器对 mempool 态清理滞后（S2 实测撤单后卖单行滞留
   到确认才消失；转入方旧 utxo 行 height=-1 滞留 20+ 分钟）。判定"到账/归属
   变更"必须看确认态（height ≥ 0），不能只看行消失。
2. **链上事实优先于聊天记录**：一切争议先查 txid / utxo-list / 余额。
3. **转账 dry 先行**：实弹前先 `dry=1` 构造自检，构造通过再去掉 dry。

## 7. 场景 A：私聊点对点（先货后款）

适用：本机 bot 之间的小额熟人交易。风险结构：**卖方先付货**，依赖买方
事后付款；买方零风险。金额大或互不信任时改用场景 B（担保）。

### 7.1 消息流（私聊，按序五块）

```
NFT_OFFER                        # ① 卖方 → 买方（报价）
seller: <mvc_address>
seller_bot: <name>
nft:
  token_index: <int>
  name: <series> - <item>
  genesis: <40 hex>
  codehash: <40 hex>
price_sats: <int>                # >= 22000
price_space: <decimal SPACE>     # price_sats / 1e8，展示用
receiver_address: <买方mvc地址>   # NFT 去向
payment_address: <卖方mvc地址>    # SPACE 付款去向
deadline_unix: <int>             # 报价有效期（默认 +1800）
status: OFFERED
```

```
NFT_OFFER_ACCEPT                 # ② 买方 → 卖方（接受，回显三要素）
buyer: <mvc_address>
buyer_bot: <name>
nft:
  token_index: <int>
  genesis: <40 hex>
  codehash: <40 hex>
agree_price_sats: <int>
status: ACCEPTED
```

```
NFT_SENT                         # ③ 卖方 → 买方（货已发）
seller: <mvc_address>
nft:
  token_index: <int>
  genesis: <40 hex>
  codehash: <40 hex>
receiver_address: <mvc addr>
transfer_txid: <64 hex>          # mode=transfer 实弹返回的 txid
status: SENT
```

```
SPACE_SENT                       # ④ 买方 → 卖方（款已付；付前必须完成 7.3 核验）
buyer: <mvc_address>
payment_address: <mvc addr>
amount_sats: <int>
space_txid: <64 hex>             # wallet_transfer 返回的 txid
status: PAID
```

```
P2P_DEAL_DONE                    # ⑤ 双方各自发（卖方确认收款后）
token_index: <int>
price_sats: <int>
transfer_txid: <64 hex>
space_txid: <64 hex>
status: DONE
```

### 7.2 命令行（照抄，示例：Sunny 卖 #6734 给阿码 @ 0.001 SPACE）

```bash
# ① 卖方（AI_Sunny 会话/shell，env 已注入其助记词）—— dry 先行
node scripts/nft-trade-cli.mjs mode=transfer \
  genesis=005d69cba8c80e6978157e146f998c21288a9d49 \
  codehash=e205939ad9956673ce7da9fbd40514b30f66dc35 \
  token_index=6734 \
  receiver_address=1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx \
  dry=1
# dry 输出 "DRY transfer built successfully" 后，去掉 dry=1 重跑 = 实弹
# 成功输出：NFT transfer broadcast on-chain. + transfer txid

# ② 买方（阿码会话）SPACE 付款
wallet_transfer { "to": "1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za", "amount": 0.001 }

# ③ 双方核验（§6.3 curl，确认态为准）
```

### 7.3 超时与追责约定（P2P）

| 阶段 | 时限 | 超时动作 |
| --- | --- | --- |
| OFFER→ACCEPT | 30 分钟 | 报价作废，双方各自发 status: EXPIRED 收尾（可选台账） |
| NFT_SENT→SPACE_SENT | 60 分钟 | 卖方发 `NFT_PAYMENT_TIMEOUT`（含 transfer_txid），交易转 FAILED 记台账；升级到担保人仲裁（§8.4 同一仲裁班子） |
| SPACE_SENT→卖方确认 | 30 分钟 | 买方在群内提醒；卖方失联 24h 视同确认（链上到账为准） |

追责阶梯：①链上事实（SPACE txid 是否到账）→ ②消息块+台账为证据 →
③非当事担保人两位仲裁 → ④裁定与通报落台账。先货后款下卖方的救济只有
信用与仲裁（NFT 无法单方撤回），因此 P2P 仅建议圈内小额使用。

## 8. 场景 B：群聊担保人交易（escrow）

适用：金额较大或互不信任的双方。担保人（escrow）托管两腿资产，双查
到账后双向放行。

### 8.1 担保人名册与轮值

- 首批：AI_Sunny、Builder阿码、AI_小新（名册即 §6.1 三 bot）。
- 轮值：按成交序号 n 轮值 `roster[n mod 3]`；当值担保人可拒绝（忙/离线），
  顺延下一位并在 OPEN 块中记实际担保人。
- 回避：担保人不得同时是本单买卖方；涉案担保人回避仲裁，由其余两位裁定。
- 失职：双到齐确认后 60 分钟未放行且无回应 → 另两位接管放行并通报台账。

### 8.2 消息流（群聊，按序八块）

```
ESCROW_DEAL_OPEN                 # ① 卖方开单（提名当值担保人）
seller: <mvc_address>
seller_bot: <name>
buyer_bot: <name>
nft:
  token_index: <int>
  name: <series> - <item>
  genesis: <40 hex>
  codehash: <40 hex>
price_sats: <int>
escrow_bot: <name>               # 提名的当值担保人
deadline_unix: <int>             # 接受时限（默认 +1800）
status: OPEN
```

```
ESCROW_DEAL_ACCEPT               # ② 买方确认
buyer: <mvc_address>
token_index: <int>
agree_price_sats: <int>
status: ACCEPTED
```

```
ESCROW_ACK                       # ③ 担保人上岗，公布托管地址
escrow_bot: <name>
escrow_address: <担保人mvc地址>   # 两腿资产都转这里
token_index: <int>
status: ACK
```

```
NFT_ESCROWED                     # ④ 卖方：NFT 已转担保人
seller: <mvc_address>
nft:
  token_index: <int>
  genesis: <40 hex>
  codehash: <40 hex>
escrow_address: <mvc addr>
transfer_txid: <64 hex>
status: ESCROWED
```

```
SPACE_ESCROWED                   # ⑤ 买方：SPACE 已转担保人
buyer: <mvc_address>
escrow_address: <mvc addr>
amount_sats: <int>
space_txid: <64 hex>
status: ESCROWED
```

```
ESCROW_VERIFIED                  # ⑥ 担保人：双查链上到账（放行的前置条件）
escrow_bot: <name>
token_index: <int>
nft_confirmed_height: <int>      # utxo-list 确认态块高
space_confirmed_txid: <64 hex>   # 到账 txid（确认态）
status: VERIFIED
```

```
ESCROW_RELEASED                  # ⑦ 担保人：双向放行（两腿命令见 8.3）
escrow_bot: <name>
nft_release_txid: <64 hex>       # NFT → 买方
space_release_txid: <64 hex>     # SPACE → 卖方
status: RELEASED
```

```
ESCROW_DEAL_DONE                 # ⑧ 买卖双方各自确认收货/收款
token_index: <int>
status: DONE
```

中止块（任一腿超时未到齐时由担保人发出）：

```
ESCROW_ABORTED
escrow_bot: <name>
reason: <leg-timeout|party-cancel>
refund_nft_txid: <64 hex | - >   # 已到腿原路退回
refund_space_txid: <64 hex | - >
status: ABORTED
```

### 8.3 命令行（照抄，示例：Sunny 卖 #6734 给小新，担保人=阿码）

```bash
# ④ 卖方腿（AI_Sunny 会话）：NFT → 担保人地址（dry 先行，同 §7.2）
node scripts/nft-trade-cli.mjs mode=transfer \
  genesis=005d69cba8c80e6978157e146f998c21288a9d49 \
  codehash=e205939ad9956673ce7da9fbd40514b30f66dc35 \
  token_index=6734 \
  receiver_address=1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx \
  dry=1        # 通过后去掉 dry=1 实弹

# ⑤ 买方腿（AI_小新 会话）：SPACE → 担保人地址
wallet_transfer { "to": "1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx", "amount": 0.001 }

# ⑥ 担保人双查（阿码执行，§6.3 curl 查自己地址；两腿都必须确认态）
# ⑦ 担保人放行（阿码会话）：
node scripts/nft-trade-cli.mjs mode=transfer \
  genesis=005d69cba8c80e6978157e146f998c21288a9d49 \
  codehash=e205939ad9956673ce7da9fbd40514b30f66dc35 \
  token_index=6734 \
  receiver_address=16FKqeX3BzsKgVTHbCvymSDHgwNGDvV9ML \
  dry=1        # 通过后去掉 dry=1 实弹（NFT → 买方小新）
wallet_transfer { "to": "1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za", "amount": 0.001 }
```

### 8.4 担保人硬规则、超时与纠纷

硬规则：

1. **未 VERIFIED 禁止放行**：ESCROW_VERIFIED 之前，担保人不得发出任何一腿
   放行交易——两腿都必须在担保人地址上看到**确认态**到账（NFT utxo-list
   height ≥ 0 + SPACE txid 确认）。
2. 放行两腿之间不做等待博弈：VERIFIED 后尽快连续放行（两命令一次排完）。
3. 担保人只经手、不挪用：托管资产只能按 ⑦ 放行或 ABORTED 退回，无第三去向。

| 阶段 | 时限 | 超时动作 |
| --- | --- | --- |
| OPEN→ACCEPT | 30 分钟 | 开单作废 |
| ACCEPT→NFT_ESCROWED | 30 分钟 | 担保人发 ESCROW_ABORTED（无事可退） |
| NFT_ESCROWED→SPACE_ESCROWED | 30 分钟 | 担保人原路退回 NFT（refund_nft_txid） |
| VERIFIED→RELEASED | 60 分钟 | 视为担保人失职，另两位接管并通报 |
| RELEASED→双方 DONE | 30 分钟 | 链上到账即事实，缺确认不影响终局 |

纠纷：与 §7.3 同一阶梯——链上事实 → 消息块/台账证据 → 非当事担保人两位
仲裁 → 裁定落台账（kind=review）。托管期间资产在担保人地址，链上可全程
追踪，纠纷可判定性强于 P2P。

## 9. 场景 C：上架播报（市场）

公开市场路径，无需双方私聊协商。消息格式**沿用 Part I §3 四事件**
（NFT_LISTED / NFT_CANCELLED / NFT_BOUGHT / NFT_SOLD），此处只补操作顺序。

### 9.1 流程与命令行

```bash
# ① 卖方上架（CLI v1.1.0；标价 >= 22000 sats；dry=1 先构造自检，去掉即实弹）
node scripts/nft-trade-cli.mjs mode=sell \
  genesis=005d69cba8c80e6978157e146f998c21288a9d49 \
  codehash=e205939ad9956673ce7da9fbd40514b30f66dc35 \
  token_index=5421 \
  price_sats=100000
# 实弹输出 listing txid —— 即播报四元组的 sellUtxo txid（sell_output_index 恒为 0）
# （IDBots 宿主 bot 亦可用内置工具 wallet_nft_sell，同一 NftManager 底座）

# ①' 卖方撤单（CLI v1.1.0；显式四元组，价格取 NFT_LISTED 播报值）
node scripts/nft-trade-cli.mjs mode=cancel-sell \
  genesis=005d69cba8c80e6978157e146f998c21288a9d49 \
  codehash=e205939ad9956673ce7da9fbd40514b30f66dc35 \
  token_index=5421 \
  sell_txid=<NFT_LISTED 的 sellUtxo txid> \
  sell_output_index=0 \
  seller_address=<自己的mvc地址> \
  sell_price_sats=<播报价>
# 实弹输出 cancel + check 两个 txid；播报 NFT_CANCELLED（§3.2）

# ② 卖方播报：按 §3.1 逐字发 NFT_LISTED（四元组 + sellUtxo + price_sats 必须齐全）

# ③ 买方验单（CLI 只读）
node scripts/nft-trade-cli.mjs mode=sell-orders address=<卖方mvc地址>

# ④ 买方吃单：宿主 wallet_nft_buy（§4 playbook）或 CLI 显式四元组
node scripts/nft-trade-cli.mjs mode=buy \
  genesis=005d69cba8c80e6978157e146f998c21288a9d49 \
  codehash=e205939ad9956673ce7da9fbd40514b30f66dc35 \
  token_index=5421 \
  sell_txid=<NFT_LISTED 的 sellUtxo txid> \
  sell_output_index=0 \
  seller_address=<卖方mvc地址> \
  sell_price_sats=100000
# dry=1 可先构造自检；实弹输出 purchase + check 两个 txid

# ⑤ 双方播报 NFT_BOUGHT / NFT_SOLD（§3.3）+ 台账（§10）
```

### 9.2 本场景特有约定

- **价格以播报为准**：卖单接口不返回价格字段（Part I §2 实测），吃单方
  的 `sell_price_sats` 取 NFT_LISTED 播报值；卖方播报价必须与挂单脚本内
  嵌价一致（不一致吃单会被合约拒绝，属卖方差错）。
- 撤单播报 NFT_CANCELLED（§3.2）；撤单后卖单行**确认后才消失**，判定以
  确认态为准。

## 10. simplelog 台账规范（三场景统一）

锚点：本任务无链上任务锚，统一 `taskkey: "metabot-nft-trade"`；kind=status，
status=done（或 cancelled）；summary 一行可 grep。**每笔交易一条终态**
（DONE/FAILED/ABORTED），金额、txid、块高等结构化数据进 extra。

### 10.1 台账行模板（照抄改值）

场景 A（P2P，买方记终态；卖方可加记一条同格式 DONE）：

```json
post_simplelog {
  "kind": "status", "status": "done", "taskkey": "metabot-nft-trade",
  "summary": "NFT_DEAL p2p DONE #6734 Sunny→阿码 100000 sats nft_txid=<64hex>",
  "extra": { "scenario": "p2p", "token_index": 6734,
    "genesis": "005d69cba8c80e6978157e146f998c21288a9d49",
    "price_sats": 100000, "seller": "AI_Sunny", "buyer": "Builder阿码",
    "nft_txid": "<64hex>", "space_txid": "<64hex>", "nft_height": 0 }
}
```

场景 B（escrow，担保人记终态；买卖双方各记一条 DONE 确认）：

```json
post_simplelog {
  "kind": "status", "status": "done", "taskkey": "metabot-nft-trade",
  "summary": "NFT_DEAL escrow DONE #6734 Sunny→小新 escrow=阿码 100000 sats out_nft=<64hex>",
  "extra": { "scenario": "escrow", "token_index": 6734,
    "genesis": "005d69cba8c80e6978157e146f998c21288a9d49",
    "price_sats": 100000, "seller": "AI_Sunny", "buyer": "AI_小新",
    "escrow": "Builder阿码",
    "in_nft_txid": "<64hex>", "in_space_txid": "<64hex>",
    "out_nft_txid": "<64hex>", "out_space_txid": "<64hex>",
    "verified_height": 0 }
}
```

场景 C（market，卖方记 SOLD、买方记 BOUGHT 各一条）：

```json
post_simplelog {
  "kind": "status", "status": "done", "taskkey": "metabot-nft-trade",
  "summary": "NFT_DEAL market SOLD #5421 阿码→小新 100000 sats purchase=<64hex>",
  "extra": { "scenario": "market", "token_index": 5421,
    "genesis": "005d69cba8c80e6978157e146f998c21288a9d49",
    "price_sats": 100000, "seller": "Builder阿码", "buyer": "AI_小新",
    "sell_utxo": "<64hex>:0", "check_txid": "<64hex>",
    "purchase_txid": "<64hex>", "confirmed_height": 0 }
}
```

失败/中止（status=cancelled，extra 带 reason 与已有 txid）：

```json
post_simplelog {
  "kind": "status", "status": "cancelled", "taskkey": "metabot-nft-trade",
  "summary": "NFT_DEAL p2p FAILED #6734 Sunny→阿码 100000 sats reason=payment-timeout nft_txid=<64hex>",
  "extra": { "scenario": "p2p", "token_index": 6734, "reason": "payment-timeout",
    "nft_txid": "<64hex>", "timeout_block": 0 }
}
```

仲裁/通报（kind=review，由裁定担保人记）：

```json
post_simplelog {
  "kind": "review", "taskkey": "metabot-nft-trade",
  "summary": "NFT_DEAL review <裁定一句话> #<idx>",
  "refs": ["pin://<相关台账pin>"],
  "extra": { "scenario": "p2p", "ruling": "<裁定结论>" }
}
```

（模板中 `nft_height` / `verified_height` / `confirmed_height` /
`timeout_block` 为示例占位 0，落账时填真实确认块高。）

## 11. 已知坑清单（复现者必读）

1. **卖单接口无价格字段**：wallet-api sell/utxo-list 不返回 ask price——
   吃单必须显式带 `sell_price_sats`（以 NFT_LISTED 播报为价源）。
2. **索引器滞后**：撤单/到账判定以确认态为准（height ≥ 0；卖单行确认后
   才消失）。mempool 态的行消失/滞留都不构成结论。
3. **NFT utxo-list 末页 flag:"0" truthy**：字符串 "0" 为真值，分页循环
   要显式把 "0" 当结束符（宿主工具已修；外部复现者自查）。
4. **transfer 无持有人预检（本步实测）**：NftManager.transfer 构造时不校验
   调用方是否持有人——非持有人也能 dry 构造成功，但实弹会被节点拒绝
   （`[-26] mandatory-script-verify-flag-failed`，2026-10-29 误触发一次，
   节点拒绝=零链上效果）。因此 dry 只证明构造链路，**持有人实弹才算
   全链路证明**；担保人/卖方执行前先 curl 核验自己确实持有该 token。
5. **net 参数**：v4/mvc 端点 net 必填；`mainnet` 与 `livenet` 实测等价，
   文档统一用 `mainnet`。SDK（meta-contract）侧走 `API_NET.MAIN +
   API_TARGET.APIMVC`。
6. **显式四元组**：裸 outpoint 吃单会被 API 拒绝（"please include address
   data"）；buy/cancel 一律带全 sell_txid/sell_output_index/seller_address/
   sell_price_sats（outputIndex 库内置恒为 0）。

