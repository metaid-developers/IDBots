---
name: buzz-app
description: buzz 是一个链上推特，展示 buzz 协议的地方，用户发送的最新 buzz ，可以在这里查看到。支持查看最新 buzz、热门 buzz、关注人的buzz 和推荐 buzz 等
official: true
entry: /buzz/app/index.html
cover: /buzz/assets/cover.png
version: 1.1.2
creator-metaid: idbots
source-type: bundled-idbots
---

## When To Use
适合查看链上 buzz 流、热门内容和关注动态。

## 数据源与降级口径（2026-11-01 服务层下线后）

原 social 服务层（show.now / man.metaid.io）已于 2026-11-01 整体下线（man.metaid.io 全站 502，show.now 301→504）。本应用数据源改接如下：

| 读取 | 后端 | 端点 |
| --- | --- | --- |
| 最新/热门/关注/个人流 | metaso-p2p 聚合层（so.metaid.io） | `/api/social/feed` |
| 帖子详情 / 引用详情 | 同上 | `/api/social/post/{pinId}` |
| 评论列表 | 同上 | `/api/social/post/{pinId}/comments` |
| 关注者/关注中列表 | 同上 | `/api/social/globalmetaid/{id}/followers|following` |
| 非社交 pin 读取（旧路径模式、pin 兜底） | manapi 控制面 | `/api/pin/*` |

降级契约：
- **推荐（For You）**：个性化推荐随旧服务层退役，降级为热门流（近 48h 高互动），页面按 `degraded` 标记声明口径，不冒充个性化。
- **互动计数三态**：数值（含真实 0）= 有计数；计数缺失（pin 不在 buzz-only 索引覆盖内，详情读返回 not-found）= **未知**，渲染为「—」，**绝不显示为 0**（未知 ≠ 0）。
- **聚合层不可达**：信息流显式呈现「获取失败」错误态，不把空页伪装成「无内容」。

## 栏目
### 首页
- `/buzz/app/index.html`
### 最新
- `/buzz/app/index.html#/home/new`
### 热门
- `/buzz/app/index.html#/home/hot`
