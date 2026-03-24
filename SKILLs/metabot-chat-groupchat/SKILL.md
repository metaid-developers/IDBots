---
name: metabot-chat-groupchat
description: 派遣 MetaBot 处理链上群聊相关能力：持续群聊编排（回复/插话）、链上加群（SimpleGroupJoin）、向群聊发单条消息（SimpleGroupChat，AES 加密）。当用户要求去某群聊天、加入群聊、在群里发一条消息、参与群讨论等意图时调用；先按下方「意图分流」选择 action，避免把加群/发消息误写成编排 JSON。
official: true
---
# MetaBot 群聊任务与链上群操作 (Group Chat & On-Chain Group Actions)

本技能覆盖三类**不同**能力，对应不同链上/本地行为。错误地把「加群」或「发一条群消息」当成「群聊编排任务」只会写入本地 `group_chat_tasks`，**不会**完成上链加群或发群消息。

## 意图分流（必须先读）

| 用户意图 | 应使用的 `action` | 说明 |
| -------- | ------------------ | ---- |
| 让 MetaBot **持续**在群里活动（@ 回复、随机插话、Boss 指令等） | **`orchestrate`**（默认，可省略） | 本地编排，写入 `group_chat_tasks`；不自动执行链上加群。 |
| 仅让 MetaBot **上链加入**某个群（SimpleGroupJoin） | **`join_group`** | 调用主进程 `create-pin`，路径 `/protocols/simplegroupjoin`。 |
| 仅让 MetaBot **往群里发一条**文字（SimpleGroupChat） | **`send_group_message`** | 调用主进程 `create-pin`，路径 `/protocols/simplegroupchat`；正文经 **AES** 加密后与 `metabot-omni-caster` 一致。 |
| 既要**入群**又要**持续参与** | 先发 **`join_group`**，成功后再发 **`orchestrate`** | 两步独立；仅 orchestrate 不会替 MetaBot 上链入群。 |

**与 `metabot-omni-caster` 的关系**：`join_group` / `send_group_message` 与 Omni-Caster 使用**同一套**主进程接口（`POST /api/metaid/create-pin`）及群消息加密规则；本技能脚本在 `send_group_message` 内完成加密，避免 Agent 手写密文。若系统最终走 Omni-Caster 走本技能，只要参数正确，上链结果一致。

## 🧠 执行逻辑 (Agent Workflow)

当用户的意图涉及**派 MetaBot 去群聊**、**加入群聊**、**在群里发消息**、**配置群聊行为**等：

1. **按上表选择 `action`**，不要默认用编排 JSON 处理加群或单条发信。
2. **提取参数**：
   - **哪个 MetaBot** → `target_metabot_name`（未指定则用当前执行任务的 MetaBot）
   - **哪个群** → `group_id`（十六进制，须由用户提供或上下文给出，**勿捏造**）
   - 持续编排时：行为偏好、背景等（见 Payload Schema）
   - 仅发消息时：`message_plaintext`（明文；脚本负责 AES）
   - 私密群入群：若协议需要传递密钥，填 `k`（见 `metabot-omni-caster/references/03-group-management.md`）
3. **构造 JSON**（含 `action` 与必填字段）。
4. **执行命令**：调用 `scripts/index.js` 提交。

## 💻 命令语法 (Command)

```bash
node "$SKILLS_ROOT/metabot-chat-groupchat/scripts/index.js" \
  --payload '<JSON 字符串>'
```

也支持 stdin：

```bash
echo '<JSON 字符串>' | node "$SKILLS_ROOT/metabot-chat-groupchat/scripts/index.js"
```

## 📋 Payload Schema

### 公共字段

| 参数 | 说明 | 必填 |
| ---- | ---- | ---- |
| `target_metabot_name` | 目标 MetaBot 名称（大小写不敏感） | 是 |
| `group_id` | 群聊 ID（十六进制） | 是 |
| `action` | `orchestrate`（默认） \| `join_group` \| `send_group_message` | 否 |
| `network` | `mvc`（默认） \| `doge` \| `btc` | 否 |

### `action`: `orchestrate`（默认）

与历史行为一致，写入/更新本地群聊编排任务：

```json
{
  "target_metabot_name": "小助手",
  "group_id": "a1b2c3d4e5",
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

| 参数 | 说明 | 必填 | 默认值 |
| ---- | ---- | ---- | ------ |
| `reply_on_mention` | 被 @ 时是否回复 | 否 | `true` |
| `random_reply_probability` | 随机插话概率 0~1 | 否 | `0.1` |
| `cooldown_seconds` | 冷却（秒） | 否 | `15` |
| `context_message_count` | 上下文条数 | 否 | `30` |
| `discussion_background` | 讨论背景 | 否 | `""` |
| `participation_goal` | 参与目标 | 否 | `""` |
| `supervisor_globalmetaid` | Boss 的 GlobalMetaID | 否 | `""` |
| `original_prompt` | 原始指令（追溯用） | 否 | `""` |

### `action`: `join_group`

上链加入群组（`/protocols/simplegroupjoin`，`state: 1`）：

```json
{
  "action": "join_group",
  "target_metabot_name": "小助手",
  "group_id": "a1b2c3d4e5",
  "referrer": "",
  "k": ""
}
```

| 参数 | 说明 | 必填 |
| ---- | ---- | ---- |
| `referrer` | 邀请人 MetaID（公开群常可省略或空） | 否 |
| `k` | 私密群可传递的加密密钥字段（按协议填写） | 否 |

### `action`: `send_group_message`

向群聊发**一条**文本消息（`/protocols/simplegroupchat`）；`message_plaintext` 为明文，由脚本按群 ID 派生密钥做 AES 加密（与 `metabot-omni-caster/scripts/omni-caster.js` 行为一致）：

```json
{
  "action": "send_group_message",
  "target_metabot_name": "小助手",
  "group_id": "a1b2c3d4e5",
  "message_plaintext": "大家好，这是一条测试消息。",
  "nick_name": "",
  "reply_pin": "",
  "channel_id": "",
  "mention": []
}
```

| 参数 | 说明 | 必填 |
| ---- | ---- | ---- |
| `message_plaintext` | 明文内容 | 是 |
| `nick_name` | 群内昵称；省略则用该 MetaBot 本地显示名 | 否 |
| `reply_pin` | 回复的消息 PINID | 否 |
| `channel_id` | 频道 ID | 否 |
| `mention` | @ 的 MetaID 数组 | 否 |

成功时脚本会向 stdout 打印一行 JSON：`{"txid":"...","pinId":"..."}`（与 Omni-Caster 类似）。

## ✅ 示例

**持续编排（默认）** — 用户：「派小助手去群 `a1b2c3d4e5` 聊天，10% 插话」

```bash
node "$SKILLS_ROOT/metabot-chat-groupchat/scripts/index.js" \
  --payload '{"target_metabot_name":"小助手","group_id":"a1b2c3d4e5","random_reply_probability":0.1,"original_prompt":"..."}'
```

**仅上链加群** — 用户：「让小助手加入群 `ff00aa11bb`」

```bash
node "$SKILLS_ROOT/metabot-chat-groupchat/scripts/index.js" \
  --payload '{"action":"join_group","target_metabot_name":"小助手","group_id":"ff00aa11bb"}'
```

**仅发一条群消息** — 用户：「用小助手在群 `ff00aa11bb` 发一句大家好」

```bash
node "$SKILLS_ROOT/metabot-chat-groupchat/scripts/index.js" \
  --payload '{"action":"send_group_message","target_metabot_name":"小助手","group_id":"ff00aa11bb","message_plaintext":"大家好"}'
```

## ⚠️ AI 行为约束 (Strict Constraints)

1. **JSON**：`--payload` 用单引号包裹整段 JSON，内部字符串用双引号。
2. **不要捏造 `group_id`**；缺失则询问用户。
3. **先分流再选字段**：加群 / 单条发信 **不要**只用编排 payload；应设 `join_group` 或 `send_group_message`。
4. **编排去重**：同一 MetaBot 同群已有活跃任务时，编排接口会 UPDATE 配置（与原先一致）。
5. **脚本路径**：使用 `$SKILLS_ROOT/metabot-chat-groupchat/scripts/index.js`。
6. **主进程 RPC**：需本机 IDBots 运行且 MetaID RPC 可用（默认 `http://127.0.0.1:31200`，可用环境变量 `IDBOTS_RPC_URL` 覆盖）。
7. **返回本地 MetaApp 链接**：当发送成功后，如本机已安装聊天相关的 MetaApp，调用 `resolve_metaapp_url` 获取本地应用的URL，并在回复中输出最匹配的聊天相关MetaApp的可点击地址，例如 `[在本地 Chat MetaApp 查看](http://127.0.0.1:PORT/...)`。除非用户明确要求“打开 / 启动 / 进入” MetaApp，否则不要调用 `open_metaapp` 自动打开。
