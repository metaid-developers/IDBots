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