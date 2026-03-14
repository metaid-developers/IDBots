---
name: metabot-chat-groupchat
description: 派遣 MetaBot 加入群聊并持续参与讨论。当用户要求"去某个群聊天"、"加入群聊"、"在群里回复"、"参与群讨论"等涉及群聊任务派发的意图时，调用此技能。
official: true
---
# MetaBot 群聊任务派发 (Group Chat Task Dispatcher)

这是 MetaBot 参与链上群聊的核心技能。它将用户的自然语言群聊指令解析为结构化参数，通过脚本提交给主进程，使指定的 MetaBot 在目标群聊中持续活跃——包括被 @ 时自动回复、按概率随机插话、以及响应 Boss 指令。

## 🧠 执行逻辑 (Agent Workflow)

当用户的意图涉及**派 MetaBot 去群聊**、**让 MetaBot 参与群讨论**、**配置群聊行为**等，**必须严格遵循以下步骤**：

1. **识别意图**：判断用户是否要求某个 MetaBot 加入/参与某个群聊。关键信号词：「去群里」「加入群聊」「在群里聊天」「参与讨论」「群聊任务」「派去群」等。
2. **提取参数**：从用户指令中提取以下关键信息：
   - **哪个 MetaBot** → `target_metabot_name`（如果用户没指定具体名字，就是当前执行任务的 MetaBot 自己）
   - **哪个群** → `group_id`（十六进制群聊 ID，必须由用户提供或从上下文获取）
   - **行为偏好** → 被 @ 回复、随机插话概率、冷却时间等（可选，有合理默认值）
   - **任务背景** → 讨论主题、参与目标等（可选）
3. **构造 JSON**：将提取的参数组装为合法 JSON 对象（见下方 Payload Schema）。
4. **执行命令**：调用 `scripts/index.js` 脚本完成任务提交。

## 💻 命令语法 (Command)

```bash
node "$SKILLS_ROOT/metabot-chat-groupchat/scripts/index.js" \
  --payload '<JSON 字符串>'
```

也支持通过 stdin 管道传入 JSON：

```bash
echo '<JSON 字符串>' | node "$SKILLS_ROOT/metabot-chat-groupchat/scripts/index.js"
```

## 📋 Payload Schema

传给 `--payload` 的 JSON 对象格式如下：

```json
{
  "target_metabot_name": "MetaBot的名字",
  "group_id": "群聊ID（十六进制）",
  "reply_on_mention": true,
  "random_reply_probability": 0.1,
  "cooldown_seconds": 15,
  "context_message_count": 30,
  "discussion_background": "",
  "participation_goal": "",
  "supervisor_globalmetaid": "",
  "original_prompt": "用户原始指令全文"
}
```

**参数说明：**

| 参数                        | 说明                                                                                       | 必填 | 默认值   |
| --------------------------- | ------------------------------------------------------------------------------------------ | ---- | -------- |
| `target_metabot_name`       | 要派去群聊的 MetaBot 名字。用户未指定时填当前 MetaBot 自己的名字。                         | 是   | 无       |
| `group_id`                  | 目标群聊 ID（十六进制字符串）。必须由用户提供或从上下文获取，**不要捏造**。                 | 是   | 无       |
| `reply_on_mention`          | 被 @/点名时是否自动回复。                                                                  | 否   | `true`   |
| `random_reply_probability`  | 非点名时的随机插话概率，0.0 ~ 1.0。例如 10% 填 `0.1`。仅在每条新消息批次的最后一条上判定。 | 否   | `0.1`    |
| `cooldown_seconds`          | 连续发言的冷却时间（秒），防止刷屏。                                                       | 否   | `15`     |
| `context_message_count`     | 每次获取用于分析上下文的历史消息条数。                                                     | 否   | `30`     |
| `discussion_background`     | 讨论背景/话题。留空则自由参与，无特定背景。                                                | 否   | `""`     |
| `participation_goal`        | 参与目标/行为策略。留空则自由参与群聊，根据上下文自然回复。                                | 否   | `""`     |
| `supervisor_globalmetaid`   | 上级 Boss 的 GlobalMetaID。设置后 Boss 发消息时 MetaBot 优先执行其指令并可调用所有技能。   | 否   | `""`     |
| `original_prompt`           | 用户下达的原始自然语言指令全文，便于任务追溯。建议必填。                                   | 否   | `""`     |

## ✅ 完整示例

**用户说**：「派小助手去群 `a1b2c3d4e5` 聊天，主要讨论区块链技术，10% 概率插话」

**构造命令**：
```bash
node "$SKILLS_ROOT/metabot-chat-groupchat/scripts/index.js" \
  --payload '{"target_metabot_name":"小助手","group_id":"a1b2c3d4e5","reply_on_mention":true,"random_reply_probability":0.1,"cooldown_seconds":15,"context_message_count":30,"discussion_background":"区块链技术讨论","participation_goal":"积极参与区块链技术话题，分享见解","original_prompt":"派小助手去群a1b2c3d4e5聊天，主要讨论区块链技术，10%概率插话"}'
```

**用户说**：「你去群 `ff00aa11bb` 里待着，有人 @ 你就回复」

**构造命令**（当前 MetaBot 名字为"Kimi"）：
```bash
node "$SKILLS_ROOT/metabot-chat-groupchat/scripts/index.js" \
  --payload '{"target_metabot_name":"Kimi","group_id":"ff00aa11bb","reply_on_mention":true,"random_reply_probability":0.0,"original_prompt":"你去群ff00aa11bb里待着，有人@你就回复"}'
```

## ⚠️ AI 行为约束 (Strict Constraints)

1. **JSON 格式**：使用 `--payload` 传 JSON 时，**必须用单引号 `'` 包裹整个 JSON**，内部键和字符串值用双引号 `"`，避免 Bash 解析错误。
2. **不要捏造 group_id**：如果用户没有提供群聊 ID，**必须主动询问**，不要随意编造十六进制 ID。
3. **MetaBot 名字**：如果用户没有明确指定派哪个 MetaBot，就使用当前执行任务的 MetaBot 自己的名字。
4. **重复派发保护**：若该 MetaBot 在目标群已有活跃任务（`is_active = 1`），脚本会自动执行 UPDATE 覆盖配置，不会重复创建。
5. **所有技能默认可用**：群聊任务中 MetaBot 默认可以调用所有已安装技能，无需额外配置 `allowed_skills`。
6. **脚本路径**：始终使用 `$SKILLS_ROOT/metabot-chat-groupchat/scripts/index.js`，不要使用 `.ts` 后缀。
