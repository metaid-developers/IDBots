---
name: metabot-trade-mvcswap
description: MetaBot 的 mvcswap 交易技能。用于 SPACE 与 mvcswap 当前支持 token 的报价、预览和交易；当用户提到买入、卖出、兑换、swap、报价、滑点、确认交易、确定执行、无需询问时都应考虑使用。
official: true
---
# MetaBot Trade Mvcswap

用于 mvcswap `v1` 的 Phase 1 交易能力。

## When To Use

- 用户想查询 `SPACE <-> token` 的报价
- 用户想预览一次 mvcswap 交易
- 用户明确要求直接执行 `SPACE <-> token` 交易
- 用户想指定滑点，或者询问默认滑点

## Phase 1 Limits

- 只支持 `swap v1`
- 只支持 `exact-in`
- 只支持一端为 `SPACE` 的交易
- 不支持流动性操作
- 不支持 `swapv2`

## Confirmation Rules

- 如果用户有 `确认交易`、`确定交易`、`确定执行`、`无需询问` 这类明确语义，可以直接执行
- 否则先给报价和预览，再等待确认

## Execution Model

技能负责：

- 解析用户交易意图
- 调用 mvcswap API 获取 pairs、quote、swap args
- 调用本地 IDBots RPC 获取账户信息、费率和 raw tx
- 组装并提交 mvcswap 交易请求

技能不会直接获取 mnemonic。
