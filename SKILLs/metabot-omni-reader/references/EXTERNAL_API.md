
# Base_URL
`https://manapi.metaid.io`


## 2. 路径前缀规则

**推荐使用新路径（标准）：**
- 所有 JSON API 以 `/api` 为前缀，例如：`/api/pin/list`

**兼容旧路径（无 /api）：**
- 若网关配置了兼容重写，可直接使用旧路径：`/pin/list`、`/pin/path/list` 等
- 兼容映射规则：
  - `/pin/*` → `/api/pin/*`
  - `/metaid/*` → `/api/metaid/*`
  - `/block/*` → `/api/block/*`
  - `/mempool/*` → `/api/mempool/*`
  - `/notifcation/*` → `/api/notifcation/*`
  - `/address/*` → `/api/address/*`
  - `/info/*` → `/api/info/*`

**非 /api 的数据接口：**
- `/debug/count` 返回全量统计 JSON
- `/content/:id` 返回 Pin 内容（文本/图片/视频 html）
- `/stream/:id` 返回 Pin 原始内容流（按 Content-Type 返回）

## 3. 通用返回结构

大部分 JSON API 返回：

```json
{
  "code": 1,
  "message": "ok",
  "data": {}
}
```

异常返回常见为：

```json
{
  "code": 404,
  "message": "Parameter error."
}
```

通知接口（`/notifcation/list`）的结构略有不同：

```json
{
  "code": 200,
  "message": "ok",
  "data": [],
  "total": 0
}
```

## 4. 通用参数

### 4.1 排序参数（列表接口通用）

支持排序的接口：
- `/metaid/list`
- `/pin/list`
- `/block/list`
- `/mempool/list`
- `/notifcation/list`
- `/block/id/list`
- `/pin/path/list`
- `/address/pin/list/:address`
- `/metaid/pin/list/:metaid`

通用参数：

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `sortBy` | string | 否 | 接口默认字段 | 排序字段 |
| `order` | string | 否 | `desc` | `asc` / `desc` / `1` / `true` |
| `sortOrder` | string | 否 | - | `order` 的别名 |

默认排序字段：
- `/metaid/list`: `number`
- `/pin/list`: `timestamp`
- `/block/list`: `height`
- `/mempool/list`: `timestamp`
- `/notifcation/list`: `notifcationTime`
- `/pin/path/list`: `timestamp`
- `/address/pin/list/:address`: `timestamp`
- `/metaid/pin/list/:metaid`: `timestamp`

`sortBy=time` 会自动映射到默认字段。

### 4.2 分页参数

- 页码分页：`page`（从 1 开始）、`size`
- 游标分页：`cursor`（为空表示第一页）

### 4.3 链名参数

可用链名：`btc`, `mvc`, `doge`

## 5. 接口总览（JSON API）

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/api/metaid/list` | 分页获取 MetaId 列表 |
| GET | `/api/pin/list` | 分页获取 Pin 列表 |
| GET | `/api/block/list` | 分页获取区块及区块内 Pin 列表 |
| GET | `/api/mempool/list` | 分页获取 Mempool Pin 列表 |
| GET | `/api/notifcation/list` | 获取通知列表 |
| GET | `/api/block/file` | 下载区块分片文件 |
| GET | `/api/block/file/partCount` | 查询区块分片数量 |
| POST | `/api/block/file/create` | 批量生成区块分片文件（管理员） |
| POST | `/api/block/id/list` | 查询区块 PinId 列表（管理员） |
| POST | `/api/block/id/create` | 批量写入区块 PinId 列表（管理员） |
| GET | `/api/pin/:numberOrId` | 查询 Pin 详情 |
| GET | `/api/pin/ver/:pinid/:ver` | 查询 Pin 历史版本 |
| GET | `/api/pin/path/list` | 按 path 分页查 Pin |
| GET | `/api/address/pin/list/:address` | 按 address+path 分页查 Pin |
| GET | `/api/metaid/pin/list/:metaid` | 按 metaid+path 分页查 Pin |
| GET | `/api/info/address/:address` | 通过地址查 MetaId 信息 |
| GET | `/api/info/metaid/:metaId` | 通过 MetaId 查信息 |

## 6. 接口详解

### 6.1 GET `/api/metaid/list`

查询参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page` | int64 | 是 | 页码，从 1 开始 |
| `size` | int64 | 是 | 每页数量 |

返回 `data`：
- `list`: MetaId 列表（`MetaIdInfo`）
- `count`: MetaId 总数

### 6.2 GET `/api/pin/list`

查询参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page` | int | 是 | 页码，从 1 开始 |
| `size` | int | 是 | 每页数量 |
| `lastId` | string | 否 | 游标分页用，上一页最后一个 Pin Id |

返回 `data`：
- `Pins`: Pin 摘要列表（`PinMsg`）
- `Count`: 全量统计
- `Active`: 固定 `"index"`
- `LastId`: 下一页游标

### 6.3 GET `/api/block/list`

查询参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page` | int64 | 是 | 页码，必须 > 0 |
| `size` | int64 | 是 | 每页数量，最大 100 |

返回 `data`：
- `msgMap`: `height -> []PinMsg` 映射
- `msgList`: 区块高度列表
- `count`: 区块总数
- `page`: 当前页
- `size`: 实际返回 size
- `active`: 固定 `"blocks"`

### 6.4 GET `/api/mempool/list`

查询参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page` | int64 | 是 | 页码，从 1 开始 |
| `size` | int64 | 是 | 每页数量 |

返回 `data`：
- `Pins`: Mempool Pin 列表
- `Count`: 全量统计
- `Active`: 固定 `"mempool"`

### 6.5 GET `/api/notifcation/list`

查询参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `address` | string | 是 | 钱包地址 |
| `lastId` | int64 | 否 | 翻页游标 |
| `size` | int | 否 | 返回条数，默认 20，最大 100 |

返回结构与通用格式不同，见第 3 节。

### 6.6 GET `/api/block/file`

查询参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `height` | int64 | 是 | 区块高度 |
| `chain` | string | 是 | 链名（btc/mvc/doge） |
| `part` | int | 否 | 分片索引，默认 0 |

返回：二进制文件下载流。

### 6.7 GET `/api/block/file/partCount`

查询参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `height` | int64 | 是 | 区块高度 |
| `chain` | string | 是 | 链名（btc/mvc/doge） |

返回 `data`：
- `partCount`: 当前区块分片数量
- `btcMin` / `btcMax`: BTC 分片覆盖高度范围
- `mvcMin` / `mvcMax`: MVC 分片覆盖高度范围

### 6.8 POST `/api/block/file/create`（管理员）

请求头（二选一）：
- `Authorization: Bearer <admin-token>`
- `X-Admin-Token: <admin-token>`

查询参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `chain` | string | 是 | 链名（btc/mvc/doge） |
| `from` | int64 | 是 | 起始高度 |
| `to` | int64 | 是 | 结束高度 |

返回：纯文本 `"block file create finish"`。

### 6.9 POST `/api/block/id/list`（管理员）

请求头（二选一）：
- `Authorization: Bearer <admin-token>`
- `X-Admin-Token: <admin-token>`

查询参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `chain` | string | 是 | 链名（btc/mvc/doge） |
| `height` | int64 | 是 | 区块高度 |

返回 `data`：
- `data`: 该区块 PinId 列表（`[]string`）

### 6.10 POST `/api/block/id/create`（管理员）

请求头（二选一）：
- `Authorization: Bearer <admin-token>`
- `X-Admin-Token: <admin-token>`

查询参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `chain` | string | 是 | 链名（btc/mvc/doge） |
| `from` | int64 | 是 | 起始高度 |
| `to` | int64 | 是 | 结束高度 |

返回：纯文本 `"block file pin id list create finish"`。

### 6.11 GET `/api/pin/:numberOrId`

路径参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `numberOrId` | string | 是 | Pin 编号或 Pin Id |

返回 `data`：Pin 详情对象，包含 `Preview` / `Content` 字段（指向可读内容 URL）。

### 6.12 GET `/api/pin/ver/:pinid/:ver`

路径参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `pinid` | string | 是 | Pin Id |
| `ver` | int | 是 | 版本号：`0` 表示初始内容，`>=1` 表示修改历史索引 |

返回：指定版本 Pin 数据；找不到时返回空对象。

### 6.13 GET `/api/pin/path/list`

查询参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | 是 | Pin path |
| `size` | int64 | 是 | 返回条数，`<=0` 或 `>100` 会回退到 20 |
| `cursor` | string | 否 | 游标，首次可为空 |

返回 `data`：
- `list`: Pin 列表
- `total`: 总数
- `nextCursor`: 下一页游标

### 6.14 GET `/api/address/pin/list/:address`

路径参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `address` | string | 是 | 钱包地址 |

查询参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | 是 | Pin path |
| `size` | int64 | 是 | 返回条数，`<=0` 或 `>100` 会回退到 20 |
| `cursor` | string | 否 | 游标，首次可为空 |

返回 `data`：
- `list`: Pin 列表（含 `Preview`、`Content`、`PopLv`）
- `total`: 总数
- `nextCursor`: 下一页游标

### 6.15 GET `/api/metaid/pin/list/:metaid`

路径参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `metaid` | string | 是 | MetaId |

查询参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | 是 | Pin path |
| `size` | int64 | 是 | 返回条数，`<=0` 或 `>100` 会回退到 20 |
| `cursor` | string | 是 | 游标（当前实现要求必须传） |

返回 `data`：
- `list`: Pin 列表（含 `Preview`、`Content`、`PopLv`）
- `total`: 总数
- `nextCursor`: 下一页游标

### 6.16 GET `/api/info/address/:address`

路径参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `address` | string | 是 | 钱包地址 |

返回 `data`：
- `MetaIdInfo`: 用户信息对象
- `unconfirmed`: 当前固定空字符串
- `blocked`: 当前固定 `false`

### 6.17 GET `/api/info/metaid/:metaId`

路径参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `metaId` | string | 是 | MetaId |

返回结构同 `/api/info/address/:address`。

## 7. 非 /api 数据接口（常用）

### 7.1 GET `/debug/count`

返回：

```json
{
  "pin": 0,
  "block": 0,
  "metaId": 0,
  "app": 0
}
```

### 7.2 GET `/content/:id`

- 根据 PinId 返回内容
- 文本/JSON 直接返回字符串
- 图片返回 base64 Data URL（`data:image/...;base64,`）
- 视频返回 HTML `<video>` 页面（内部会走 `/stream/:id`）

### 7.3 GET `/stream/:id`

- 按内容类型返回原始二进制（`Content-Type` 由链上内容决定）
- 适合 AI 直接获取文件内容

## 8. 常用示例（给 AI 直接调用）

```bash
# 最新 Pins（倒序）
curl -sS 'https://manapi.metaid.io/pin/list?page=1&size=20&sortBy=timestamp&order=desc'

# 某协议 path 下的 Pins
curl -sS 'https://manapi.metaid.io/pin/path/list?cursor=0&size=20&path=%2Fprotocols%2Fmetaapp'

# MetaID 信息
curl -sS 'https://manapi.metaid.io/info/metaid/<metaid>'

# Pin 详情
curl -sS 'https://manapi.metaid.io/pin/<pinId>'

# Pin 内容
curl -sS 'https://manapi.metaid.io/content/<pinId>'
```
