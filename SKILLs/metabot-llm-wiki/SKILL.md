---
name: metabot-llm-wiki
description: 构建与维护本地多项目 LLM Wiki（RAG-first）。支持 skill-local registry.json 管理多个 wiki、raw 文档导入、增量 ingest/index、带引用 query、静态 wiki 站点构建，以及 ZIP-first 发布流程（bundle_zip -> publish_zip -> publish_snapshot）。
official: true
---

# MetaBot LLM Wiki (RAG-first + Wiki-second)

这个技能用于构建多个可持续维护的本地知识库，并生成可发布的静态 Wiki 快照。

默认把 wiki 项目登记在 skill-local registry：

- 默认 registry 文件：`~/.metabot-llm-wiki/registry.json`
- 可用 `METABOT_LLM_WIKI_HOME` 或 `payload.registryHome` 指定 registry home
- 每个项目包含 `kbId`、`rootDir`、`title`、`aliases`

当 action 未显式传 `kbId` 时，先从 registry 解析：

1. `payload.wiki/wikiName/project/projectName/name` 匹配 `kbId/title/aliases`
2. 没有指定项目时使用 `defaultKbId`
3. 没有默认且只有一个项目时使用唯一项目
4. 多个项目且无默认时报 `registry_ambiguous`

默认流程：

1. `registry_create` 创建或登记 wiki 项目
2. 把原始文档放入该项目的 `raw/`
3. `absorb` 执行增量 `ingest + index`
4. `query` 带引用检索问答
5. `publish_all` 生成静态 wiki、打包 ZIP，并按参数选择是否上传/上链

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

- `registry_create`
- `registry_list`
- `registry_set_default`
- `registry_resolve`
- `registry_remove`
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

## Registry 示例

创建 MetaID Wiki，并设为默认：

```json
{
  "action": "registry_create",
  "payload": {
    "title": "MetaID Wiki",
    "kbId": "metaid-cn",
    "aliases": ["metaid", "MetaID"],
    "setDefault": true
  }
}
```

列出所有 Wiki：

```json
{
  "action": "registry_list",
  "payload": {}
}
```

不传 `kbId` 查询默认 Wiki：

```json
{
  "action": "query",
  "payload": {
    "question": "MetaID 的核心机制是什么？"
  }
}
```

指定别名查询某个 Wiki：

```json
{
  "action": "query",
  "payload": {
    "wiki": "metaid",
    "question": "MetaID 的核心机制是什么？"
  }
}
```

## publish_all 示例

本地预演：

```json
{
  "action": "publish_all",
  "payload": {
    "wiki": "metaid",
    "uploadZip": false,
    "snapshotOnChain": false
  }
}
```

上传并上链：

```json
{
  "action": "publish_all",
  "payload": {
    "wiki": "metaid",
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
