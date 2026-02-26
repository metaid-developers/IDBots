# metafs-indexer API 参考

Base URL: `https://file.metaid.io/metafile-indexer`

## 用户信息（/api/info 与 /api/v1/users）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/info/address/:address` | 按 address 查询（MetaID 格式） |
| GET | `/api/info/metaid/:metaidOrGlobalMetaId` | 按 metaid 或 globalMetaId 查询 |
| GET | `/api/info/globalmetaid/:globalMetaID` | 按 globalMetaID 查询 |
| GET | `/api/v1/users/address/:address` | 按 address 查询（v1） |
| GET | `/api/v1/users/metaid/:metaId` | 按 metaId 查询（v1，不支持 globalMetaId） |
| GET | `/api/v1/users/metaid/:metaId/avatar` | 按 metaId 取头像内容（二进制或 307 重定向） |
| GET | `/api/v1/users/avatar/content/:pinId` | 按头像 pinId 取头像内容 |
| GET | `/content/:pinId` | 根路径：按 pinId 取头像内容（用于拼接头像图片 URL） |
| GET | `/thumbnail/:pinId` | 根路径：按 pinId 取头像缩略图 |

## 文件（/api/v1/files）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/files/:pinId` | 按 pinId 查询文件元数据 |
| GET | `/api/v1/files/content/:pinId` | 按 pinId 获取文件内容（二进制） |
| GET | `/api/v1/files/accelerate/content/:pinId` | 按 pinId 加速获取（307 重定向 OSS） |

## 响应结构

### MetaIDUserInfo（/api/info/* 返回的 data）

| 字段 | 类型 | 说明 |
|------|------|------|
| globalMetaId | string | 全局 MetaID |
| metaid | string | 用户 MetaID |
| name | string | 用户名称 |
| nameId | string | 名称 PIN ID |
| address | string | 地址 |
| avatar | string | 头像相对路径，如 `/content/{avatarPinId}` |
| avatarId | string | 头像 PIN ID，用于拼接头像 URL |
| chatpubkey | string | 聊天公钥 |
| chatpubkeyId | string | 聊天公钥 PIN ID |

### IndexerUserInfo（/api/v1/users/* 返回的 data）

| 字段 | 类型 | 说明 |
|------|------|------|
| globalMetaId | string | 全局 MetaID |
| metaId | string | 用户 MetaID |
| address | string | 地址 |
| name | string | 用户名称 |
| namePinId | string | 名称 PIN ID |
| avatar | string | 头像路径 |
| avatarPinId | string | 头像 PIN ID，用于拼接头像 URL |
| chatPublicKey | string | 聊天公钥 |
| chatPublicKeyPinId | string | 聊天公钥 PIN ID |
| chainName | string | 链名称 |
| blockHeight | int64 | 区块高度 |
| timestamp | int64 | 时间戳 |

### IndexerFileResponse（/api/v1/files/:pinId 返回的 data）

| 字段 | 类型 | 说明 |
|------|------|------|
| pin_id | string | PIN ID |
| tx_id | string | 交易 ID |
| path | string | 路径 |
| operation | string | 操作类型 |
| content_type | string | Content-Type |
| file_type | string | 文件类型（如 image） |
| file_extension | string | 扩展名 |
| file_name | string | 文件名 |
| file_size | int64 | 文件大小 |
| file_md5 | string | MD5 |
| file_hash | string | 文件哈希 |
| storage_path | string | 存储路径 |
| chain_name | string | 链名称 |
| block_height | int64 | 区块高度 |
| timestamp | int64 | 时间戳 |
| creator_meta_id | string | 创建者 MetaID |
| creator_address | string | 创建者地址 |
| owner_meta_id | string | 所有者 MetaID |
| owner_address | string | 所有者地址 |

### 通用响应包装

- `/api/info/*` 成功：`{ "code": 1, "data": MetaIDUserInfo }`
- `/api/v1/*` 成功：`{ "code": 0, "data": T }`（T 为上述数据类型）
- 404/错误：`{ "code": 非 0/1, "message": "..." }`
