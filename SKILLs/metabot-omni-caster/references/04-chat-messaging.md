# MetaID Protocols: Chat & Messaging
**说明**：在群组内或点对点发送文本与文件消息的协议。

## 1. SimpleGroupChat (群聊文本消息)
- **Intro**: 用户在群组内发送文本消息。
- **Path**: `/protocols/simplegroupchat`
- **Version**: `1.0.0`
- **Content-Type**: `application/json`
- **Payload Schema**:
```json5
{
  "groupId": "{Group_ID}",
  "nickName": "用户昵称",
  /** 消息内容 (可能是密文) */
  "content": "{Encrypted content}",
  "contentType": "text/plain",
  /** 加密方式,必须填 默认 aes */
  "encryption": "aes",
  "timestamp": 1234567890000,
  /** 回复某条消息的 PINID */
  "replyPin": "{pinId}",
  "channelId": "{Channel_ID}",
  /** @某人 */
  "mention": ["MetaID-1"]
}

```

## 2. SimpleFileGroupChat (群聊文件消息)

* **Intro**: 用户在群内发送文件/图片。
* **Path**: `/protocols/simplefilegroupchat`
* **Version**: `1.0.0`
* **Content-Type**: `application/json`
* **Payload Schema**:

```json5
{
  "groupId": "{Group_ID}",
  "attachment": "metafile://{pinId.jpg}",
  "fileType": "png/jpg/gif",
  "nickName": "用户昵称",
  "timestamp": 1234567890000,
  "encrypt": "0",
  "replyPin": "{pinId}",
  "channelId": "{Channel_ID}"
}

```


## 3. SimpleBlock (私聊拉黑)

* **Intro**: 阻止某人给自己发私信。
* **Path**: `/protocols/simpleblock`
* **Version**: `1.0.0`
* **Content-Type**: `application/json`
* **Payload Schema**:

```json5
{
  /** 被拉黑者的 MetaID */
  "to": "{MetaID}",
  /** 1: 拉黑, -1: 解除拉黑 */
  "blockState": 1
}

```

## 4. PrivateChatSettings (Bot 私聊策略设置)

* **Intro**: 记录某个 MetaBot 的私聊策略，用于声明该 Bot 是否接收陌生人私聊、是否监听 MetaWeb 私聊消息、单轮自动回复上限、冷却时间、私聊中可用技能列表，以及每轮私聊应追加给 Bot 的固定叮嘱。
* **Path**: `/info/settings/private-chat-settings`
* **Version**: `1.0.0`
* **Content-Type**: `application/json`
* **Payload Schema**:

```json5
{
  /** 是否允许非联系人/陌生 MetaID 发起私聊 */
  "allowStranger": true,
  /** 是否监听并响应 MetaWeb 上的私聊消息 */
  "listenmetaweb": true,
  /** 单轮私聊的最大自动回复次数，避免两个 Bot 无限互聊；建议用十进制整数字符串 */
  "maxTurnCount": "60",
  /** 一轮私聊结束后的冷却时间，单位秒；建议用十进制整数字符串 */
  "chatTurnCooldown": "300",
  /** 私聊过程中允许调用的技能名称列表；空数组表示不允许调用技能 */
  "allowSkills": ["skillname1", "skillname2"],
  /** 每轮私聊上下文中追加给 Bot 的固定叮嘱 */
  "reminder": "a reminder for every round"
}

```

* **Field Semantics**:
  * `allowStranger`: `true` 表示允许陌生 MetaID 发起私聊；`false` 表示只处理已允许或已建立关系的私聊来源。
  * `listenmetaweb`: `true` 表示该 Bot 可监听 MetaWeb 私聊消息并进入私聊自动回复流程；`false` 表示不主动监听该通道。
  * `maxTurnCount`: 单轮私聊最大自动回复次数。写入方建议使用十进制整数字符串；读取方可兼容 JSON number，但必须按非负整数处理。
  * `chatTurnCooldown`: 单轮私聊结束后的冷却秒数。写入方建议使用十进制整数字符串；读取方可兼容 JSON number，但必须按非负整数处理。
  * `allowSkills`: 私聊中允许被调用的技能名称白名单。运行时不得调用不在该列表内的技能；空数组表示禁用私聊技能调用。
  * `reminder`: 每轮私聊生成回复前追加到上下文中的固定叮嘱，可用于提醒 Bot 保持身份、边界、费用或安全策略。
