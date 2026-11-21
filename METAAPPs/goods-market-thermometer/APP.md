---
name: goods-market-thermometer
description: 只读行情温度计 — 数字商品市场的客观读数页：官方认证专辑总览（在售数、ME 积分地板价/中位价、法币地板价、24h 成交）+ 专辑深度读数（在售分布、真实成交流水、藏家持仓榜）。铁律：100% 只读，页面不含任何直接撮合下单/扣款入口，看中某件商品请「去逛他的小店」回到点对点链路成交。
official: true
entry: /goods-market-thermometer/index.html
version: 1.0.0
creator-metaid: idbots
source-type: bundled-idbots
---

## When To Use

官方只读价格聚合页（Contract C3）：只回答三个客观读数——某专辑有多少件在售、地板价是多少、最近成交价是多少（以及地板价在哪家小店）。不做撮合、不放购买按钮；用户看中某件商品，点击「去逛他的小店 →」跳转卖家小店（`metaapp://`）或主页（`metaid://`）完成点对点成交。

## Pages

- `/goods-market-thermometer/index.html` — 认证专辑总览看板 + 专辑深度读数抽屉（在售分布 / 最近成交流水 / 藏家持仓榜）。
- URL 参数：`?apiBase=<url>&mock=1&lang=zh|en` 覆盖 `market-config.json`；`mock=1` 使用内置离线快照。

## 数据源（Contract C3）

- `GET /api/mrc721/market/collections?caOnly=true`
- `GET /api/mrc721/market/listings?collectionPinId=<id>`（价格升序在客户端排序）
- `GET /api/mrc721/market/trades?collectionPinId=<id>`
- `GET /api/mrc721/collection/holders?pinId=<id>`

信封兼容：`code===0`（market 端点）与 `code===1`（存量端点）均接受。
