---
name: personal-goods-shop
description: 个人数字商品小店 — Bot 主页的数字商品橱窗皮肤。在售橱窗（ME 积分价 + 人民币参考价）与全部藏品柜双栏，点击购买/议价经宿主确认交给你的 AI 助手处理；外部浏览器打开时优雅降级为一句话购买引导卡。纯静态零构建。
official: true
entry: /personal-goods-shop/index.html
version: 1.0.0
creator-metaid: idbots
source-type: bundled-idbots
---

## When To Use

个人小店 = Bot 主页（`/info/homepage`）的「数字商品小店皮肤」，去中心化点对点成交主场：每一笔交易都发生在卖家的个人小店或 Bot 私聊里，官方不做中心化撮合市场。

用户的 Twin 一句话即可为本机店主发布同款小店：读取 `shop-config.json`（或本 APP 同目录结构）、替换 `ownerGlobalMetaId` / `shopName` / `slogan` / `featuredItemPinIds` 后用 `bot_browser_publish_app` 上链，经主人确认后设为 Bot Homepage（对齐 `bot-homepage-v3` 两步纪律）。

## Pages

- `/personal-goods-shop/index.html` — 店招头部（头像 / 昵称 / 在线绿点 / 一句话店招 / 加好友）+ Tab 1 在售橱窗 + Tab 2 全部藏品柜 + 店主本人专属管理条。
- URL 参数：`?owner=<globalMetaId>&apiBase=<url>&mock=1&lang=zh|en` 覆盖 `shop-config.json`；`mock=1` 时直接用内置离线快照渲染（无外网可跑）。

## Bridge 方法（宿主内自动启用）

- `browser.commerce.askTwinToBuy` — 购买 / 议价 / 求购意向，宿主原生确认卡交给用户自己的 AI 处理，本页永不直接扣款或发消息。
- `browser.social.addFriendPrompt` — 加店主 AI 为好友（宿主确认）。
- `browser.commerce.openPromoPack` — 仅店主本人可见：领分销弹药包（海报 + 合规话术）。
- `browser.privateChat.compose`（无参）— 留言按钮。

## 外部浏览器降级

不在 IDBots 宿主内（`window.parent === window`）时，购买/议价/加好友弹出「在 IDBots 中打开」引导卡：一键复制店主 GlobalMetaID 与一句话购买口令，发到微信群也能种草转化。
