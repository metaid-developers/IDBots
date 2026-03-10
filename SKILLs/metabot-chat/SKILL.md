---
name: metabot-chat
description: 群聊和私聊任务编排技能。将用户下达的自然语言群聊/私聊任务指令，解析为结构化的配置参数并写入 group_chat_tasks。
official: true
---
# 技能名称: metabot-chat
# 技能描述: 这是一个让 MetaBot 参与群聊和私聊的技能。用于将用户下达的自然语言群聊/私聊任务指令，解析为结构化的配置参数。
# 输出格式要求: 必须输出合法的 JSON 对象，不包含任何 Markdown 代码块包裹。

```json
{
  "target_metabot_name": "指令中要求派去执行任务的 MetaBot 名字",
  "group_id": "要参与的群聊 ID (十六进制字符串)",
  "reply_on_mention": true,
  "random_reply_probability": 0.1,
  "cooldown_seconds": 15,
  "context_message_count": 30,
  "discussion_background": "讨论背景（可选，留空则自由参与）",
  "participation_goal": "参与目标（可选，留空则自由参与群聊）",
  "supervisor_globalmetaid": "上级 Boss 的 GlobalMetaID (若无则留空)",
  "original_prompt": "用户原始指令全文，便于后续参考"
}
```

**字段说明 (供 LLM 解析自然语言时参考):**
- `target_metabot_name`: 指令中要求派去执行任务的 MetaBot 名字 (必填)，如果没具体名字，就是当前执行任务的 MetaBot 自己的名字
- `group_id`: 要参与的群聊 ID，十六进制字符串 (必填)
- `reply_on_mention`: 是否在被点名/提及(@)时自动回复，默认为 true
- `random_reply_probability`: 非点名时的随机插话概率，0.0 到 1.0，如 10% 填 0.1，默认 0.1；仅在每条新消息批次中的最后一条上掷一次
- `cooldown_seconds`: 连续发言的冷却时间(秒)，默认 15
- `context_message_count`: 每次获取用于分析的历史消息条数，默认 30
- `discussion_background`: 讨论背景（可选）；留空或不传则默认为「自由参与，无特定背景」
- `participation_goal`: 参与目标（可选）；留空或不传则默认为「自由参与群聊，根据上下文自然回复或调用技能」
- `supervisor_globalmetaid`: 上级 Boss 的 GlobalMetaID，若无则留空字符串。Boss 发消息时 MetaBot 会优先执行其指令并可调用所有技能
- `original_prompt`: 用户下达的原始自然语言指令全文，便于任务追溯与上下文参考；建议必填为完整指令

**说明:** 群聊任务中 **所有技能默认允许调用**，无需配置 allowed_skills。Boss 下达指令时 MetaBot 会按 SKILL.md 通过 Read/Bash 执行对应技能并简要回复群聊。

**执行方式:** 当 LLM 返回上述 JSON 后，调用 `scripts/index.js`（或通过 IPC 提交给主进程）完成任务写入。若 `target_metabot_name` 在本地 `metabots` 表中找不到，返回错误："未找到指定的 MetaBot"。若该 MetaBot 在该群已有 `is_active = 1` 的任务，则执行 UPDATE 覆盖，避免重复派发。
