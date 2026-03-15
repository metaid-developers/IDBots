# 用户信息查询 (User Info APIs)

**说明**：根据 metaId、钱包地址或 globalMetaID 查询链上用户信息（昵称、头像、地址、chatpubkey 等）；支持按关键词搜索用户。数据来源为 manapi 或 metafile-indexer。

---

## MAN API（manapi.metaid.io）

### base_url
`https://manapi.metaid.io`

### 可用接口

**根据 metaId 获取用户信息（昵称、地址、头像、chatpubkey 等）**

`GET /api/info/metaid/{metaid}`

Inputs: `metaid`(path, string) — 用户的 metaId。  
Outputs: `data` 为对象，常见字段：name, address, avatar, chatpubkey, metaid, number 等。具体以实际返回 JSON 为准。

**根据钱包地址获取用户信息**

`GET /api/info/address/{address}`

Inputs: `address`(path, string) — 钱包地址。  
Outputs: `data` 为对象，字段同上。

### 参考例子
- 按 metaId 查询：`https://manapi.metaid.io/api/info/metaid/0d166d6c6e2ac2f839fb63e22bd93ed571fc06940eadca0986427402eb688a4d`
- 按地址查询：`https://manapi.metaid.io/api/info/address/12ghVWG1yAgNjzXj4mr3qK9DgyornMUikZ`

---

## Metafile-Indexer（file.metaid.io）

### base_url
`https://file.metaid.io/metafile-indexer`

### 可用接口

**根据 metaId 获取用户信息（indexer 数据源）**

`GET /api/v1/info/metaid/{metaid}`

Inputs: `metaid`(path, string)。  
Outputs: `data` 为对象。

**根据钱包地址获取用户信息（indexer）**

`GET /api/v1/info/address/{address}`

Inputs: `address`(path, string)。  
Outputs: `data` 为对象。

**根据 globalMetaID 获取用户信息**

`GET /api/v1/info/globalmetaid/{globalMetaID}`

Inputs: `globalMetaID`(path, string)。  
Outputs: `data` 为对象。

**按关键词搜索用户（metaid 或昵称）**

`GET /api/v1/info/search`

Inputs: `keyword`(query, string, 必填), `keytype`(query, string, 可选, 取值 `metaid` 或 `name`), `limit`(query, int, 可选, 默认 10)。  
Outputs: 返回数组或包装在 data 中的列表，每项为用户信息。具体结构以实际 JSON 为准。

**根据 metaId 获取用户（users 端点）**

`GET /api/v1/users/metaid/{metaId}`

Inputs: `metaId`(path, string)。  
Outputs: `data` 为对象。

**根据地址获取用户（users 端点）**

`GET /api/v1/users/address/{address}`

Inputs: `address`(path, string)。  
Outputs: `data` 为对象。

**分页列出用户列表**

`GET /api/v1/users`

Inputs: `cursor`(query, string, 可选), `size`(query, int, 可选)。  
Outputs: `data` 为列表或含 list 的对象，具体以返回 JSON 为准。

### 参考例子
- 搜索用户：`https://file.metaid.io/metafile-indexer/api/v1/info/search?keyword=alice&keytype=name&limit=10`
- 按 globalMetaID：`https://file.metaid.io/metafile-indexer/api/v1/info/globalmetaid/{globalMetaID}`
