---
name: metabot-post-metaapp
description: 通过问答引导用户把本地 MetaApp 运行时目录/ZIP 与源码目录/ZIP 按 /protocols/metaapp 协议发布到链上。当用户说“发布metaapp”“上传metaapp”“我有一个app要分享”“把应用发到链上”等意图时调用此技能。
official: true
---

# MetaBot Post MetaApp

将用户已开发好的 MetaApp 运行时包、源码包、图标和封面先上传为 `metafile://<pinId>`，再按 `/protocols/metaapp` 组装协议 JSON，让用户确认后发布到链上。

## 何时调用

当用户表达以下意图时调用：

- “我要发布 metaapp”“我要上传 metapp/metaapp”
- “我有一个 app 要分享”“把这个应用发到链上”
- 能推断出用户想把本地应用作为链上 MetaApp 发布

## 对话发布流程

### 1. 收集运行时 content

先询问用户已开发好的 MetaApp 运行时目录或 ZIP 文件路径。

- 如果用户给出目录：后续由脚本压缩成 ZIP，再上传，`contentType` 使用 `application/zip`。
- 如果用户给出 ZIP：直接上传，`contentType` 使用 `application/zip`。
- 如果用户暂时没有可运行的运行时：允许 `content` 为空，但要继续询问源码 `code`。`content` 和 `code` 不能同时为空。

### 2. 收集源码 code

询问用户源码目录或 ZIP 文件路径。

- 如果用户给出目录：后续由脚本压缩成 ZIP，再上传，`codeType` 使用 `application/zip`。
- 如果用户给出 ZIP：直接上传，`codeType` 使用 `application/zip`。
- 如果用户暂时不想公开源码：允许 `code` 为空，但 `content` 必须非空。

### 3. 收集 MetaApp 元数据

一次性询问并尽量给出默认值：

| 字段 | 必填 | 默认/说明 |
|------|------|-----------|
| title | 是 | 应用展示标题 |
| appName | 是 | 应用名称/标识 |
| icon | 建议 | 本地图片路径或已上传的 `metafile://`，本地图片会先上传 |
| coverImg | 建议 | 本地图片路径或已上传的 `metafile://`，本地图片会先上传 |
| intro | 建议 | 应用介绍 |
| version | 是 | 建议 `v1.0.0` 或用户已有版本 |
| prompt | 否 | AI 生成提示词，没有则空字符串 |
| introImgs | 否 | 本地图片路径或 `metafile://` 数组，没有则 `[]` |
| runtime | 否 | 默认 `browser` |
| indexFile | 否 | 默认 `index.html` |
| tags | 否 | 默认 `[]` |
| metadata | 否 | 默认空字符串 |
| disabled | 否 | 默认 `false` |

`contentHash` 不询问用户手填：当 `content` 来自本地目录或 ZIP 时，脚本自动计算最终 content ZIP 文件的 SHA256；当 `content` 是已有 `metafile://` 时，可沿用用户提供的 `contentHash`，否则为空。

### 4. 准备并让用户确认

把用户信息写入 request JSON 后先运行准备命令。准备阶段会上传运行时 ZIP、源码 ZIP、icon、coverImg、introImgs，并生成最终协议 payload，但不会发布 `/protocols/metaapp`。

```bash
node "$SKILLS_ROOT/metabot-post-metaapp/scripts/index.js" \
  --prepare-request /tmp/metabot-post-metaapp-request.json \
  --output /tmp/metabot-post-metaapp-prepared.json
```

Request 文件格式：

```json
{
  "title": "简单音乐播放器",
  "appName": "id-music-player",
  "intro": "一个简单链上音乐播放器",
  "version": "v1.0.0",
  "runtime": "browser/android/windows/ios/macOS/linux",
  "content": "/path/to/runtime-dir-or.zip",
  "code": "/path/to/source-dir-or.zip",
  "icon": "/path/to/icon.png",
  "coverImg": "/path/to/cover.png",
  "introImgs": [],
  "tags": ["music player"]
}
```

准备完成后，必须把 `/tmp/metabot-post-metaapp-prepared.json` 中的 `payload` 完整展示给用户确认。用户确认前不要发布 MetaApp 协议本体；准备阶段已经上传的 ZIP 或图片无需回滚。

### 5. 确认后发布

用户确认 payload 后再运行：

```bash
node "$SKILLS_ROOT/metabot-post-metaapp/scripts/index.js" \
  --publish-prepared /tmp/metabot-post-metaapp-prepared.json
```

脚本会把确认后的 JSON 以 `contentType: application/json` 发布到 `/protocols/metaapp`。

## Payload 形状

链上协议路径：`/protocols/metaapp`。协议字段顺序按 SOT 和现有链上样例保持：

```json
{
  "title": "应用标题",
  "appName": "应用名称",
  "prompt": "",
  "icon": "metafile://pinid",
  "coverImg": "metafile://pinid",
  "introImgs": [],
  "intro": "应用介绍文本",
  "runtime": "browser",
  "version": "v1.0.0",
  "contentType": "application/zip",
  "content": "metafile://runtime-zip-pinid",
  "indexFile": "index.html",
  "code": "metafile://source-zip-pinid",
  "contentHash": "sha256_hex_of_content_zip",
  "metadata": "",
  "tags": [],
  "disabled": false,
  "codeType": "application/zip"
}
```

## AI 行为约束

1. 先问运行时 `content`，再问源码 `code`；二者允许其一为空，但不能同时为空。
2. 用户给目录时默认压缩为 ZIP；本技能当前默认运行时和源码都按 `application/zip` 上链。
3. 本地图片、ZIP 都要先上传并替换成 `metafile://<pinId>`。
4. 准备阶段可先上传文件；真正发布 `/protocols/metaapp` 前必须展示完整 JSON 并得到用户确认。
5. 始终使用 `$SKILLS_ROOT/metabot-post-metaapp/scripts/index.js`，不要绕开脚本另写临时发布逻辑。
6. 底层 RPC 通过 `IDBOTS_METABOT_ID` 获取发布身份，无需向用户询问 MetaBot 身份。
7. 协议细节优先参考链上 SOT；本技能参考文档见 `references/metaapp-protocol.md`。
