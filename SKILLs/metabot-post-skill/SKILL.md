---
name: metabot-post-skill
description: 将本地技能（SKILL.md + 文件）以 metabot-skill 协议打包发布到链上的技能。当用户说"发布技能"、"上传技能"、"分享技能到社区"、"把这个技能发到链上"时调用此技能。
official: true
---

# MetaBot Post Skill

将本地技能目录打包为 ZIP 上传至 MetaWeb `/file`，再以 **metabot-skill** 协议（`/protocols/metabot-skill`）发布到链上，供社区技能市场展示与其他用户下载安装。

## 何时调用

当用户表达以下意图时调用：

- "发布一个技能""把这个技能上传到链上""分享技能到社区"
- "让大家也能下载我这个技能"
- 能推断出用户想将某个本地技能目录或 ZIP 发布为社区技能

## 对话发布流程

按以下步骤引导用户完成发布：

### 1. 收集技能来源

询问用户：「请提供你的技能目录路径，或一个已打包的 ZIP 文件。」

收到路径后检测：
- **如果是目录**：检查根目录下是否有 `SKILL.md`。若没有，提示用户「该目录下没有 SKILL.md，可能不是合法的技能包，是否继续？」。
  然后询问用户是否需要压缩：「是否帮你把该目录压缩为 ZIP？」若用户确认，执行：
  ```bash
  cd "$(dirname "<skill-dir>")" && zip -r "/tmp/metabot-skill-<name>.zip" "$(basename "<skill-dir>")" -x "*.DS_Store" "__MACOSX/*"
  ```
  建议输出路径 `/tmp/metabot-skill-<name>.zip`。

- **如果是 ZIP 文件**：检查文件大小。读取文件大小：
  ```bash
  stat -f%z "<zip-path>" 2>/dev/null || wc -c < "<zip-path>" | tr -d ' '
  ```
  若超过 4MB（4194304 byte），提示「技能包过大（X MB），请精简至 4MB 以内后重试。」并停止。

- **如果是其他格式或不存在的路径**：提示用户当前路径无效，请提供技能目录或 ZIP 文件路径。

### 2. 从技能文件中读取建议值

读取技能目录下的 `SKILL.md` frontmatter 或 ZIP 内的 SKILL.md（若方便），提取 `name`、`description`、`version` 作为后续建议值。如果读不到就用目录名作为 name 的建议值。

### 3. 收集元数据

一次性询问用户以下字段，**同时给出建议值**：

| 字段 | 必填 | 建议值 |
|------|------|--------|
| name | 是 | 从 SKILL.md frontmatter 的 `name` 字段，或目录名 |
| description | 否 | 从 SKILL.md frontmatter 的 `description` 字段 |
| version | 是 | 从 SKILL.md frontmatter 的 `version` 字段，或 `1.0.0` |

呈现方式示例：「根据你的技能文件，建议：name: xxx, description: xxx, version: 1.0.1。请确认或修改后告诉我。」

### 4. 组装并确认

将 metadata 组装为 `/protocols/metabot-skill` 的 JSON 展示给用户确认：

```json
{
  "name": "metabot-example",
  "description": "一个示例技能",
  "version": "1.0.0",
  "skill-file": "metafile://<zip-pinid>"
}
```

同时告知用户即将执行的操作：「我将帮你上传 ZIP 并发布到链上，确认吗？」

### 5. 执行发布

用户确认后，调用脚本。**二合一模式（推荐）：上传 + 发布一起做**

```bash
node "$SKILLS_ROOT/metabot-post-skill/scripts/index.js" \
  --request-file /tmp/metabot-post-skill-request.json
```

Request 文件格式（`/tmp/metabot-post-skill-request.json`）：

```json
{
  "name": "metabot-example",
  "description": "一个示例技能",
  "version": "1.0.0",
  "zip": "/tmp/metabot-skill-example.zip"
}
```

脚本会自动：先上传 ZIP 到 `/file` → 获得 `metafile://<pinId>` → 再发布 `/protocols/metabot-skill` pin。

**分步模式（当 ZIP 已提前上传时）：**

```bash
node "$SKILLS_ROOT/metabot-post-skill/scripts/index.js" \
  --payload '{"name":"metabot-example","description":"示例技能","version":"1.0.0","skillFileUri":"metafile://<pinid>"}'
```

## 命令语法

```bash
# 推荐：通过 request 文件，zip 字段触发自动上传
node "$SKILLS_ROOT/metabot-post-skill/scripts/index.js" \
  --request-file <request.json>

# 直接传 payload + zip
node "$SKILLS_ROOT/metabot-post-skill/scripts/index.js" \
  --payload '<JSON>' --zip <zip-path>

# 只发布（ZIP 已提前上传好）
node "$SKILLS_ROOT/metabot-post-skill/scripts/index.js" \
  --payload '<JSON>'
```

## Payload 字段说明

与 `/protocols/metabot-skill` 协议一致：

| 字段 | 必填 | 说明 |
|------|------|------|
| name | 是 | 技能标识 |
| description | 否 | 简短描述 |
| version | 是 | 语义版本号，如 `1.0.0` |
| skill-file | 是 | `metafile://<pinid>` URI，指向已上传的 ZIP；若通过 `--zip` 或 request 的 `zip` 字段提供本地路径，脚本会自动上传并填充 |
| zip (仅 request) | 否 | 本地 ZIP 文件路径，脚本会先上传该文件再发布 |

## Request 文件完整格式

```json
{
  "name": "metabot-example",
  "description": "一个示例技能",
  "version": "1.0.0",
  "zip": "/tmp/metabot-skill-example.zip"
}
```

ZIP 已提前上传时可不传 `zip`，改为在 payload 中包含 `skillFileUri` 或 `skill-file`：

```json
{
  "name": "metabot-example",
  "description": "一个示例技能",
  "version": "1.0.0",
  "skillFileUri": "metafile://<pinid>"
}
```

## 成功输出

成功时 stdout 输出一行 JSON：

```json
{
  "success": true,
  "pinId": "<pinId>",
  "txid": "<txid>",
  "skillFileUri": "metafile://<zip-pinid>",
  "totalCost": 1234
}
```

退出码 0 表示成功。

## AI 行为约束

1. **4MB 限制**：上传前必须检查 ZIP 大小，超过 4MB（4194304 byte）立即停止并提示用户。
2. **目录校验**：用户给的是目录时，检查根目录有没有 `SKILL.md`。没有就提醒用户可能不是合法技能包。
3. **一次性收集**：不要一个一个字段问，同时给出 name/description/version 的建议值，让用户一次确认。
4. **提前确认**：在实际调用脚本之前，将组装的 payload 展示给用户确认。用户确认后再执行。
5. **脚本路径**：始终使用 `$SKILLS_ROOT/metabot-post-skill/scripts/index.js`。
6. **身份自动处理**：底层 RPC 通过 `IDBOTS_METABOT_ID` 环境变量自动获取当前 MetaBot 身份，无需询问用户选择发布者。
7. **结果判定**：退出码 0 即成功；优先使用本技能输出，不要绕开技能另写临时脚本。
8. **JSON 转义**：传入 `--payload` 的 JSON 字符串若含双引号等特殊字符需正确转义；推荐通过 `--request-file` 传参避免转义问题。
