# 文件类查询 (File Index APIs)

**说明**：查询链上文件元数据、按创作者/metaiD/扩展名等列文件、获取最新版本等。数据来源为 file.metaid.io 的 metafile-indexer。

---

## Metafile-Indexer（file.metaid.io）

### base_url
`https://file.metaid.io/metafile-indexer`

### 可用接口

**根据 PinId 获取文件元数据**

`GET /api/v1/files/{pinId}`

Inputs: `pinId`(path, string) — 文件对应 PIN 的 PinId。  
Outputs: `data` 为对象，常见字段：path, content_type, creator_meta_id, content_url 等。以实际返回 JSON 为准。

**根据 firstPinId 获取该文件最新版本**

`GET /api/v1/files/latest/{firstPinId}`

Inputs: `firstPinId`(path, string)。  
Outputs: `data` 为对象。

**分页列出已索引文件**

`GET /api/v1/files`

Inputs: `cursor`(query, string, 可选), `size`(query, int, 可选)。  
Outputs: `data` 为列表或含 list 的对象。

**按创作者地址分页列出文件**

`GET /api/v1/files/creator/{address}`

Inputs: `address`(path, string, 必填), `cursor`(query, string, 可选), `size`(query, int, 可选)。  
Outputs: `data` 为列表。

**按 metaId 分页列出文件**

`GET /api/v1/files/metaid/{metaid}`

Inputs: `metaid`(path, string, 必填), `cursor`(query, string, 可选), `size`(query, int, 可选)。  
Outputs: `data` 为列表。

**按扩展名列出文件**

`GET /api/v1/files/extension`

Inputs: `extension`(query, string, 必填, 如 `.jpg`), `timestamp`(query, string, 可选), `size`(query, int, 可选)。  
Outputs: `data` 为列表。

**按 metaId + 扩展名列出文件**

`GET /api/v1/files/metaid/{metaid}/extension`

Inputs: `metaid`(path, string, 必填), `extension`(query, string, 必填), `timestamp`(query, string, 可选), `size`(query, int, 可选)。  
Outputs: `data` 为列表。

### 参考例子
- 按 PinId 查文件：`https://file.metaid.io/metafile-indexer/api/v1/files/{pinId}`
- 按创作者：`https://file.metaid.io/metafile-indexer/api/v1/files/creator/{address}?size=20`
- 按扩展名：`https://file.metaid.io/metafile-indexer/api/v1/files/extension?extension=.jpg&size=20`
