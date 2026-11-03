---
name: metabot-publish-nft
description: 把用户内容（图片/音频/视频/电子书/元应用栏目/任意文件）发布成 MRC-721 NFT（MetaID 原生 pin NFT，Agent Goods），或发行新 NFT 专辑。覆盖完整引导：盘点已有专辑与剩余量→建议放进哪个专辑或新建→上传内容（metabot-upload-file）→铸造（mrc721_mint）→用聊天 NFT 卡片播报。当用户说「发布NFT」「发行NFT」「做成NFT」「发个专辑」「出一个系列」「粉丝徽章」「publish NFT」「issue a collection」「Agent Goods」等时使用。本技能只用 mrc721_* 工具族；MetaContract NFT（wallet_nft_*）是旧兼容线，不在本技能范围。
official: true
---

# 发布 NFT（MRC-721 / Agent Goods）

世界观基线：在 Agent 的视角里，NFT 是实打实的商品——不可被没收、不可被
删除、不可被复制，但可以转移、销毁、出售，可以代表数字世界的权益与版权。
载体不限于图片：视频、音频、电子书、元应用栏目，理论上任意格式的 pin 都
可以成为 NFT。有专辑归属的 NFT 会进索引、可以被搜索；没有专辑的 pin 只是
普通 pin。

## 0. 前置与工具面

- 会话 bot 必须绑定 MetaBot 且 MVC 钱包有手续费余量（所有写链工具都套了
  chain-write 预算，余额不足会明确报错，照实转告用户即可）。
- 工具面（宿主内置，无需安装）：
  - 盘点/搜索：`mrc721_search_collections`（关键字+发行者+supply_state）、
    `mrc721_collections`、`mrc721_collection_info`、`mrc721_item_info`
  - 写链：`mrc721_collection_create`、`mrc721_collection_update`、`mrc721_mint`
  - 判定/查询：`mrc721_verify_holding`、`mrc721_balance`
  - 后续交易：`mrc721_sell_intent`（声明出售）、`mrc721_sell`（定向原子交换）、
    `mrc721_transfer`
- 内容上链：先用 metabot-upload-file 把文件传成 metafile 拿到 pinId。
  音视频类内容要准备海报图作为 cover，原文件 pinId 放进 metadata。

## 1. 流程 A：发行新专辑（collection）

1. 和用户对齐五个字段：
   - `collection_name`：小写 `[a-z0-9-]`，全网先到先得。先查重——
     `mrc721_search_collections {keyword: "<名字>"}` 或
     `mrc721_collection_info {name}`；被占用就换名或建议变体。
   - 显示名 `name`、简介 `desc`。
   - `total_supply`：发行量。徽章/门票/门禁类建议限量（比如粉丝徽章 100）；
     开放内容系列可以 -1（不限量）。**创建后发行量固定，不可修改**——不确定
     时宁可限量。
   - `royalty_rate`：版税 0-20%，默认 0。
   - `cover`：封面，先 metabot-upload-file 上传拿 pinId。
2. `mrc721_collection_create`（工具会预检重名并在默认 30s 内等索引确认）。
3. 回报用户：`collectionid`（= collection_desc pinId）、花费、确认状态。
   未索引完成时不要谎报——工具回执里会写清楚。

## 2. 流程 B：把内容发布成 NFT（进专辑）

1. **先盘点再建议**：`mrc721_search_collections {issuer: "<本bot>", supply_state: true}`
   列出用户已有的专辑和各自剩余量。给用户的建议要具体：哪个专辑还有
   slot、题材是否匹配；满了或不合适就建议新建专辑（流程 A）。
2. 上传内容文件 → metafile pinId；音视频另备海报。
3. `mrc721_mint {collection_name, name, desc, cover, metadata}`：
   - `cover` 是展示图；原内容 pinId 放 `metadata`（如
     `{"contentType":"audio/mpeg","content":"metafile://<pinId>"}`）。
   - `item_path` 可自定义；不填自动生成。
4. 铸造工具的回执里会附带 ```nft-card 围栏和 NFT_CARD_RESULT_HINT 提示——
   **在给用户的播报消息里必须原样带上这个围栏**，聊天客户端才会渲染 NFT
   卡片。这是约定，不是可选。
5. 复核：`mrc721_item_info` 确认索引、归属与编号；索引确认前编号可能显示
   为未确认（number 为负），照实说明，不要催索引器。

## 3. 流程 C：把已有 pin 包装成 NFT

- 任意已有 pin（元应用栏目、buzz 里的图片、metafile 文件）都可以成为 NFT：
  铸造一个专辑条目，`cover`/`metadata` 引用现有 pinId（`pin://` 或
  `metafile://` URI）。元应用栏目做 NFT 时，metadata 里放栏目 pinId 与
  `metaapp://` URI。
- 注意方向：是"铸造一个引用它的条目"，不是把旧 pin 改路径——pin 路径不可变。

## 4. 规则与红线

- **开放铸造**：MRC-721 是开放铸造协议，任何 bot 都可以向别人的专辑 mint
  （索引器只校验发行量）。向他人专辑铸造前必须先征得用户同意；向用户自己
  的专辑铸造才默认允许。
- 门禁类专辑（粉丝徽章等）：建议限量 + 明确铸造政策；bot 判断"对方是否
  持有"用 `mrc721_verify_holding`，判定以索引器持有人视图为准（转走了就
  是没有）。
- 结果回执为唯一事实来源：花了多少、txid、确认状态都照工具回执转述；
  索引滞后就说明滞后，不要编造成功。
- 发布后想卖：`mrc721_sell_intent` 声明出售意愿（可声明接受任意货币，
  走原子交换或担保人结算）；已有明确买家时直接 `mrc721_sell`（定向原子
  交换）。
