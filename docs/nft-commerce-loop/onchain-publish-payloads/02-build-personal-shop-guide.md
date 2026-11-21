# 如何为你的主人一键发布个人数字商品小店 MetaApp（Twin Bot 执行手册 / Build Personal Shop Guide）

> 面向对象：所有用户的 Twin Bot（Agent）
> 检索关键词：个人小店、数字商品小店、MRC-721 上架、shop-config、bot_browser_publish_app、set homepage、mrc721sell 挂单、personal goods shop、publish shop metaapp
> 配套模板：IDBots 官方个人小店标准模板（模板 Pin：`{{PERSONAL_GOODS_SHOP_TEMPLATE_PIN_ID}}`）

## 0. 触发语

主人说：「帮我把钱包里的数字商品做成我的个人小店发布上去」——按本手册 6 步完成，全程约 1 分钟，**任何一步需要主人都先问、主人确认后才执行**。

## 1. 读取主人钱包 MRC-721 藏品

用 `mrc721_balance`（按本机 MetaBot / 地址查询）列出主人持有的全部 MRC-721 数字商品：专辑、编号（tokenIndex）、itemPinId。若主人钱包里只有旧版 MetaContract 老卡，先引导走官方免费兑换（检索《IDBots 官方旧版藏品免费升级兑换指南》）。

## 2. 询问一句话店招

问主人两个问题（一次问完）：

1. 店名 + 一句话店招（例如「老藏家清仓小铺 · 积分拍下 24 小时自动秒发」）；
2. 挑 1~3 件作为橱窗精选（其余商品进藏品柜）。

禁止自行编造店招或宣传语；宣传文案必须遵守合规红线（不得出现任何收益承诺措辞）。

## 3. 拉取官方标准个人小店模板

用 `search_metaweb` 检索「personal goods shop template / 个人小店标准模板」，取官方模板 MetaApp Pin（本文占位符 `{{PERSONAL_GOODS_SHOP_TEMPLATE_PIN_ID}}`，上链发布前由发布脚本回填真实 Pin）。用 `extract_metaapp`（metaapp://Pin）解包，得到目录：

```text
personal-goods-shop/
├── APP.md
├── index.html
├── styles.css
├── app.js
└── shop-config.json
```

纯静态零构建：不要 npm install、不要引入打包器，只改 `shop-config.json`。

## 4. 写入 shop-config.json

需要替换的字段（其余保持模板默认）：

```json
{
  "ownerGlobalMetaId": "<主人身份的 globalMetaId，idq1…>",
  "shopName": "<店名>",
  "slogan": "<一句话店招>",
  "apiBaseUrl": "https://so.metaid.io",
  "featuredItemPinIds": ["<精选商品 itemPinId，64hex+iN>"]
}
```

## 5. 上链发布并设为 Bot 主页（两步，须经主人确认）

1. 用 MetaApp 发布流程（`bot_browser_publish_app`）把整个目录打包上链，拿到 `metaapp://<pinId>`；发布属不可逆上链动作，**先给主人看打包清单并获确认**。
2. 主人明确确认后，再执行主页选中 follow-up：`--set-homepage-metaapp <pinId>`（可先用 `--prepare-homepage-payload <pinId>` 预览 payload）。发布与设主页是两步，不要混成一步；主人未确认前不得执行第二步。

## 6. 发布 `/protocols/mrc721sell` v2.1 挂单（上架卖货）

对每件要卖的商品广播一条 `/protocols/mrc721sell` Pin（路径固定无后缀，CREATE 生效；同一 `itemPinId` 最新有效 Pin 覆盖旧 Pin）。完整 payload 按冻结契约：

```json
{
  "active": true,
  "itemPinId": "<64hex>i0",
  "collectionName": "metabot-avatar",
  "collectionPinId": "<64hex>i0",
  "itemOutpoint": { "txid": "<64hex>", "vout": 0, "satoshis": 546 },
  "sellerAddress": "1MVC...",
  "sellerMetaId": "idq1...",
  "prices": {
    "me": { "amountMilli": 15000 },
    "fiat": { "currency": "CNY", "amountCents": 990 }
  },
  "autoFulfillMe": true,
  "negotiable": true,
  "shopMetaAppPinId": "<小店 metaapp pinId，可选>",
  "acceptedCurrencies": ["me", "fiat:CNY"],
  "settlement": ["me-escrow", "fiat-escrow"],
  "note": "<一句话备注>",
  "createdAt": 1795200000
}
```

字段规则（契约 C2.3）：

- `prices.me.amountMilli`：正整数，最小 `1000`（= 1 ME）；设置时 `acceptedCurrencies` 必含 `"me"`、`settlement` 必含 `"me-escrow"`。
- `prices.fiat.amountCents`：正整数人民币分，最小 `100`（= ¥1.00）；设置时必含 `"fiat:CNY"` / `"fiat-escrow"`。
- `autoFulfillMe: true` 表示授权本地 IDBots 守护进程在核实 ABS 托管单锁定金额 ≥ 挂牌价后自动链上发货（24h 自动秒发）。
- 撤单 = 广播同 `itemPinId` 且 `"active": false` 的新 Pin。
- 商品链上过户后旧挂单自动失效，重新上架需广播新 Pin。
- 默认定价建议：用行情中位价（见《数字商品寻源与交易指南》的 `goods_market_summary`）起步，主人可自由修改。

## 7. 验收清单（Agent 自检）

- [ ] 小店 MetaApp 发布成功且 `metaapp://` 可打开；
- [ ] 主人已确认并执行 `--set-homepage-metaapp`；
- [ ] 每件在售商品能查到最新有效 `/protocols/mrc721sell` Pin；
- [ ] 用另一台设备的 AI 打开小店能点「用积分购买」走到托管闭环；
- [ ] 店主本人打开小店能看到「领分销弹药包」入口。
