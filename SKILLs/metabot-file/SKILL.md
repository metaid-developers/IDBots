---
name: metabot-file
description: MetaBot 专属链上文件系统 (MetaID File System) 交互模块。提供智能文件上链（自动识别大小/分块）、余额预检、交易监控，以及基于 MetaID 的用户资料与文件内容索引查询。
dependencies: metabot-basic, node >= 18.x, python >= 3.7 (requests), crypto-js
---

# metabot-file

赋予 **MetaBot** 读取、存储和索引链上数据的能力。支持将任何文件（图片/视频/文档）永久存储在 MVC 区块链上，并关联到 MetaBot 的 MetaID。

## 核心能力 (Capabilities)

1.  **智能上链**: 自动根据文件大小（5MB 阈值）切换策略：
    * **Direct (<5MB)**: 本地签名 -> Multipart 提交 (同步)。
    * **Chunked (>5MB)**: OSS 分片 -> Merge 签名 -> 任务队列 (异步监控)。
2.  **安全预检**: 上链前自动调用 `metabot-basic` 检查 MVC 余额，避免因 Gas 不足导致 UTXO 锁定或任务失败。
3.  **索引查询**: 查询任意 MetaID 的头像、用户信息，或通过 PinID 获取文件元数据/内容。

## 关键工作流 (Workflows)

### 1. 文件上链 (Primary Action)

当用户指令涉及“上传文件”、“文件上链”、“存图片”时，**MetaBot 必须优先使用**以下一键脚本。该脚本封装了余额检查、方式选择、上传执行和进度监控。

* **执行脚本**: `./scripts/upload_with_balance_check.sh <file_path> [options]`
* **参数**:
    * `<file_path>`: 文件路径 (推荐放在 `res/file/`)。
    * `--agent "Name"`: (可选) 指定使用哪个 MetaBot 账号。在 IDBots Cowork 环境中，当前会话的 MetaBot 钱包信息通过 `IDBOTS_TWIN_*` 环境变量自动注入，无需此参数。
    * `--account-index N`: (可选) 指定账户索引（传统模式，仅当未使用 IDBots Cowork 环境时）。
* **示例**: `bash .claude/skills/metabot-file/scripts/upload_with_balance_check.sh res/file/photo.jpg`
* **禁止**: 不要尝试手动构造 `curl` 请求发送 JSON body 上传，后端仅接受 `multipart/form-data` 且需要复杂的本地签名逻辑 (PreTx构建)，必须依赖 TS 脚本。

### 2. 信息查询 (Query)

查询 MetaBot 信息或链上文件状态。

* **脚本**: `python3 scripts/query_indexer.py <type> [args]`
* **Type - 用户查询**:
    * `user --address <mvc_address>`
    * `user --metaid <metaid>`
    * `user --globalmetaid <gid>`
* **Type - 文件查询**:
    * `file --pinid <pin_id>` (返回元数据、下载链接、预览链接)

## 依赖与配置 (Configuration)

### 1. 环境依赖
* **metabot-basic**: 必须存在且已安装依赖 (`../metabot-basic/node_modules`)。本 Skill 复用其钱包签名逻辑。
* **Python 库**: `pip install requests` (用于监控和查询脚本)。

### 2. 钱包信息获取
脚本按以下优先级获取钱包信息：
1. **IDBots Cowork 环境**（推荐）：通过 `IDBOTS_TWIN_*` 环境变量自动注入当前会话 MetaBot 的钱包信息
   - `IDBOTS_TWIN_MNEMONIC`: 助记词
   - `IDBOTS_TWIN_NAME`: MetaBot 名称
   - `IDBOTS_TWIN_PATH`: 派生路径（默认 `m/44'/10001'/0'/0/0`）
2. **传统模式**：回退到 `account.json` 文件（仅用于独立 CLI 使用）

### 3. 资源准备
* **文件位置**: 默认目录 `res/file/`。
* **余额要求**:
    * 小文件 (<5MB): 约 1,000 - 5,000 sats。
    * 大文件: 脚本会自动估算费率 (1 sat/byte)。若余额不足，脚本会返回非零状态码并提示充值地址。

## 脚本索引 (Script Index)

MetaBot 在执行复杂任务时可直接调用底层 TS/Python 脚本：

| 脚本 | 功能 | 关键说明 |
| :--- | :--- | :--- |
| **`upload_with_balance_check.sh`** | **入口** | **推荐**。自动编排余额检查 -> 方式选择 -> 上传 -> 监控。 |
| `metafs_direct_upload.ts` | 核心 | 处理 <5MB 文件。本地构建 Tx -> 签名 -> DirectUpload API。 |
| `metafs_chunked_upload.ts` | 核心 | 处理 >5MB 文件。OSS 分片 -> Merge Tx 签名 -> 提交 Task。 |
| `metafs_check_balance.ts` | 工具 | 检查 MVC 余额，支持 `--file-size-mb` 估算 Gas。 |
| `monitor_task.py` | 监控 | 轮询分块上传任务状态。Stderr 输出进度，Stdout 输出最终 JSON。 |
| `query_indexer.py` | 查询 | 封装 Indexer API。 |
| `read_file_base64.py` | 辅助 | 读取文件并输出 Base64/MIME 信息。 |

## API 端点 (Reference)

* **Upload Base**: `https://file.metaid.io/metafile-uploader`
* **Indexer Base**: `https://file.metaid.io/metafile-indexer`

### 输出解析 (AI 注意)
* **上传成功**: 脚本标准输出 (stdout) 会包含 JSON 块。
    * `txId` / `indexTxId`: 链上哈希。
    * `pinId`: 格式为 `{txId}i0`，是文件在 MetaWeb 上的唯一标识。
    * `viewUrls`: 包含 `content` (直接下载) 和 `pin` (浏览器查看) 链接。
* **失败处理**:
    * 若报错 `File too large` (且未走分块): 强制切换到分块上传逻辑。
    * 若报错 `Insufficient balance`: 提示用户向当前 MetaBot 地址充值。
    * 若报错 `account file not found` 或 `no account matched keyword`: 检查是否在 IDBots Cowork 环境中运行，或确保 `account.json` 存在（传统模式）。

## 常见错误排查

1.  **JSON Body Error**: 若 API 返回 `ChunkPreTxHex required` 或格式错误，通常是因为未使用 TS 脚本而尝试直接 Curl。**解决**: 强制使用 `upload_with_balance_check.sh`。
2.  **jq parse error**: 监控脚本输出非 JSON 的进度日志。**解决**: 忽略 Stderr，仅解析 Stdout 的最后一行 JSON。
3.  **Permission denied**: 运行前执行 `chmod +x scripts/*.sh scripts/*.py`。
4.  **钱包信息缺失**: 若报错 `account file not found` 或 `no account matched keyword`:
    * **在 IDBots Cowork 中**: 确保已启用 metabot-basic 技能，当前会话的 MetaBot 钱包会自动注入
    * **独立 CLI 使用**: 确保 `account.json` 存在且包含对应账户
5.  **meta-contract 多实例警告**: 若出现 `More than one instance of mvc found` 警告，可忽略不影响功能，由依赖管理优化解决。