#!/bin/bash
#
# 带余额检查的完整文件上传脚本
#
# 功能:
# 1. 从 account.json 读取钱包地址
# 2. 检查余额是否足够
# 3. 读取并编码文件
# 4. 根据文件大小选择上传方式
# 5. 监控上传进度(如果需要)
# 6. 显示最终结果
#
# 使用方法:
#   bash upload_with_balance_check.sh <file_path> [--agent <keyword>] [--account-index <n>]
#
# 示例:
#   bash upload_with_balance_check.sh res/file/photo.jpg
#   bash upload_with_balance_check.sh res/file/video.mp4 --agent "<agent_name>"
#   bash upload_with_balance_check.sh res/file/photo.jpg --account-index 1

set -e

# 配置
API_BASE="https://file.metaid.io/metafile-uploader"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../../" && pwd)"
SKILL_DIR="$PROJECT_ROOT/.claude/skills/metabot-file"
METABOT_DIR="$PROJECT_ROOT/.claude/skills/metabot-basic"
ACCOUNT_FILE="$PROJECT_ROOT/account.json"
# 可选: 指定 agent 关键词或 account 索引（由本 skill 的 metafs_*.ts 解析）
AGENT_ARGS=""

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 打印带颜色的消息
print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

# 解析参数: <file_path> [--agent <keyword>] [--account-index <n>]
if [ $# -eq 0 ]; then
    echo "用法: $0 <file_path> [--agent <keyword>] [--account-index <n>]"
    echo ""
    echo "示例:"
    echo "  $0 res/file/photo.jpg"
    echo "  $0 res/file/video.mp4 --agent \"<agent_name>\""
    echo "  $0 res/file/photo.jpg --account-index 1"
    exit 1
fi

FILE_PATH="$1"
shift || true

while [ $# -gt 0 ]; do
    if [ "$1" = "--agent" ] && [ -n "${2:-}" ]; then
        AGENT_ARGS="$AGENT_ARGS --keyword \"$2\""
        shift 2
    elif [ "$1" = "--account-index" ] && [ -n "${2:-}" ]; then
        AGENT_ARGS="$AGENT_ARGS --account-index $2"
        shift 2
    else
        shift
    fi
done

# 检查文件是否存在
if [ ! -f "$FILE_PATH" ]; then
    print_error "文件不存在: $FILE_PATH"
    exit 1
fi

print_info "正在上传文件: $FILE_PATH"
echo ""

# === 步骤 1: 读取钱包信息（本 skill 的 metafs_account_info.ts）===
print_info "步骤 1/6: 读取钱包信息..."

if [ ! -f "$ACCOUNT_FILE" ]; then
    print_error "未找到 $ACCOUNT_FILE"
    print_info "请先使用 metabot-basic skill 创建钱包并生成 account.json"
    exit 1
fi

if [ ! -d "$SKILL_DIR" ]; then
    print_error "未找到 metabot-file 目录: $SKILL_DIR"
    exit 1
fi

if [ ! -d "$METABOT_DIR" ]; then
    print_error "未找到 metabot-basic skill 目录: $METABOT_DIR"
    print_info "上链依赖 metabot-basic 的钱包与 API。请先安装 metabot-basic 至 .claude/skills/metabot-basic 并在该目录下执行 npm install。"
    exit 1
fi

accountInfo=$(eval "cd \"$SKILL_DIR\" && npx ts-node scripts/metafs_account_info.ts --account-file \"$ACCOUNT_FILE\" $AGENT_ARGS" 2>&1)
if [ $? -ne 0 ]; then
    print_error "读取账户失败"
    echo "$accountInfo" | head -5 >&2
    exit 1
fi

address=$(echo "$accountInfo" | jq -r '.mvcAddress')
metaId=$(echo "$accountInfo" | jq -r '.metaId')
if [ "$address" == "null" ] || [ -z "$address" ]; then
    print_error "无法解析 mvcAddress"
    exit 1
fi

print_success "地址: $address"
print_success "MetaID: ${metaId:0:16}..."

echo ""

# === 步骤 2: 读取文件信息 ===
print_info "步骤 2/6: 读取文件信息..."

fileData=$(python3 "$SCRIPT_DIR/read_file_base64.py" "$FILE_PATH")
if [ $? -ne 0 ]; then
    print_error "读取文件失败"
    exit 1
fi

fileName=$(echo "$fileData" | jq -r '.fileName')
fileSizeMB=$(echo "$fileData" | jq -r '.fileSizeMB')
uploadMethod=$(echo "$fileData" | jq -r '.uploadMethod')
contentType=$(echo "$fileData" | jq -r '.contentType')
fileContent=$(echo "$fileData" | jq -r '.base64Content')

print_success "文件名: $fileName"
print_success "大小: $fileSizeMB MB"
print_success "上传方式: $uploadMethod"

echo ""

# === 步骤 3: 检查余额（本 skill 的 metafs_check_balance.ts）===
print_info "步骤 3/6: 检查余额..."

balanceResult=$(eval "cd \"$SKILL_DIR\" && npx ts-node scripts/metafs_check_balance.ts --account-file \"$ACCOUNT_FILE\" $AGENT_ARGS --file-size-mb \"$fileSizeMB\" --json" 2>&1)
balanceExitCode=$?

if [ $balanceExitCode -ne 0 ]; then
    print_error "余额检查失败或余额不足"
    echo "" >&2
    print_info "请向以下主网(MVC)地址充值:"
    echo -e "  ${BLUE}$address${NC}" >&2
    print_info "主网充值/查看余额: https://www.mvcscan.com/address/$address"
    exit 1
fi

print_success "余额充足"

# 提取余额信息（脚本只输出一行 JSON）
balanceInfo=$(echo "$balanceResult" | tail -1)
currentBalance=$(echo "$balanceInfo" | jq -r '.balance.formatted')
estimatedFee=$(echo "$balanceInfo" | jq -r '.upload_estimate.estimated_fee_formatted // "N/A"')

if [ "$estimatedFee" != "N/A" ]; then
    print_info "当前余额: $currentBalance"
    print_info "估算费用: $estimatedFee"
fi

echo ""

# === 步骤 4: 上传文件 ===
print_info "步骤 4/6: 上传文件..."

if [ "$uploadMethod" == "direct" ]; then
    # 直接上传：使用本 skill 的 metafs_direct_upload.ts 构建并签名交易，再调用 DirectUpload API（multipart）
    print_info "使用直接上传方式（构建交易并签名后提交）..."
    # 使用绝对路径，因脚本在 SKILL_DIR 下执行，相对路径会相对于该目录
    if [ -z "${FILE_PATH##/*}" ]; then
        FILE_PATH_ABS="$FILE_PATH"
    else
        FILE_PATH_ABS="$PROJECT_ROOT/$FILE_PATH"
    fi
    uploadResult=$(eval "cd \"$SKILL_DIR\" && npx ts-node scripts/metafs_direct_upload.ts --account-file \"$ACCOUNT_FILE\" $AGENT_ARGS --file \"$FILE_PATH_ABS\" --path /file --content-type \"$contentType\"" 2>&1)
    uploadExitCode=$?
    
    if [ $uploadExitCode -ne 0 ]; then
        print_error "上传失败"
        echo "$uploadResult" | grep -E "error|Error" >&2 || echo "$uploadResult" >&2
        exit 1
    fi
    
    uploadJson=$(echo "$uploadResult" | tail -1)
    txId=$(echo "$uploadJson" | jq -r '.txId')
    pinId=$(echo "$uploadJson" | jq -r '.pinId')
    if [ "$txId" = "null" ] || [ -z "$txId" ]; then
        print_error "无法解析上传结果"
        echo "$uploadResult" >&2
        exit 1
    fi
    
    print_success "上传完成！"
    
else
    # 分块上传：使用 metafs_chunked_upload.ts（OSS 分片 → estimate → merge 签名 → 预交易 → 提交 task，不传 content）
    print_info "使用分块上传方式（OSS 分片 + merge/预交易 + 任务）..."
    if [ -z "${FILE_PATH##/*}" ]; then
        FILE_PATH_ABS="$FILE_PATH"
    else
        FILE_PATH_ABS="$PROJECT_ROOT/$FILE_PATH"
    fi
    uploadResult=$(eval "cd \"$SKILL_DIR\" && npx ts-node scripts/metafs_chunked_upload.ts --account-file \"$ACCOUNT_FILE\" $AGENT_ARGS --file \"$FILE_PATH_ABS\" --path /file --content-type \"$contentType\" --fee-rate 1" 2>&1)
    uploadExitCode=$?
    if [ $uploadExitCode -ne 0 ]; then
        print_error "分块上传任务创建失败"
        echo "$uploadResult" | grep -E "error|Error" >&2 || echo "$uploadResult" >&2
        exit 1
    fi
    uploadJson=$(echo "$uploadResult" | tail -1)
    taskId=$(echo "$uploadJson" | jq -r '.taskId')
    if [ "$taskId" = "null" ] || [ -z "$taskId" ]; then
        print_error "无法解析 taskId"
        echo "$uploadResult" >&2
        exit 1
    fi
    print_success "任务已创建: $taskId"
    
    echo ""
    
    # === 步骤 5: 监控任务 ===
    print_info "步骤 5/6: 监控上传进度..."
    # monitor_task.py 进度输出到 stderr，最终单行 JSON 输出到 stdout，便于 jq 解析
    result=$(python3 "$SCRIPT_DIR/monitor_task.py" "$taskId" 600 5)
    monitorExitCode=$?
    
    if [ $monitorExitCode -ne 0 ]; then
        print_error "任务失败或超时"
        [ -n "$result" ] && echo "$result" | jq . 2>/dev/null || true
        exit 1
    fi
    
    # 解析监控输出的单行 JSON（index_tx_id 等由 monitor 转为 camelCase 输出）
    txId=$(echo "$result" | jq -r '.indexTxId')
    pinId=$(echo "$result" | jq -r '.pinId')
    
    print_success "上传完成！"
fi

echo ""

# === 步骤 6: 显示结果 ===
print_info "步骤 6/6: 上传结果"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📦 上传成功！"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "文件名: $fileName"
echo "大小: $fileSizeMB MB"
echo "方式: $uploadMethod"
echo ""
echo "交易 ID: $txId"
echo "PinID: $pinId"
echo ""
echo "🔗 在区块链上查看:"
echo "   https://www.mvcscan.com/tx/$txId"
echo ""
echo "🔗 查看文件 Pin:"
echo "   https://man.metaid.io/pin/$pinId"
echo ""
echo "🔗 直接内容:"
echo "   https://file.metaid.io/metafile-indexer/api/v1/files/content/$pinId"
echo ""
echo "🔗 加速/下载:"
echo "   https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/$pinId"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

print_success "所有步骤完成！"
