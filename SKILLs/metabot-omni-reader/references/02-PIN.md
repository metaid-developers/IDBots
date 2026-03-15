# 通用 PIN 数据查询 (PIN & Chain Data APIs)

**说明**：查询链上 PIN 详情、按 path/metaiD/地址列 PIN、全局/区块/内存池列表、通知、以及原始内容等。数据来源为 manapi.metaid.io（主）与 file.metaid.io/metafile-indexer（部分）。

---

## MAN API（manapi.metaid.io）

### base_url
`https://manapi.metaid.io`

### 可用接口

**根据 Pin 编号或 PinId 获取 PIN 详情**

`GET /api/pin/{pinId}`

Inputs: `pinId`(path, string) — Pin 编号或 PinId（如 txid+i0）。  
Outputs: `data` 为对象，常见字段：content, preview, metaid, path, number, timestamp, operation 等。以实际返回 JSON 为准。

**获取 PIN 的指定版本内容（0=初始，≥1=历史版本）**

`GET /api/pin/ver/{pinid}/{ver}`

Inputs: `pinid`(path, string), `ver`(path, int)。  
Outputs: `data` 为对象。

**分页获取全局 PIN 列表**

`GET /api/pin/list`

Inputs: `page`(query, int), `size`(query, int)。可选 `sortBy=timestamp`, `order=desc`。  
Outputs: `data` 为列表。

**按协议 path 分页获取 PIN 列表（如 Buzz、群聊）**

`GET /api/pin/path/list`

Inputs: `path`(query, string, 必填, 如 `/protocols/simplebuzz`), `size`(query, int, 可选, 1–100), `cursor`(query, string, 可选)。  
Outputs: `data` 为列表。

**按 metaId 分页获取 PIN 列表（可带 path 筛选）**

`GET /api/metaid/pin/list/{metaid}`

Inputs: `metaid`(path, string, 必填), `path`(query, string, 可选), `size`(query, int, 可选), `cursor`(query, string, 可选)。  
Outputs: `data` 为列表。

**按钱包地址与 path 分页获取 PIN 列表**

`GET /api/address/pin/list/{address}`

Inputs: `address`(path, string, 必填), `path`(query, string, 必填), `size`(query, int, 可选), `cursor`(query, string, 可选)。  
Outputs: `data` 为列表。

**分页获取 MetaID 列表**

`GET /api/metaid/list`

Inputs: `page`(query, int), `size`(query, int)。  
Outputs: `data` 为列表。

**分页获取区块列表（含 PIN）**

`GET /api/block/list`

Inputs: `page`(query, int), `size`(query, int)。  
Outputs: `data` 为对象或列表，以实际返回为准。

**分页获取内存池中的 PIN（未确认）**

`GET /api/mempool/list`

Inputs: `page`(query, int), `size`(query, int)。  
Outputs: `data` 为列表。

**获取某地址的通知/互动列表**

`GET /api/notifcation/list`

Inputs: `address`(query, string, 必填), `lastId`(query, string, 可选), `size`(query, int, 可选, 最大 100)。  
说明：URL 中为 “notifcation”（拼写保留与后端一致）。  
Outputs: `data` 为列表，常见字段：notifcationType, fromPinId, fromAddress, notifcationTime 等。

**全局统计（pin/block/metaId/app 数量）**

`GET /debug/count`

Inputs: 无。  
Outputs: 根级或 data 下为对象，字段以实际 JSON 为准。

**根据 PinId 获取原始内容（文本/JSON 或 base64 图片等）**

`GET /content/{id}`

Inputs: `id`(path, string) — PinId。  
Outputs: 响应体可能为 JSON 或原始内容，非统一 data 包装。根据 contentType 解析。

### 参考例子
- 某用户最新 Buzz：`https://manapi.metaid.io/api/metaid/pin/list/{metaid}?path=/protocols/simplebuzz&size=10`
- 按 path 列 Buzz：`https://manapi.metaid.io/api/pin/path/list?path=/protocols/simplebuzz&size=20`
- 通知列表：`https://manapi.metaid.io/api/notifcation/list?address=12ghVWG1yAgNjzXj4mr3qK9DgyornMUikZ&size=20`

---

## Metafile-Indexer（file.metaid.io）

### base_url
`https://file.metaid.io/metafile-indexer`

### 可用接口

**根据 PinId 获取 PIN 信息（indexer）**

`GET /api/v1/pins/{pinId}`

Inputs: `pinId`(path, string)。  
Outputs: `data` 为对象。

**Indexer 同步状态**

`GET /api/v1/status`

Inputs: 无。  
Outputs: `data` 为对象，常见字段：chains, current_sync_height, latest_block_height 等。

**Indexer 统计信息**

`GET /api/v1/stats`

Inputs: 无。  
Outputs: `data` 为对象，如 total_files, chain_stats 等。

### 参考例子
- PIN 详情：`https://file.metaid.io/metafile-indexer/api/v1/pins/{pinId}`
- 状态：`https://file.metaid.io/metafile-indexer/api/v1/status`
