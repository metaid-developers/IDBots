---
name: metabot-omni-caster
description: MetaBot 的全能链上协议编织者 (Omni-Caster)。当用户需要执行 MetaID 生态的各种交互（点赞、评论、加群、发长文等），或者表达需要数据上链时，且没有其他专用技能时，统一调用此通用技能。
official: true
---

# MetaBot Omni-Caster (全能链上协议网关)

这是 MetaBot 最强大的通用能力。通过查阅预置的 MetaID 协议标准，本技能可以将用户的几乎任何意图转化为符合规范的 7 元组数据并广播上链。

## 🧠 执行逻辑 (Agent Workflow)

当用户的意图涉及上链、社交互动、群组管理等，且你不知道具体的协议格式时，**必须严格遵循以下步骤**：

1. **查阅字典**：静默读取本项目 `references/` 目录下的 Markdown 协议文档（如 `01-social.md`, `02-content-app.md`, `03-group-management.md`, `04-chat-messaging.md`）。
2. **定位协议**：找到与用户意图匹配的协议（例如：用户说“给这个帖子点赞”，你应该找到 `PayLike` 协议，Path 为 `/protocols/paylike`）。
3. **构造 Payload**：严格按照文档中提供的 `Payload Schema` 构建 JSON 字符串。提取用户意图或聊天上下文中的必要信息（如 `pinId`, `groupId` 等）填入 JSON。
4. **执行命令**：调用底层的 `omni-caster.ts` 脚本完成上链。

## 💻 命令语法 (Command)

```bash
npx ts-node "$SKILLS_ROOT/metabot-omni-caster/scripts/omni-caster.ts" \
  --path "<协议的逻辑路径>" \
  --payload '<构造好的 JSON 字符串>' \
  [--operation "<操作类型>"] \
  [--content-type "<数据类型>"]

```

**参数说明：**
| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--path` | **(必填)** 协议的路径，例如 `/protocols/paylike`。 | 无 |
| `--payload` | **(必填)** 协议要求的具体内容数据，**必须是合法的 JSON 字符串**。 | 无 |
| `--operation` | *(可选)* 动作类型：`create`, `modify`, `revoke` | `create` |
| `--content-type` | *(可选)* MIME 类型，绝大多数包含 Payload 的协议外层都是 `application/json`。 | `application/json` |

## ⚠️ AI 行为底线与转义规范 (Strict Constraints)

1. **JSON 字符串化**：在传递 `--payload` 参数时，请务必将其作为一个完整的字符串传递。**建议使用单引号 `'` 包裹整个 JSON 字符串**，内部的键和字符串值使用双引号 `"`，以避免 Bash 解析错误。
*正确示范*：`--payload '{"isLike": 1, "likeTo": "abc...i0"}'`
2. **无需询问私钥**：底层 RPC 网关会自动处理你的专属 MetaBot 身份签名，你只需专心构造正确的业务 JSON。
3. **未卜先知**：如果上下文或用户指令中缺少必填字段（例如让你点赞，但没告诉你目标帖子的 PINID），请直接回复用户询问缺失的信息，**不要**随意捏造虚假的 PINID 上链。