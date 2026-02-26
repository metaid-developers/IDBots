# 上传示例

展示文件上传到 MetaID 文件系统的实际示例。

## 目录

- [示例 1：简单小文件上传](#示例-1简单小文件上传)
- [示例 2：带进度跟踪的大文件上传](#示例-2带进度跟踪的大文件上传)
- [示例 3：批量上传多个文件](#示例-3批量上传多个文件)
- [示例 4：带错误处理的上传](#示例-4带错误处理的上传)
- [示例 5：自定义路径和内容类型](#示例-5自定义路径和内容类型)
- [示例 6：恢复失败的上传](#示例-6恢复失败的上传)

---

## 示例 1：简单小文件上传

使用直接上传方式上传小图片文件（< 5MB）。

### 场景

您有一张个人资料照片（2.3 MB）需要上传到区块链。

### 完整工作流

```bash
#!/bin/bash
# simple_upload.sh - 上传小文件

# 第 1 步：准备钱包信息
address=$(cat account.json | jq -r '.accountList[0].mvcAddress')
metaId=$(python .claude/skills/metabot-file/scripts/calculate_metaid.py "$address" | jq -r '.metaId')

echo "📍 使用地址: $address"
echo "🔑 MetaID: $metaId"

# 第 2 步：准备文件
FILE_PATH="res/file/profile_photo.jpg"

if [ ! -f "$FILE_PATH" ]; then
  echo "❌ 文件未找到: $FILE_PATH"
  exit 1
fi

# 第 3 步：读取并编码文件
echo "📖 正在读取文件..."
fileData=$(python .claude/skills/metabot-file/scripts/read_file_base64.py "$FILE_PATH")

fileName=$(echo "$fileData" | jq -r '.fileName')
fileContent=$(echo "$fileData" | jq -r '.base64Content')
contentType=$(echo "$fileData" | jq -r '.contentType')
fileSizeMB=$(echo "$fileData" | jq -r '.fileSizeMB')

echo "📁 文件: $fileName"
echo "📊 大小: $fileSizeMB MB"
echo "📄 类型: $contentType"

# 第 4 步：上传
echo "🚀 正在上传..."
response=$(curl -s -X POST https://file.metaid.io/metafile-uploader/api/v1/files/direct-upload \
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

# 第 5 步：检查结果
code=$(echo "$response" | jq -r '.code')

if [ "$code" == "0" ]; then
  txId=$(echo "$response" | jq -r '.data.txId')
  pinId=$(echo "$response" | jq -r '.data.pinId')
  
  echo ""
  echo "✅ 上传成功！"
  echo "📦 交易 ID: $txId"
  echo "📌 PinID: $pinId"
  echo "🔗 在区块链上查看: https://www.mvcscan.com/tx/$txId"
  echo "🔗 查看 pin: https://man.metaid.io/pin/$pinId"
else
  message=$(echo "$response" | jq -r '.message')
  echo "❌ 上传失败: $message"
  exit 1
fi
```

### 预期输出

```
📍 使用地址: 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa
🔑 MetaID: a7f8d9e1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6
📖 正在读取文件...
📁 文件: profile_photo.jpg
📊 大小: 2.34 MB
📄 类型: image/jpeg;binary

🚀 正在上传...

✅ 上传成功！
📦 交易 ID: abc123def456ghi789jkl012mno345pqr678stu901
📌 PinID: abc123def456ghi789jkl012mno345pqr678stu901i0
🔗 在区块链上查看: https://www.mvcscan.com/tx/abc123def456ghi789jkl012mno345pqr678stu901
🔗 查看 pin: https://man.metaid.io/pin/abc123def456ghi789jkl012mno345pqr678stu901i0
```

---

## 示例 2：带进度跟踪的大文件上传

使用分块上传方式上传大视频文件（15 MB），并实时跟踪进度。

### 场景

您需要上传一个教程视频（15 MB）并希望跟踪上传进度。

### 完整工作流

```bash
#!/bin/bash
# large_file_upload.sh - 带进度的大文件上传

set -e

# 配置
FILE_PATH="res/file/tutorial_video.mp4"
API_BASE="https://file.metaid.io/metafile-uploader"

# 第 1 步：钱包信息
address=$(cat account.json | jq -r '.accountList[0].mvcAddress')
metaId=$(python .claude/skills/metabot-file/scripts/calculate_metaid.py "$address" | jq -r '.metaId')

echo "📍 地址: $address"
echo "🔑 MetaID: $metaId"
echo ""

# 第 2 步：读取文件
echo "📖 正在读取文件: $FILE_PATH"
fileData=$(python .claude/skills/metabot-file/scripts/read_file_base64.py "$FILE_PATH")

fileName=$(echo "$fileData" | jq -r '.fileName')
fileContent=$(echo "$fileData" | jq -r '.base64Content')
contentType=$(echo "$fileData" | jq -r '.contentType')
fileSizeMB=$(echo "$fileData" | jq -r '.fileSizeMB')
uploadMethod=$(echo "$fileData" | jq -r '.uploadMethod')

echo "📁 文件: $fileName"
echo "📊 大小: $fileSizeMB MB"
echo "🚀 方式: $uploadMethod 上传"
echo ""

# 第 3 步：创建上传任务
echo "📦 正在创建上传任务..."
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

code=$(echo "$response" | jq -r '.code')

if [ "$code" != "0" ]; then
  message=$(echo "$response" | jq -r '.message')
  echo "❌ 创建任务失败: $message"
  exit 1
fi

taskId=$(echo "$response" | jq -r '.data.taskId')
echo "✅ 任务已创建: $taskId"
echo ""

# 第 4 步：监控进度
echo "🔍 正在监控进度..."
echo "大文件可能需要几分钟"
echo ""

python .claude/skills/metabot-file/scripts/monitor_task.py "$taskId" 600 5

# 第 5 步：显示结果
echo ""
echo "上传成功完成！"
```

### 预期输出

```
📍 地址: 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa
🔑 MetaID: a7f8d9e1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6

📖 正在读取文件: res/file/tutorial_video.mp4
📁 文件: tutorial_video.mp4
📊 大小: 15.23 MB
🚀 方式: chunked 上传

📦 正在创建上传任务...
✅ 任务已创建: task_abc123def456

🔍 正在监控进度...
大文件可能需要几分钟

🔍 监控任务: task_abc123def456
⏰ 超时: 600s | 间隔: 5s

[0s] [░░░░░░░░░░░░░░░░░░░░] 0% | created | created
[5s] [██░░░░░░░░░░░░░░░░░░] 10% | processing | prepared
[10s] [████░░░░░░░░░░░░░░░░] 20% | processing | merge_broadcast
[15s] [██████░░░░░░░░░░░░░░] 30% | processing | funding_broadcast
[25s] [████████░░░░░░░░░░░░] 40% | processing | chunk_broadcast
[35s] [████████████░░░░░░░░] 60% | processing | chunk_broadcast
[45s] [██████████████░░░░░░] 70% | processing | chunk_broadcast
[55s] [████████████████░░░░] 80% | processing | index_broadcast
[65s] [████████████████████] 100% | success | completed

✅ 上传成功完成！
📦 索引 TxID: def456ghi789jkl012mno345pqr678stu901vwx234
📌 PinID: def456ghi789jkl012mno345pqr678stu901vwx234i0
🧩 分块交易数: 8

{
  "success": true,
  "taskId": "task_abc123def456",
  "status": "success",
  "indexTxId": "def456ghi789jkl012mno345pqr678stu901vwx234",
  "pinId": "def456ghi789jkl012mno345pqr678stu901vwx234i0",
  "chunkTxIds": [
    "chunk1_abc...",
    "chunk2_def...",
    "chunk3_ghi...",
    "chunk4_jkl...",
    "chunk5_mno...",
    "chunk6_pqr...",
    "chunk7_stu...",
    "chunk8_vwx..."
  ],
  "chunkCount": 8,
  "viewUrls": {
    "transaction": "https://www.mvcscan.com/tx/def456ghi789jkl012mno345pqr678stu901vwx234",
    "pin": "https://man.metaid.io/pin/def456ghi789jkl012mno345pqr678stu901vwx234i0"
  }
}

上传成功完成！
```

---

## 示例 3：批量上传多个文件

按顺序上传多个文件，并进行适当的错误处理。

### 场景

您有一组照片（5 个文件）需要上传。

### 完整工作流

```bash
#!/bin/bash
# batch_upload.sh - 上传多个文件

set -e

# 配置
API_BASE="https://file.metaid.io/metafile-uploader"
FILES_DIR="res/file/photos"

# 钱包信息
address=$(cat account.json | jq -r '.accountList[0].mvcAddress')
metaId=$(python .claude/skills/metabot-file/scripts/calculate_metaid.py "$address" | jq -r '.metaId')

echo "📍 地址: $address"
echo "🔑 MetaID: $metaId"
echo ""
echo "📂 从以下位置上传文件: $FILES_DIR"
echo ""

# 初始化计数器
total_files=0
successful_uploads=0
failed_uploads=0

# 结果数组
declare -a upload_results

# 处理每个文件
for file in "$FILES_DIR"/*; do
  if [ -f "$file" ]; then
    total_files=$((total_files + 1))
    filename=$(basename "$file")
    
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📤 [$total_files] 正在上传: $filename"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    # 读取文件
    fileData=$(python .claude/skills/metabot-file/scripts/read_file_base64.py "$file" 2>/dev/null)
    
    if [ $? -ne 0 ]; then
      echo "❌ 读取文件失败: $filename"
      failed_uploads=$((failed_uploads + 1))
      upload_results+=("❌ $filename - 读取失败")
      continue
    fi
    
    fileName=$(echo "$fileData" | jq -r '.fileName')
    fileContent=$(echo "$fileData" | jq -r '.base64Content')
    contentType=$(echo "$fileData" | jq -r '.contentType')
    uploadMethod=$(echo "$fileData" | jq -r '.uploadMethod')
    fileSizeMB=$(echo "$fileData" | jq -r '.fileSizeMB')
    
    echo "大小: $fileSizeMB MB | 方式: $uploadMethod"
    
    # 根据方式上传
    if [ "$uploadMethod" == "direct" ]; then
      # 直接上传
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
      
      code=$(echo "$response" | jq -r '.code')
      
      if [ "$code" == "0" ]; then
        pinId=$(echo "$response" | jq -r '.data.pinId')
        echo "✅ 成功 - PinID: $pinId"
        successful_uploads=$((successful_uploads + 1))
        upload_results+=("✅ $filename - $pinId")
      else
        message=$(echo "$response" | jq -r '.message')
        echo "❌ 失败: $message"
        failed_uploads=$((failed_uploads + 1))
        upload_results+=("❌ $filename - $message")
      fi
    else
      # 分块上传
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
      
      code=$(echo "$response" | jq -r '.code')
      
      if [ "$code" == "0" ]; then
        taskId=$(echo "$response" | jq -r '.data.taskId')
        echo "📦 任务已创建: $taskId"
        
        # 监控任务（静默）
        result=$(python .claude/skills/metabot-file/scripts/monitor_task.py "$taskId" 600 5 2>/dev/null)
        success=$(echo "$result" | jq -r '.success')
        
        if [ "$success" == "true" ]; then
          pinId=$(echo "$result" | jq -r '.pinId')
          echo "✅ 成功 - PinID: $pinId"
          successful_uploads=$((successful_uploads + 1))
          upload_results+=("✅ $filename - $pinId")
        else
          error=$(echo "$result" | jq -r '.error')
          echo "❌ 失败: $error"
          failed_uploads=$((failed_uploads + 1))
          upload_results+=("❌ $filename - $error")
        fi
      else
        message=$(echo "$response" | jq -r '.message')
        echo "❌ 创建任务失败: $message"
        failed_uploads=$((failed_uploads + 1))
        upload_results+=("❌ $filename - $message")
      fi
    fi
    
    echo ""
  fi
done

# 显示摘要
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 上传摘要"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "总文件数: $total_files"
echo "✅ 成功: $successful_uploads"
echo "❌ 失败: $failed_uploads"
echo ""
echo "结果:"
for result in "${upload_results[@]}"; do
  echo "  $result"
done
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
```

### 预期输出

```
📍 地址: 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa
🔑 MetaID: a7f8d9e1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6

📂 从以下位置上传文件: res/file/photos

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📤 [1] 正在上传: photo1.jpg
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
大小: 2.1 MB | 方式: direct
✅ 成功 - PinID: abc123...i0

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📤 [2] 正在上传: photo2.jpg
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
大小: 3.4 MB | 方式: direct
✅ 成功 - PinID: def456...i0

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📤 [3] 正在上传: photo3.jpg
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
大小: 1.8 MB | 方式: direct
✅ 成功 - PinID: ghi789...i0

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📤 [4] 正在上传: photo4.jpg
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
大小: 4.2 MB | 方式: direct
✅ 成功 - PinID: jkl012...i0

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📤 [5] 正在上传: photo5.jpg
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
大小: 2.9 MB | 方式: direct
✅ 成功 - PinID: mno345...i0

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 上传摘要
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
总文件数: 5
✅ 成功: 5
❌ 失败: 0

结果:
  ✅ photo1.jpg - abc123...i0
  ✅ photo2.jpg - def456...i0
  ✅ photo3.jpg - ghi789...i0
  ✅ photo4.jpg - jkl012...i0
  ✅ photo5.jpg - mno345...i0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 示例 4：带错误处理的上传

具有重试逻辑和错误恢复的健壮上传脚本。

### 场景

上传文件时，对瞬态故障进行自动重试。

### 完整工作流

```bash
#!/bin/bash
# robust_upload.sh - 带重试逻辑的上传

# 配置
MAX_RETRIES=3
RETRY_DELAY=5
API_BASE="https://file.metaid.io/metafile-uploader"

# 函数：带重试的上传
upload_with_retry() {
  local file_path="$1"
  local retry_count=0
  
  while [ $retry_count -lt $MAX_RETRIES ]; do
    echo "🔄 尝试 $((retry_count + 1))/$MAX_RETRIES"
    
    # 获取钱包信息
    address=$(cat account.json | jq -r '.accountList[0].mvcAddress')
    metaId=$(python .claude/skills/metabot-file/scripts/calculate_metaid.py "$address" | jq -r '.metaId')
    
    # 读取文件
    fileData=$(python .claude/skills/metabot-file/scripts/read_file_base64.py "$file_path" 2>&1)
    
    if [ $? -ne 0 ]; then
      echo "❌ 读取文件失败"
      return 1
    fi
    
    fileName=$(echo "$fileData" | jq -r '.fileName')
    fileContent=$(echo "$fileData" | jq -r '.base64Content')
    contentType=$(echo "$fileData" | jq -r '.contentType')
    
    # 上传
    response=$(curl -s -w "\n%{http_code}" -X POST "$API_BASE/api/v1/files/direct-upload" \
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
    
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n-1)
    
    # 检查 HTTP 状态
    if [ "$http_code" == "200" ]; then
      code=$(echo "$body" | jq -r '.code')
      
      if [ "$code" == "0" ]; then
        # 成功
        pinId=$(echo "$body" | jq -r '.data.pinId')
        echo "✅ 上传成功！"
        echo "📌 PinID: $pinId"
        return 0
      else
        # API 错误
        message=$(echo "$body" | jq -r '.message')
        echo "⚠️  API 错误: $message"
        
        # 检查错误是否可重试
        if [[ "$message" == *"timeout"* ]] || [[ "$message" == *"network"* ]]; then
          echo "🔄 可重试的错误，将重试..."
        else
          echo "❌ 不可重试的错误，放弃"
          return 1
        fi
      fi
    elif [ "$http_code" == "429" ]; then
      echo "⚠️  速率受限，正在等待..."
    elif [ "$http_code" == "503" ]; then
      echo "⚠️  服务不可用，正在等待..."
    else
      echo "⚠️  HTTP 错误: $http_code"
    fi
    
    # 增加重试计数
    retry_count=$((retry_count + 1))
    
    if [ $retry_count -lt $MAX_RETRIES ]; then
      wait_time=$((RETRY_DELAY * retry_count))
      echo "⏰ 等待 ${wait_time}s 后重试..."
      sleep $wait_time
    fi
  done
  
  echo "❌ $MAX_RETRIES 次尝试后失败"
  return 1
}

# 主程序
FILE_PATH="res/file/document.pdf"

echo "📤 正在上传: $FILE_PATH"
echo ""

if upload_with_retry "$FILE_PATH"; then
  echo ""
  echo "🎉 上传成功完成！"
else
  echo ""
  echo "💥 所有重试后上传失败"
  exit 1
fi
```

---

## 示例 5：自定义路径和内容类型

将文件上传到自定义 MetaID 路径，并指定特定的内容类型。

### 场景

将个人资料头像上传到 `/avatar` 路径。

### 完整工作流

```bash
#!/bin/bash
# custom_path_upload.sh - 上传到自定义路径

# 配置
FILE_PATH="res/file/avatar.png"
METAID_PATH="/avatar"  # 头像的自定义路径
API_BASE="https://file.metaid.io/metafile-uploader"

# 钱包信息
address=$(cat account.json | jq -r '.accountList[0].mvcAddress')
metaId=$(python .claude/skills/metabot-file/scripts/calculate_metaid.py "$address" | jq -r '.metaId')

echo "📤 正在将头像上传到自定义路径"
echo "📍 地址: $address"
echo "📁 文件: $FILE_PATH"
echo "🗂️  路径: $METAID_PATH"
echo ""

# 读取文件
fileData=$(python .claude/skills/metabot-file/scripts/read_file_base64.py "$FILE_PATH")

fileName=$(echo "$fileData" | jq -r '.fileName')
fileContent=$(echo "$fileData" | jq -r '.base64Content')
contentType=$(echo "$fileData" | jq -r '.contentType')

echo "📄 Content-Type: $contentType"
echo ""

# 上传
echo "🚀 正在上传..."
response=$(curl -s -X POST "$API_BASE/api/v1/files/direct-upload" \
  -H "Content-Type: application/json" \
  -d "{
    \"metaId\": \"$metaId\",
    \"address\": \"$address\",
    \"fileName\": \"$fileName\",
    \"content\": \"$fileContent\",
    \"path\": \"$METAID_PATH\",
    \"contentType\": \"$contentType\",
    \"operation\": \"create\",
    \"feeRate\": 1
  }")

code=$(echo "$response" | jq -r '.code')

if [ "$code" == "0" ]; then
  pinId=$(echo "$response" | jq -r '.data.pinId')
  echo "✅ 头像上传成功！"
  echo "📌 PinID: $pinId"
  echo "🔗 查看: https://man.metaid.io/pin/$pinId"
else
  message=$(echo "$response" | jq -r '.message')
  echo "❌ 上传失败: $message"
  exit 1
fi
```

---

## 示例 6：恢复失败的上传

监控并恢复失败的分块上传任务。

### 场景

分块上传任务失败了。检查其状态，并可能恢复或重新启动。

### 完整工作流

```bash
#!/bin/bash
# resume_upload.sh - 检查并恢复失败的上传

API_BASE="https://file.metaid.io/metafile-uploader"
TASK_ID="$1"

if [ -z "$TASK_ID" ]; then
  echo "用法: $0 <task_id>"
  exit 1
fi

echo "🔍 正在检查任务状态: $TASK_ID"
echo ""

# 查询任务状态
response=$(curl -s "$API_BASE/api/v1/files/task/$TASK_ID")
code=$(echo "$response" | jq -r '.code')

if [ "$code" != "0" ]; then
  message=$(echo "$response" | jq -r '.message')
  echo "❌ 查询任务失败: $message"
  exit 1
fi

status=$(echo "$response" | jq -r '.data.status')
progress=$(echo "$response" | jq -r '.data.progress')
stage=$(echo "$response" | jq -r '.data.stage')
message=$(echo "$response" | jq -r '.data.message')

echo "📊 任务状态"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "状态: $status"
echo "进度: $progress%"
echo "阶段: $stage"
echo "消息: $message"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

case "$status" in
  "success")
    indexTxId=$(echo "$response" | jq -r '.data.indexTxId')
    echo "✅ 任务已成功完成！"
    echo "📦 索引 TxID: $indexTxId"
    echo "📌 PinID: ${indexTxId}i0"
    ;;
    
  "failed")
    echo "❌ 任务失败"
    echo ""
    echo "选项:"
    echo "1. 查看上面的错误消息"
    echo "2. 检查钱包余额和网络状态"
    echo "3. 为同一文件创建新的上传任务"
    echo ""
    echo "创建新任务:"
    echo "  bash upload_script.sh <file_path>"
    ;;
    
  "processing" | "created")
    echo "🔄 任务仍在进行中"
    echo ""
    echo "继续监控？(y/n)"
    read -r continue_monitor
    
    if [ "$continue_monitor" == "y" ]; then
      python .claude/skills/metabot-file/scripts/monitor_task.py "$TASK_ID" 600 5
    else
      echo "任务 ID 已保存供以后监控: $TASK_ID"
    fi
    ;;
    
  *)
    echo "⚠️  未知状态: $status"
    ;;
esac
```

---

## 故障排除示例

### 调试上传失败

```bash
#!/bin/bash
# debug_upload.sh - 调试上传问题

FILE_PATH="$1"

echo "🔍 正在调试上传: $FILE_PATH"
echo ""

# 1. 检查文件是否存在
if [ ! -f "$FILE_PATH" ]; then
  echo "❌ 文件不存在: $FILE_PATH"
  exit 1
fi
echo "✅ 文件存在"

# 2. 检查文件大小
file_size=$(stat -f%z "$FILE_PATH" 2>/dev/null || stat -c%s "$FILE_PATH")
file_size_mb=$(echo "scale=2; $file_size / 1024 / 1024" | bc)
echo "✅ 文件大小: $file_size_mb MB ($file_size bytes)"

# 3. 检查钱包
if [ ! -f "account.json" ]; then
  echo "❌ 未找到 account.json"
  exit 1
fi
echo "✅ 找到钱包文件"

address=$(cat account.json | jq -r '.accountList[0].mvcAddress')
if [ "$address" == "null" ] || [ -z "$address" ]; then
  echo "❌ account.json 中没有钱包地址"
  exit 1
fi
echo "✅ 钱包地址: $address"

# 4. 测试文件读取
echo "正在测试文件读取..."
fileData=$(python .claude/skills/metabot-file/scripts/read_file_base64.py "$FILE_PATH" 2>&1)
if [ $? -ne 0 ]; then
  echo "❌ 读取文件失败:"
  echo "$fileData"
  exit 1
fi
echo "✅ 文件读取成功"

# 5. 测试 API 连接性
echo "正在测试 API 连接性..."
health_response=$(curl -s -w "\n%{http_code}" https://file.metaid.io/metafile-uploader/health)
http_code=$(echo "$health_response" | tail -n1)

if [ "$http_code" == "200" ]; then
  echo "✅ API 可访问"
else
  echo "❌ API 不可访问 (HTTP $http_code)"
  exit 1
fi

# 6. 获取 API 配置
echo "正在获取 API 配置..."
config=$(curl -s https://file.metaid.io/metafile-uploader/api/v1/config)
max_size=$(echo "$config" | jq -r '.data.maxFileSize')
max_size_mb=$(echo "scale=2; $max_size / 1024 / 1024" | bc)
echo "✅ 最大文件大小: $max_size_mb MB"

if [ $(echo "$file_size > $max_size" | bc) -eq 1 ]; then
  echo "⚠️  警告: 文件超出最大大小限制！"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "所有检查通过！准备上传。"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
```

---

## 相关文档

- **[SKILL.md](../SKILL.md)** - 主要技能文档
- **[API 参考文档](api_reference.md)** - 完整 API 规范

---

**最后更新**：2025-02-11
