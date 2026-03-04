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
  "discussion_background": "讨论背景：为什么参与这个群聊？",
  "participation_goal": "参与目标：要在这个群聊中达成什么目的？",
  "supervisor_metaid": "上级 Boss 的 GlobalMetaID (若无则留空)"
}
```

**字段说明 (供 LLM 解析自然语言时参考):**
- `target_metabot_name`: 指令中要求派去执行任务的 MetaBot 名字 (必填)，如果没具体名字，就是当前执行任务的 MetaBot 自己的名字
- `group_id`: 要参与的群聊 ID，十六进制字符串 (必填)
- `reply_on_mention`: 是否在被点名/提及(@)时自动回复，默认为 true
- `random_reply_probability`: 非点名时的随机插话概率，0.0 到 1.0，如 10% 填 0.1，默认 0.1
- `cooldown_seconds`: 连续发言的冷却时间(秒)，默认 15
- `context_message_count`: 每次获取用于分析的历史消息条数，默认 30
- `discussion_background`: 讨论背景：为什么参与这个群聊？
- `participation_goal`: 参与目标：要在这个群聊中达成什么目的？
- `supervisor_metaid`: 上级 Boss 的 GlobalMetaID，若无则留空字符串

**执行方式:** 当 LLM 返回上述 JSON 后，调用 `scripts/index.ts`（或通过 IPC 提交给主进程）完成任务写入。若 `target_metabot_name` 在本地 `metabots` 表中找不到，返回错误："未找到指定的 MetaBot"。若该 MetaBot 在该群已有 `is_active = 1` 的任务，则执行 UPDATE 覆盖，避免重复派发。
