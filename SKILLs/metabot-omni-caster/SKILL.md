---
name: metabot-omni-caster
description: MetaBot 的全能链上协议编织者 (Omni-Caster)。当用户需要执行 MetaID 生态的各种交互（点赞、评论、加群、发长文等），或者表达需要数据上链时，且没有其他专用技能时，统一调用此通用技能。
official: true
---
# MetaBot Omni-Caster (全能链上协议网关)

这是 MetaBot 最强大的通用能力。通过查阅预置的 MetaID 协议标准，本技能可以将用户的几乎任何意图转化为符合规范的 7 元组数据并广播上链。理论上可以完成一切和 MetaID数据上链相关的功能

## 🧠 执行逻辑 (Agent Workflow)

当用户的意图涉及上链、社交互动、群组管理等，且你不知道具体的协议格式时，**必须严格遵循以下步骤**：

1. **查阅字典**：静默读取本项目 `references/` 目录下的 Markdown 协议文档（如 `00-metaid-concepts.md`,`01-social.md`, `02-content-app.md`, `03-group-management.md`, `04-chat-messaging.md`）。
  - `references/00-metaid-concepts.md`：在这里你可以查看到 metaid 协议的基础概念，PIN 和 PINID 概念，以及如何文件上链以及 metafile://协议说明。
  - `references/01-social.md`：关于发 buzz、点赞、评论、转发、引用、打赏等可查看这个文档。
  - `references/02-content-app.md`：关于链上笔记（simplenote协议），相册分类协议，MetaApp 应用封装协议，MetaProtocols 协议封装协议，MetaBot 技能封装协议等可以看这文档。
  - `references/03-group-management.md`：群聊管理相关的，比如创建群聊、加入群聊、以及设置管理，拉入黑名单等和群聊相关的功能都可以看这文档。
  - `references/04-chat-messaging.md`：发送群聊私聊信息相关的都可以看这个文档，包括群聊信息协议，私聊信息协议等。
2. **定位协议**：找到与用户意图匹配的协议（例如：点赞对应 `PayLike` Path `/protocols/paylike`，文件上链 Path 为 `/file`）。
3. **构造 Payload**：**JSON 协议**：按文档 Payload Schema 构建 JSON 字符串；**文件上链**：使用 `--payload-file` 指定本地文件路径，脚本自动转为 base64 并设置 `encoding: base64`。
4. **执行命令**：调用底层的 `omni-caster.ts` 脚本完成上链。

## 💻 命令语法 (Command)

**JSON/文本协议：**
```bash
npx ts-node "$SKILLS_ROOT/metabot-omni-caster/scripts/omni-caster.ts" \
  --path "<协议的逻辑路径>" \
  --payload '<JSON 字符串或文本内容>' \
  [--operation "<操作类型>"] \
  [--content-type "<MIME 类型>"]
```

**文件（二进制）上链：**
```bash
npx ts-node "$SKILLS_ROOT/metabot-omni-caster/scripts/omni-caster.ts" \
  --path "/file" \
  --payload-file <本地文件路径> \
  [--content-type "<MIME 类型>"]
```

**参数说明：**

| 参数               | 说明                                                                 | 默认值                |
| ---------------- | ------------------------------------------------------------------- | -------------------- |
| `--path`         | **(必填)** 协议的路径，例如 `/protocols/paylike`；文件上链为 `/file`。             | 无                   |
| `--payload`      | 协议内容。JSON 协议为合法 JSON 字符串；二进制可传 base64 字符串（配合 `--encoding base64`）。 | 与 `--payload-file` 二选一 |
| `--payload-file` | 本地文件路径，读取后转为 base64 上链，自动设置 `encoding: base64`。                  | 与 `--payload` 二选一     |
| `--operation`    | *(可选)* 动作类型：`create`, `modify`, `revoke`。                         | `create`             |
| `--content-type` | *(可选)* MIME 类型。JSON 多为 `application/json`；文件为 `image/jpeg` 等。        | `application/json`   |
| `--encoding`     | *(可选)* 当 `--payload` 为 base64 字符串时，传 `base64`。                        | 依 content-type 自动推断   |


## ⚠️ AI 行为底线与转义规范 (Strict Constraints)

1. **JSON 字符串化**：使用 `--payload` 传 JSON 时，**建议用单引号 `'` 包裹整个 JSON**，内部键和字符串值用双引号 `"`，避免 Bash 解析错误。文件上链使用 `--payload-file` 指定本地路径即可。

*正确示范*：`--payload '{"isLike": 1, "likeTo": "abc...i0"}'`；文件上链：`--path /file --payload-file ./photo.png --content-type image/png`
2. **无需询问私钥**：底层 RPC 网关会自动处理你的专属 MetaBot 身份签名，你只需专心构造正确的业务 JSON。
3. **未卜先知**：如果上下文或用户指令中缺少必填字段（例如让你点赞，但没告诉你目标帖子的 PINID），请直接回复用户询问缺失的信息，**不要**随意捏造虚假的 PINID 上链。