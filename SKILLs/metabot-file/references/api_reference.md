# API 参考文档

MetaID 文件系统上传服务的完整 API 文档。

**Base URL**: `https://file.metaid.io/metafile-uploader`

## 目录

- [配置 API](#配置-api)
- [直接上传 API](#直接上传-api)
- [分块上传任务 API](#分块上传任务-api)
- [任务监控 APIs](#任务监控-apis)
- [错误码](#错误码)

---

## 配置 API

### GET /api/v1/config

获取服务配置，包括文件大小限制和 API 设置。

**请求：**
```bash
curl https://file.metaid.io/metafile-uploader/api/v1/config
```

**响应：**
```json
{
  "code": 0,
  "message": "success",
  "data": {
    "maxFileSize": 104857600,
    "swaggerBaseUrl": "file.metaid.io/metafile-uploader",
    "uploadMethods": {
      "direct": "≤5MB",
      "chunked": ">5MB"
    }
  }
}
```

**响应字段：**

| 字段 | 类型 | 说明 |
|-------|------|-------------|
| `maxFileSize` | integer | 最大文件大小（字节） |
| `swaggerBaseUrl` | string | Swagger 文档 URL |
| `uploadMethods` | object | 上传方式阈值 |

---

## 直接上传 API

### POST /api/v1/files/direct-upload

在单个同步请求中上传小文件（≤5MB）。

**何时使用：**
- 文件 ≤5MB（5,242,880 字节）
- 无需进度跟踪的快速上传
- 需要立即结果的简单工作流

**请求：**

```bash
curl -X POST https://file.metaid.io/metafile-uploader/api/v1/files/direct-upload \
  -H "Content-Type: application/json" \
  -d '{
    "metaId": "a7f8d9e1b2c3...",
    "address": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    "fileName": "photo.jpg",
    "content": "iVBORw0KGgoAAAANSUhEUgAA...",
    "path": "/file",
    "operation": "create",
    "contentType": "image/jpeg;binary",
    "feeRate": 1
  }'
```

**请求参数：**

| 参数 | 类型 | 必填 | 说明 | 示例 |
|-----------|------|----------|-------------|---------|
| `metaId` | string | 是 | 地址的 SHA256 哈希 | `"a7f8d9e..."` |
| `address` | string | 是 | MVC 区块链地址 | `"1A1zP1eP..."` |
| `fileName` | string | 是 | 文件名 | `"photo.jpg"` |
| `content` | string | 是 | Base64 编码的文件内容 | `"iVBORw0..."` |
| `path` | string | 否 | MetaID 路径（默认：`/file`） | `"/file"` |
| `operation` | string | 否 | 操作类型（默认：`create`） | `"create"` |
| `contentType` | string | 否 | MIME 类型（需要 `;binary` 后缀） | `"image/jpeg;binary"` |
| `feeRate` | integer | 否 | 费率（sats/byte，默认：1） | `1` |

**成功响应：**

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "txId": "abc123def456ghi789...",
    "pinId": "abc123def456ghi789...i0",
    "status": "success"
  }
}
```

**响应字段：**

| 字段 | 类型 | 说明 |
|-------|------|-------------|
| `txId` | string | 区块链上的交易 ID |
| `pinId` | string | Pin 标识符（格式：`{txId}i0`） |
| `status` | string | 上传状态（`success`） |

**使用示例：**

```bash
# 完整示例
address="1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
metaId=$(python scripts/calculate_metaid.py "$address" | jq -r '.metaId')
fileData=$(python scripts/read_file_base64.py res/file/image.jpg)

curl -X POST https://file.metaid.io/metafile-uploader/api/v1/files/direct-upload \
  -H "Content-Type: application/json" \
  -d "{
    \"metaId\": \"$metaId\",
    \"address\": \"$address\",
    \"fileName\": \"$(echo $fileData | jq -r '.fileName')\",
    \"content\": \"$(echo $fileData | jq -r '.base64Content')\",
    \"path\": \"/file\",
    \"contentType\": \"$(echo $fileData | jq -r '.contentType')\",
    \"operation\": \"create\",
    \"feeRate\": 1
  }" | jq '.'
```

**错误响应：**

| 代码 | 消息 | 说明 |
|------|---------|-------------|
| 1001 | File size exceeds limit | 文件太大，无法直接上传 |
| 1002 | Invalid address format | 地址不是有效的 MVC 地址 |
| 1003 | Invalid metaId | MetaID 格式不正确 |
| 1004 | Invalid base64 content | 内容未正确进行 base64 编码 |

---

## 分块上传任务 API

### POST /api/v1/files/chunked-upload-task

为大文件（>5MB）创建异步上传任务。

**何时使用：**
- 文件 >5MB（5,242,880 字节）
- 需要进度跟踪
- 直接上传可能超时的大文件
- 需要分块处理的文件

**请求：**

```bash
curl -X POST https://file.metaid.io/metafile-uploader/api/v1/files/chunked-upload-task \
  -H "Content-Type: application/json" \
  -d '{
    "metaId": "a7f8d9e1b2c3...",
    "address": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    "fileName": "video.mp4",
    "content": "AAAAIGZ0eXBpc29tAAACAGlzb21...",
    "path": "/file",
    "operation": "create",
    "contentType": "video/mp4;binary",
    "chain": "mvc",
    "feeRate": 1
  }'
```

**请求参数：**

| 参数 | 类型 | 必填 | 说明 | 示例 |
|-----------|------|----------|-------------|---------|
| `metaId` | string | 是 | 地址的 SHA256 哈希 | `"a7f8d9e..."` |
| `address` | string | 是 | MVC 区块链地址 | `"1A1zP1eP..."` |
| `fileName` | string | 是 | 文件名 | `"video.mp4"` |
| `content` | string | 是 | Base64 编码的文件内容 | `"AAAAIGZ0..."` |
| `path` | string | 否 | MetaID 路径（默认：`/file`） | `"/file"` |
| `operation` | string | 否 | 操作类型（默认：`create`） | `"create"` |
| `contentType` | string | 否 | MIME 类型（需要 `;binary` 后缀） | `"video/mp4;binary"` |
| `chain` | string | 否 | 区块链（默认：`mvc`） | `"mvc"` |
| `feeRate` | integer | 否 | 费率（sats/byte，默认：1） | `1` |

**成功响应：**

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "taskId": "task_abc123def456",
    "status": "created",
    "message": "Task created successfully"
  }
}
```

**响应字段：**

| 字段 | 类型 | 说明 |
|-------|------|-------------|
| `taskId` | string | 用于监控的唯一任务标识符 |
| `status` | string | 初始任务状态（`created`） |
| `message` | string | 状态消息 |

**使用示例：**

```bash
# 创建任务
response=$(curl -s -X POST https://file.metaid.io/metafile-uploader/api/v1/files/chunked-upload-task \
  -H "Content-Type: application/json" \
  -d "{
    \"metaId\": \"$metaId\",
    \"address\": \"$address\",
    \"fileName\": \"largefile.mp4\",
    \"content\": \"$fileContent\",
    \"path\": \"/file\",
    \"contentType\": \"video/mp4;binary\",
    \"chain\": \"mvc\",
    \"feeRate\": 1
  }")

# 提取 taskId
taskId=$(echo "$response" | jq -r '.data.taskId')
echo "Task ID: $taskId"

# 监控任务
python scripts/monitor_task.py "$taskId"
```

**任务生命周期：**

```
created → prepared → merge_broadcast → funding_broadcast → 
chunk_broadcast → index_broadcast → completed
```

**错误响应：**

| 代码 | 消息 | 说明 |
|------|---------|-------------|
| 1001 | File size exceeds maximum limit | 文件超出绝对大小限制 |
| 1002 | Invalid address format | 地址不是有效的 MVC 地址 |
| 1003 | Invalid metaId | MetaID 格式不正确 |
| 1004 | Invalid base64 content | 内容未正确进行 base64 编码 |
| 1005 | Chain not supported | 目前仅支持 MVC 链 |

---

## 任务监控 APIs

### GET /api/v1/files/task/:taskId

获取分块上传任务的当前状态和进度。

**请求：**

```bash
curl https://file.metaid.io/metafile-uploader/api/v1/files/task/task_abc123def456
```

**响应（进行中）：**

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "taskId": "task_abc123def456",
    "status": "processing",
    "progress": 45,
    "stage": "chunk_broadcast",
    "message": "Broadcasting chunk 3 of 5",
    "createdAt": "2025-02-11T10:30:00Z",
    "updatedAt": "2025-02-11T10:32:15Z"
  }
}
```

**响应（已完成）：**

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "taskId": "task_abc123def456",
    "status": "success",
    "progress": 100,
    "stage": "completed",
    "message": "Upload completed successfully",
    "indexTxId": "def456ghi789jkl012...",
    "chunkTxIds": [
      "chunk1_abc123...",
      "chunk2_def456...",
      "chunk3_ghi789...",
      "chunk4_jkl012...",
      "chunk5_mno345..."
    ],
    "createdAt": "2025-02-11T10:30:00Z",
    "completedAt": "2025-02-11T10:35:22Z"
  }
}
```

**响应（失败）：**

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "taskId": "task_abc123def456",
    "status": "failed",
    "progress": 60,
    "stage": "index_broadcast",
    "message": "Failed to broadcast index transaction: insufficient balance",
    "createdAt": "2025-02-11T10:30:00Z",
    "failedAt": "2025-02-11T10:34:05Z"
  }
}
```

**响应字段：**

| 字段 | 类型 | 说明 |
|-------|------|-------------|
| `taskId` | string | 任务标识符 |
| `status` | string | 任务状态（`created`、`processing`、`success`、`failed`） |
| `progress` | integer | 进度百分比（0-100） |
| `stage` | string | 当前处理阶段 |
| `message` | string | 状态消息或错误描述 |
| `indexTxId` | string | 索引交易 ID（完成时可用） |
| `chunkTxIds` | array | 分块交易 ID 数组（完成时可用） |
| `createdAt` | string | 任务创建时间戳（ISO 8601） |
| `updatedAt` | string | 最后更新时间戳（ISO 8601） |
| `completedAt` | string | 完成时间戳（ISO 8601，仅成功时） |
| `failedAt` | string | 失败时间戳（ISO 8601，仅失败时） |

**使用监控脚本：**

```bash
# 使用 monitor_task.py 脚本
python scripts/monitor_task.py task_abc123def456 600 5

# 手动轮询
while true; do
  status=$(curl -s https://file.metaid.io/metafile-uploader/api/v1/files/task/task_abc123def456 | jq -r '.data.status')
  progress=$(curl -s https://file.metaid.io/metafile-uploader/api/v1/files/task/task_abc123def456 | jq -r '.data.progress')
  echo "Status: $status | Progress: $progress%"
  
  if [ "$status" == "success" ] || [ "$status" == "failed" ]; then
    break
  fi
  
  sleep 5
done
```

---

### GET /api/v1/files/tasks

列出指定地址的上传任务。

**请求：**

```bash
curl "https://file.metaid.io/metafile-uploader/api/v1/files/tasks?address=1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa&limit=10&cursor=0"
```

**查询参数：**

| 参数 | 类型 | 必填 | 说明 | 示例 |
|-----------|------|----------|-------------|---------|
| `address` | string | 是 | MVC 区块链地址 | `"1A1zP1eP..."` |
| `limit` | integer | 否 | 返回的任务数量（默认：10） | `10` |
| `cursor` | integer | 否 | 分页游标（默认：0） | `0` |

**响应：**

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "tasks": [
      {
        "taskId": "task_abc123",
        "fileName": "video1.mp4",
        "status": "success",
        "progress": 100,
        "indexTxId": "def456...",
        "createdAt": "2025-02-11T10:30:00Z",
        "completedAt": "2025-02-11T10:35:22Z"
      },
      {
        "taskId": "task_def456",
        "fileName": "video2.mp4",
        "status": "processing",
        "progress": 45,
        "createdAt": "2025-02-11T11:00:00Z"
      }
    ],
    "hasMore": true,
    "nextCursor": 10
  }
}
```

**响应字段：**

| 字段 | 类型 | 说明 |
|-------|------|-------------|
| `tasks` | array | 任务对象数组 |
| `hasMore` | boolean | 是否有更多任务可用 |
| `nextCursor` | integer | 下一页的游标 |

**使用示例：**

```bash
# 获取第一页
curl "https://file.metaid.io/metafile-uploader/api/v1/files/tasks?address=$address&limit=10&cursor=0" | jq '.'

# 获取下一页
cursor=$(curl -s "https://file.metaid.io/metafile-uploader/api/v1/files/tasks?address=$address&limit=10&cursor=0" | jq -r '.data.nextCursor')
curl "https://file.metaid.io/metafile-uploader/api/v1/files/tasks?address=$address&limit=10&cursor=$cursor" | jq '.'
```

---

## 错误码

### 常见错误码

| 代码 | 消息 | 说明 | 解决方案 |
|------|---------|-------------|----------|
| 0 | success | 请求成功 | - |
| 1001 | File size exceeds limit | 文件太大 | 检查配置限制，压缩文件 |
| 1002 | Invalid address format | 地址格式无效 | 验证 MVC 地址格式 |
| 1003 | Invalid metaId | MetaID 格式无效 | 使用 `calculate_metaid.py` 重新计算 |
| 1004 | Invalid base64 content | 内容编码无效 | 使用 `read_file_base64.py` 重新编码 |
| 1005 | Chain not supported | 不支持的区块链 | 仅对 chain 参数使用 `mvc` |
| 1006 | Insufficient balance | 钱包余额不足 | 向钱包添加资金 |
| 1007 | Transaction broadcast failed | 广播到网络失败 | 检查网络状态，重试 |
| 1008 | Task not found | TaskId 不存在 | 验证 taskId 是否正确 |
| 1009 | Invalid operation | 不支持的操作类型 | 使用 `create`、`modify` 或 `revoke` |
| 1010 | Invalid contentType | MIME 类型格式无效 | 使用带 `;binary` 的正确 MIME 类型 |

### HTTP 状态码

| 状态 | 说明 | 常见原因 |
|--------|-------------|---------------|
| 200 | OK | 请求成功 |
| 400 | Bad Request | 无效的请求参数 |
| 401 | Unauthorized | 身份验证失败（如果需要） |
| 404 | Not Found | 未找到端点或资源 |
| 413 | Request Entity Too Large | 请求体超出限制 |
| 429 | Too Many Requests | 超出速率限制 |
| 500 | Internal Server Error | 服务器端错误 |
| 503 | Service Unavailable | 服务暂时不可用 |

### 错误响应格式

所有错误响应遵循此格式：

```json
{
  "code": 1001,
  "message": "File size exceeds limit",
  "data": null
}
```

或带有附加详细信息：

```json
{
  "code": 1002,
  "message": "Invalid address format",
  "data": {
    "field": "address",
    "value": "invalid_address",
    "expected": "Valid MVC address starting with 1 or 3"
  }
}
```

---

## 速率限制

**当前限制：**
- 直接上传：每分钟每 IP 100 次请求
- 分块上传任务：每分钟每 IP 50 次请求
- 任务查询：每分钟每 IP 300 次请求

**响应头：**
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1644589200
```

**当速率受限时：**
```json
{
  "code": 1011,
  "message": "Rate limit exceeded",
  "data": {
    "retryAfter": 60
  }
}
```

---

## 最佳实践

### 1. 请求优化

**应该：**
- 对 ≤5MB 的文件使用直接上传
- 为重试实现指数退避
- 缓存配置响应
- 上传前验证文件大小

**不应该：**
- 通过直接上传上传 >5MB 的文件
- 失败后立即重试
- 进行不必要的配置请求
- 未验证就上传

### 2. 错误处理

```bash
# 带指数退避的重试逻辑示例
max_retries=3
retry_delay=1

for i in $(seq 1 $max_retries); do
  response=$(curl -s -X POST ...)
  code=$(echo "$response" | jq -r '.code')
  
  if [ "$code" == "0" ]; then
    echo "Success"
    break
  fi
  
  if [ $i -lt $max_retries ]; then
    echo "Retry $i failed, waiting ${retry_delay}s..."
    sleep $retry_delay
    retry_delay=$((retry_delay * 2))
  fi
done
```

### 3. 进度监控

```python
# 推荐的轮询间隔
file_size_mb = file_size / (1024 * 1024)

if file_size_mb <= 10:
    interval = 3  # 3 秒
elif file_size_mb <= 50:
    interval = 5  # 5 秒
else:
    interval = 10  # 10 秒

monitor_task(task_id, interval=interval)
```

### 4. 安全

- **永远不要记录敏感数据**：不要记录钱包私钥或助记词
- **验证输入**：始终验证文件内容和参数
- **使用 HTTPS**：永远不要对 API 请求使用 HTTP
- **安全存储**：安全地存储钱包信息

---

## 示例

### 完整上传流程

```bash
#!/bin/bash
set -e

# 配置
API_BASE="https://file.metaid.io/metafile-uploader"
FILE_PATH="res/file/test.png"

# 1. 获取钱包信息
address=$(cat account.json | jq -r '.accountList[0].mvcAddress')
metaId=$(python scripts/calculate_metaid.py "$address" | jq -r '.metaId')

echo "Using address: $address"
echo "MetaID: $metaId"

# 2. 读取和编码文件
fileData=$(python scripts/read_file_base64.py "$FILE_PATH")
fileName=$(echo "$fileData" | jq -r '.fileName')
fileContent=$(echo "$fileData" | jq -r '.base64Content')
contentType=$(echo "$fileData" | jq -r '.contentType')
uploadMethod=$(echo "$fileData" | jq -r '.uploadMethod')
fileSizeMB=$(echo "$fileData" | jq -r '.fileSizeMB')

echo "File: $fileName ($fileSizeMB MB)"
echo "Method: $uploadMethod"

# 3. 根据大小上传
if [ "$uploadMethod" == "direct" ]; then
  echo "Using direct upload..."
  response=$(curl -s -X POST "$API_BASE/api/v1/files/direct-upload" \
    -H "Content-Type: application/json" \
    -d "{
      \"metaId\": \"$metaId\",
      \"address\": \"$address\",
      \"fileName\": \"$fileName\",
      \"content\": \"$fileContent\",
      \"path\": \"/file\",
      \"contentType\": \"$contentType\",
      \"operation\": \"create\",
      \"feeRate\": 1
    }")
  
  echo "Response: $response"
  txId=$(echo "$response" | jq -r '.data.txId')
  pinId=$(echo "$response" | jq -r '.data.pinId')
  
  echo "✅ Upload successful!"
  echo "TxID: $txId"
  echo "PinID: $pinId"
  echo "View: https://www.mvcscan.com/tx/$txId"
else
  echo "Using chunked upload..."
  response=$(curl -s -X POST "$API_BASE/api/v1/files/chunked-upload-task" \
    -H "Content-Type: application/json" \
    -d "{
      \"metaId\": \"$metaId\",
      \"address\": \"$address\",
      \"fileName\": \"$fileName\",
      \"content\": \"$fileContent\",
      \"path\": \"/file\",
      \"contentType\": \"$contentType\",
      \"operation\": \"create\",
      \"chain\": \"mvc\",
      \"feeRate\": 1
    }")
  
  taskId=$(echo "$response" | jq -r '.data.taskId')
  echo "Task created: $taskId"
  
  # 监控任务
  python scripts/monitor_task.py "$taskId" 600 5
fi
```

---

## 相关文档

- **[SKILL.md](../SKILL.md)** - 主要技能文档
- **[上传示例](upload_examples.md)** - 实用使用示例
- **[Swagger 文档](https://file.metaid.io/metafile-uploader/swagger/index.html)** - 交互式 API 文档

---

**最后更新**：2025-02-11
