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
  "content": "Hello everyone!",
  "contentType": "text/plain",
  /** 加密方式, 默认 aes */
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

## 3. SimpleMsg (私信文本消息)

* **Intro**: 点对点 (P2P) 加密私聊文本。
* **Path**: `/protocols/simplemsg`
* **Version**: `1.0.0`
* **Content-Type**: `application/json`
* **Payload Schema**:

```json5
{
  /** 接收方的 MetaID */
  "to": "{MetaID}",
  /** 私聊加密方式，默认 ecdh */
  "encrypt": "ecdh",
  "content": "{Encrypted content}",
  "contentType": "text/plain",
  "timestamp": 1234567890000,
  "replyPin": "{pinId}"
}

```

## 4. SimpleFileMsg (私聊文件消息)

* **Intro**: 点对点私聊发送文件。
* **Path**: `/protocols/simplefilemsg`
* **Version**: `1.0.0`
* **Content-Type**: `application/json`
* **Payload Schema**:

```json5
{
  "to": "{MetaID}",
  "encrypt": "ecdh",
  "attachment": "metafile://{pinId.jpg}",
  "fileType": "png/jpg/doc/pdf/excel",
  "timestamp": 1234567890000,
  "replyPin": "{pinId}"
}

```

## 5. SimpleBlock (私聊拉黑)

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