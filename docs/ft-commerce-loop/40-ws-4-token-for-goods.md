# WS-4 开发任务书（实用标杆 1）：用指定 Token 直接购买数字商品 / NFT

- **负责范围**：`IDBots`（上架协议 v2.2 扩展、MVC 同链 FT↔MRC721 原子互换、跨链 MRC-20 验链自动发货守护、商品卡与购买面板多币支持）+ `metaso-p2p`（`mrc721sell` v2.2 索引扩展）+ `METAAPPs/personal-goods-shop`（个人小店展示支持 Token 购买）
- **建议分支与工作树**：`IDBots` 分支 `feat/token-for-goods-trade`，工作树 `.worktrees/token-for-goods-trade`
- **上游契约依赖**：[`01-protocols-and-contracts.md`](01-protocols-and-contracts.md) 中的 **契约 C5**

---

## 一、核心产品价值

让老社区用户手里的 `$METAID`、ID-Coin 及各类社区代币**直接变成数字商品（认证头像、课程权益卡、AI 素材包）的硬通货**：
- 店主挂牌数字商品时，只需多加一句：“顺便支持用 `200 $METAID` 直接买”；
- 持币买家无需先把币换成 BTC 或去充积分，对自己的 TwinBot 说一句：“用我钱包里的 `$METAID` 把那件课程卡买下来”，几秒钟自动完成链上点对点交割。

---

## 二、详细需求清单（REQ-4）

### REQ-4-01：升级 `mrc721_sell_intent` 与 MetaSo 索引至 v2.2（契约 C5.1）
- **修改文件**：
  - `IDBots`: `src/main/services/mrc721SellIntentService.ts`、`src/main/libs/mrc721AgentTools.ts`
  - `metaso-p2p`: `internal/aggregator/mrc721/`
- **实现要求**：
  1. `mrc721_sell_intent` 工具新增可选参数 `price_tokens?: Array<{ asset_key, amount_display }>` 与 `auto_fulfill_tokens?: boolean`（默认 `true`），自动填入卖家对应链的收币地址（BTC 地址收 MRC-20，MVC 地址收 MetaContract FT）并写入本机 KV 挂单簿。
  2. `metaso-p2p` 解析并索引 `prices.tokens[]`，在 `GET /api/mrc721/market/listings` 增加 `?tokenAssetKey=<assetKey>` 过滤能力（方便买家搜：“现在有哪些数字商品可以用 `$METAID` 直接买？”）。

### REQ-4-02：双模式无担保交割引擎（同链原子互换 + 跨链验链秒发，契约 C5.2）
- **新增/修改文件**：`src/main/services/tokenForGoodsService.ts`、`src/main/services/sellerAutoFulfillDaemon.ts`、`src/main/libs/goodsTradeAgentTools.ts`
- **新增买方工具 `goods_buy_with_token`**：
  - 入参：`item_pin_id`, `asset_key`, `max_token_amount`（用户确认的代币支出上限）。
  - **路径 A（MVC 同链 FT 买 MVC MRC-721 —— 优先走单笔原子互换）**：
    1. 买方弹窗单次确认后，本地构建包含「买方 FT 输入 + TransferCheck（收款人为卖家 MVC 地址，金额等于挂牌价）+ 买方收 MRC-721 输出 + 买方矿工费输入」的半签名交易草案，通过 `FT_GOODS_ATOMIC_PROPOSAL_V1` 发给在线卖家守护进程；
    2. 卖家 `SellerAutoFulfillDaemon` 离线字节级校验：该草案未花费卖家除目标 `itemPinId` 外的任何其他 UTXO，且卖家名下确实新增了一颗真 `codehash + genesis`、金额 `>= 挂牌价` 的标准可花费 FT 输出；
    3. 校验通过后卖家守护进程自动补签 `itemPinId` 输入并广播上链，实现 **100% 无信任单笔原子交割**！
  - **路径 B（跨链异构，如 BTC MRC-20 买 MVC MRC-721 —— 锁位验链自动秒发）**：
    1. 买方先调 MetaSo `/api/presence/batch` 确认卖家在线，发送 `TOKEN_GOODS_RESERVE_V1` 请求 5 分钟排他锁位（此时若该商品正被另一张活跃积分单或代币单锁定，卖家守护进程立即返回繁忙拒绝，**确保买家绝不会在撞单情况下白转币**！）；
    2. 收到 `TOKEN_GOODS_RESERVED_V1` 后，弹出买方单次确认卡，调用本地 `executeMrc20Transfer` 广播转币并发送 `TOKEN_GOODS_PAID_V1(reservationId, revealTxId)`；
    3. 卖家 `SellerAutoFulfillDaemon` 调 `man-p2p` / `metalet-service` 权威核验该 `revealTxId` 确已向卖家 BTC 地址转入足额有效 `mrc20Id` 代币（且 `revealTxId` 全局唯一未消费过），立即执行 `mrc721_transfer` 将数字商品发往买家地址并广播 `/protocols/mrc721trade` 回执！

### REQ-4-03：`NftCard` 与个人小店 MetaApp 支持多币标价展示
- 更新 `src/renderer/components/chat/NftCard.tsx` 与 `METAAPPs/personal-goods-shop/index.html`：
  - 当商品存在 `prices.tokens` 时，在积分价/法币价旁优雅展示代币胶囊（如 `200 $METAID`）；
  - 点击卡片或小店内的「用 $METAID 购买」，经 `browser.commerce.askTwinToBuy` 带入 `paymentAssetKey` 直接唤起 `GoodsPurchaseConfirmModal` 代币支付视图。

---

## 三、测试与验收要求

1. **防伪与防撞单单测**：
   - 构造伪造 `genesis` / `mrc20Id` 同名假币支付凭证，断言卖家 `SellerAutoFulfillDaemon` 100% 拒发 MRC-721；
   - 模拟买家 A 已锁积分托管单（或已获 5 分钟 `RESERVED` 锁）时买家 B 发起 `TOKEN_GOODS_RESERVE_V1`，断言立即拒锁防一货二卖；
   - 测试同一笔 `paymentTxId` 重放购买第二件商品被持久化消费表硬拦截。
2. **门禁验证**：`pnpm run test:goods-trade`、`pnpm run test:commerce` 与新增单测在 `NO_COLOR=1 FORCE_COLOR=0` 下全绿。
