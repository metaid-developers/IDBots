---
name: metabot-llm-wiki
description: 构建与维护本地 LLM Wiki（RAG-first）。支持 raw 文档导入、增量 ingest/index、带引用 query、静态 wiki 站点构建，以及 ZIP-first 发布流程（bundle_zip -> publish_zip -> publish_snapshot）。
official: true
---

# MetaBot LLM Wiki (RAG-first + Wiki-second)

这个技能用于在 IDBots 中构建一个可持续维护的本地知识库，并生成可发布的静态 Wiki 快照。

默认流程：

1. `init` 初始化知识库目录
2. 把原始文档放入 `raw/`
3. `ingest` 解析原始文档
4. `index` 构建索引
5. `query` 带引用检索问答
6. `wiki_build` 生成静态站点
7. `bundle_zip` 打包为单个 ZIP
8. `publish_zip` 上传 ZIP 到链上文件系统（metafile://）
9. `publish_snapshot` 发布快照元数据 pin（可选）
10. 或直接用 `publish_all` 一键执行 6-9

`publish_all` 默认会在检测到未完成索引时自动执行一次增量 `absorb`，确保可以从新库直接发布。

## v1.2 发布模式（双开关）

发布行为现在由两个开关控制：

- `uploadZip`：是否真实上传 ZIP（新参数）
- `snapshotOnChain`：是否把快照 pin 上链（新参数，优先级高于旧参数 `publishOnChain`）

兼容规则：

1. 如果传了 `snapshotOnChain`，就按它执行。
2. 如果没传 `snapshotOnChain`，继续兼容旧参数 `publishOnChain`。
3. 如果传了 `uploadZip`：
   - `true`：强制执行上传流程（即使传了 `zipUri`）
   - `false`：不上传，优先使用外部 `zipUri`；若未提供，则在 `publish_all` 里保留本地 ZIP（`publish_zip` 会标记 skipped）
4. 如果没传 `uploadZip`，保持旧行为：有 `zipUri` 则复用，无 `zipUri` 则自动上传。

四种常用场景（建议）：

1. 本地预演（不上传、不上链）
   - `uploadZip: false`
   - `snapshotOnChain: false`
2. 仅上传 ZIP（不上链快照）
   - `uploadZip: true`
   - `snapshotOnChain: false`
3. 上传 ZIP + 上链快照
   - `uploadZip: true`
   - `snapshotOnChain: true`
4. 复用外部 ZIP URI + 上链快照
   - `uploadZip: false`
   - `zipUri: "metafile://..."`
   - `snapshotOnChain: true`

> 注意：`snapshotOnChain=true` 时，`zipUri` 必须是可公开访问 URI（例如 `metafile://`）。本地 `file://` URI 不允许上链。

## 命令

```bash
node "$SKILLS_ROOT/metabot-llm-wiki/scripts/index.js" --payload '<JSON>'
```

其中 JSON 统一格式：

```json
{
  "action": "query",
  "kbId": "legal-cn",
  "requestId": "req-001",
  "payload": {}
}
```

## Action 列表

- `init`
- `ingest`
- `index`
- `query`
- `absorb`
- `wiki_build`
- `bundle_zip`
- `publish_zip`
- `publish_snapshot`
- `publish_all`

## publish_all 示例

本地预演：

```json
{
  "action": "publish_all",
  "kbId": "legal-cn",
  "payload": {
    "rootDir": "/path/to/legal-cn",
    "uploadZip": false,
    "snapshotOnChain": false
  }
}
```

上传并上链：

```json
{
  "action": "publish_all",
  "kbId": "legal-cn",
  "payload": {
    "rootDir": "/path/to/legal-cn",
    "uploadZip": true,
    "snapshotOnChain": true
  }
}
```

## 运行依赖（重要）

- `pdftotext`：用于解析 `.pdf`
- `textutil`：用于解析 `.docx`（macOS 内置）

安装 `pdftotext` 示例：

- macOS: `brew install poppler`
- Ubuntu/Debian: `sudo apt install poppler-utils`
- Fedora/RHEL: `sudo dnf install poppler-utils`
- Arch: `sudo pacman -S poppler`
- Windows: `choco install poppler` 或 `scoop install poppler`（并确保 `pdftotext` 在 PATH 中）

> 技能在 `init` 时会返回依赖可用性检测结果；如果缺失，会在 `warnings` 中给出安装提示。

## 关键规则

1. `query` 必须优先返回证据；无证据时返回 `insufficient=true`，不要猜测。
2. 生成的 wiki 是静态文件集合，发布时优先走 ZIP-first，不逐文件上链。
3. 原始文档默认留在本地 `raw/`，公开发布时仅发布静态快照 ZIP 和快照元数据。
