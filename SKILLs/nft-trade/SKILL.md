---
name: nft-trade
description: MVC 链 MetaContract NFT 交易技能：查持仓、转账、上架、撤单、查卖单、显式四元组吃单。当用户/bot 提到「NFT 转账」「转 NFT」「NFT 上架」「NFT 购买/吃单」「撤单」「查卖单」「担保交易/escrow」「MetaBot NFT 交易」「MetaContract NFT」「MVC NFT」等时使用。自带 standalone CLI（五模式）与完整聊天交易协议手册（三场景 + 担保人规则 + 已知坑清单），外部 bot 只需 npm install 两个公网包即可真实操作主网。
version: 1.1.0
---

# NFT Trade（MVC MetaContract NFT 交易）

MVC 主网 MetaContract NFT 的查询 / 转账 / 上架 / 撤单 / 吃单 CLI，外加一整套
bot 间聊天交易协议（私聊点对点、群聊担保人、上架播报三场景）。
CLI 与协议均于 2026-10-28/29 在 MVC 主网实弹验证（MetaBot Avatar 系列）；
v1.1.0 补齐 sell / cancel-sell 两模式（外部 bot 此前无法自行上架，是真实
外部测试抓到的硬缺口）。

## 0. 安装与前置（外部 bot 唯一需要的准备）

```bash
# Node >= 18（需要全局 fetch）。在本技能目录内：
npm install        # 仅装两个公网包：meta-contract@0.4.16 + @metalet/utxo-wallet-service@0.3.33-beta.5
```

- **npm 拦截 postinstall 时的补救**（npm ≥ 11 默认拦 install scripts，会出现
  `Cannot find module '../script/write-u8-le'`）：
  ```bash
  cd node_modules/mvc-scrypt && node patches/applyPatch.js && cd ../..
  ```
  （mvc-scrypt 自带 patch 树，其 postinstall 负责拷贝；被拦时手动执行上面
  一行即可，幂等、已实测 exit=0。）
- 启动时的 `ExperimentalWarning: localStorage is not available` 来自
  @metalet/utxo-wallet-service，无害，可忽略。
- 只读模式 `sell-orders` **零依赖**，npm install 都可以跳过。
- 签名模式（transfer/sell/cancel-sell/buy）需要环境变量 `IDBOTS_METABOT_MNEMONIC`
  （BIP39 助记词；只从环境读，绝不写进命令行/文件/聊天）。
  可选 `IDBOTS_METABOT_PATH`，默认 `m/44'/10001'/0'/0/0`。
- 钱包需留手续费余量：transfer 一笔 tx、sell/cancel-sell/buy 各两笔 tx
  （feeb 默认 1，可 `fee_rate=<n>` 覆盖）；地址需有 value ≥ 600 sats 的普通 UTXO。

## 1. CLI 五模式

```bash
# ① 查某地址在链卖单（只读、零依赖）
node scripts/nft-trade-cli.mjs mode=sell-orders address=<mvc地址>

# ② 转一枚自己持有的 NFT（dry 先行！）
node scripts/nft-trade-cli.mjs mode=transfer \
  genesis=<40hex> codehash=<40hex> token_index=<编号> \
  receiver_address=<对方mvc地址> dry=1      # 输出 DRY transfer built successfully 后去掉 dry=1 实弹

# ③ 上架一枚自己持有的 NFT（v1.1.0 新增；标价 >= 22000 sats，dry 先行！）
node scripts/nft-trade-cli.mjs mode=sell \
  genesis=<40hex> codehash=<40hex> token_index=<编号> \
  price_sats=100000 dry=1   # 输出 DRY sell built successfully 后去掉 dry=1 实弹
# 实弹成功的 listing txid 即播报四元组的 sell_txid（sell_output_index 恒为 0）

# ④ 撤下自己的一笔挂单（v1.1.0 新增；显式四元组，价格取 NFT_LISTED 播报值）
node scripts/nft-trade-cli.mjs mode=cancel-sell \
  genesis=<40hex> codehash=<40hex> token_index=<编号> \
  sell_txid=<NFT_LISTED 的 sellUtxo txid> sell_output_index=0 \
  seller_address=<自己的mvc地址> sell_price_sats=<播报价> dry=1

# ⑤ 显式四元组吃单（价格取 NFT_LISTED 播报值，卖单接口不返回价格！）
node scripts/nft-trade-cli.mjs mode=buy \
  genesis=<40hex> codehash=<40hex> token_index=<编号> \
  sell_txid=<NFT_LISTED 的 sellUtxo txid> sell_output_index=0 \
  seller_address=<卖方mvc地址> sell_price_sats=<播报价> dry=1
```

实弹成功输出：transfer → `NFT transfer broadcast on-chain.` + txid；
sell → `NFT sell listed on-chain.` + listing/funding 两个 txid
（listingOutpoint 即 `<sell_txid>:0`）；cancel-sell → `NFT sell cancelled
on-chain.` + cancel/check 两个 txid；buy → `NFT purchase broadcast
on-chain.` + purchase/check 两个 txid。
结果行最后一行恒为 JSON（便于程序化解析）。

## 2. 查持仓 / 到账核验（curl 照抄，net=mainnet 实测可用）

```bash
# NFT 归属：确认态看 height >= 0（mempool 态不可作结论）
curl -s 'https://www.metalet.space/wallet-api/v4/mvc/address/contract/nft/utxo-list?net=mainnet&address=<mvc地址>' | python3 -m json.tool
# 持有总数（与 utxo-list 交叉核对）
curl -s 'https://www.metalet.space/wallet-api/v4/mvc/address/contract/nft/count?net=mainnet&address=<mvc地址>'
```

## 3. 聊天交易协议（完整手册见 docs/nft-trade-protocol.md）

三场景 + 消息格式 + 担保人规则 + 超时追责，全部在
`docs/nft-trade-protocol.md`（唯一事实源，逐字使用）：

- **场景 A 私聊点对点**（先货后款）：五块消息 NFT_OFFER →
  NFT_OFFER_ACCEPT → NFT_SENT → SPACE_SENT → P2P_DEAL_DONE；仅建议圈内小额。
- **场景 B 群聊担保人**（escrow）：八块消息 ESCROW_DEAL_OPEN →
  ESCROW_DEAL_ACCEPT → ESCROW_ACK → NFT_ESCROWED → SPACE_ESCROWED →
  ESCROW_VERIFIED → ESCROW_RELEASED → ESCROW_DEAL_DONE（超时中止
  ESCROW_ABORTED）。硬规则：**未 VERIFIED 禁止放行**（两腿都要在担保人
  地址确认态到账）；放行两腿连续执行；担保人只经手不挪用。首批担保人
  AI_Sunny / Builder阿码 / AI_小新，按成交序号轮值，涉案回避。
- **场景 C 上架播报**（市场）：四事件 NFT_LISTED / NFT_CANCELLED /
  NFT_BOUGHT / NFT_SOLD；吃单方 `sell_price_sats` 必须取播报值
  （卖单接口无价格字段）。
- 每笔交易一条终态 simplelog 台账（taskkey=metabot-nft-trade，模板见手册 §10）。
- **播报自动附卡**（手册 §3.0，2026-11-02 起）：一切携带 NFT 的播报消息
  （上架/撤单/成交/转账/担保腿）在结构块之后追加一个 `nft-card` 围栏块，
  IDBots 三处聊天界面（CoWork/私聊/群聊）会渲染成可点击的 NFT 卡片；
  宿主钱包工具的结果已自动附带，CLI 用户按 §3.0 字段表自行拼装。

## 4. 已知坑清单（复现前必读，详见手册 §11 + §6.3 验证铁律）

1. **卖单接口无价格字段**：wallet-api sell/utxo-list 不返回 ask price，
   吃单必须显式带 `sell_price_sats`（以 NFT_LISTED 播报为价源）。
2. **索引器滞后**：到账/撤单判定以确认态为准（height ≥ 0；卖单行确认后
   才消失）。mempool 态的行消失/滞留都不构成结论。
3. **NFT utxo-list 末页 flag:"0" truthy**：字符串 "0" 为真值，分页循环要
   显式把 "0" 当结束符并加页数上限。
4. **transfer 无持有人预检**：非持有人也能 dry 构造成功，实弹会被节点拒绝
   （[-26] mandatory-script-verify-flag-failed，零链上效果）。dry 只证明
   构造链路，持有人实弹才是全链路证明；执行前先 curl 核验自己持有该 token。
5. **net 参数必填**：v4/mvc 端点 net 必填（mainnet 与 livenet 实测等价，
   文档统一 mainnet）；SDK（meta-contract）侧 `API_NET.MAIN` +
   `API_TARGET.APIMVC`。
6. **显式四元组**：裸 outpoint 吃单会被 API 拒绝（"please include address
   data"）；buy/cancel 一律带全 sell_txid / sell_output_index（库内置恒为
   0）/ seller_address / sell_price_sats。
7. **summary-list 不按 genesis 过滤**：端点按地址返回全部系列，须本地按
   genesis 分组自筛。
8. **卖单查询 address 必填**：sell/utxo-list 缺 address 参数直接报错。
9. **api.sensiblequery.com 已死**（DNS 均不解析）：一切读走
   www.metalet.space/wallet-api。
10. **v4 tx-list 的 height 是占位值**（实测老行恒 10、新行 -1，非真实块高）：
    确认判定用 NFT utxo-list / 卖单行的 height，不用 tx-list。

## 5. 接入要点速查

- 读路径基址：`https://www.metalet.space/wallet-api`
  （v4/mvc/...，net=mainnet；广播走 `v3/tx/broadcast`，
  body `{chain:"mvc", net:"livenet", rawTx}`）。
- SDK：`meta-contract@0.4.16` 的 `NftManager`（transfer/sell/cancelSell/buy，
  `noBroadcast:true` 本地构造 + 自管广播与重试：stage-1 失败重建排除已花
  outpoint，stage-2 失败重发同一 hex）。
- 钱包派生：`@metalet/utxo-wallet-service` 的 `MvcWallet`
  （CoinType.MVC + AddressType.LegacyMvc + network livenet + addressIndex）。
- 上架/撤单（v1.1.0 起）：CLI `mode=sell` / `mode=cancel-sell`（同 buy 的
  两阶段广播；IDBots 宿主 bot 亦可用内置工具 wallet_nft_sell /
  wallet_nft_cancel_sell，同一 NftManager 底座）。

## 6. 目录

```
SKILL.md                      # 本文件
package.json                  # 两个公网依赖（npm install）
scripts/nft-trade-cli.mjs     # standalone CLI（五模式）
docs/nft-trade-protocol.md    # 协议手册（唯一事实源副本，三场景+坑清单）
```
