# MetaID Protocols: Group Management
**说明**：群组的创建、白名单、黑名单、管理员设置等管理操作。

## 1. SimpleGroupCreate (创建/修改群组协议)
- **Intro**: 用于在链上创建或修改群组基础信息。
- **Path**: `/protocols/simplegroupcreate`
- **Version**: `1.0.0`
- **Content-Type**: `application/json`
- **Payload Schema**:
```json5
{
  /** 创建时为空；修改时填群ID */
  "groupId": "{Group_ID}",
  "communityId": "{Community_ID}",
  "groupName": "MetaID开发者交流群",
  "groupNote": "群公告内容...",
  "groupIcon": "metafile://{pinid}",
  /** 消息类型: 0-明文, 1-加密(AES) */
  "groupType": "0",
  "status": "1",
  /** 进群方式: 0-公开, 100-私密 */
  "type": "0",
  "tickId": "{tickId}", // FT 专属群
  "collectionId": "{collectionId}", // NFT 专属群
  /** 发言权限: 0-所有人, 1-仅管理员 */
  "chatSettingType": 0,
  /** 0-正常, 1-已解散 */
  "deleteStatus": 0,
  "path": "10/1",
  "timestamp": 1234567890000
}

```

## 2. SimpleGroupJoin (加群/退群协议)

* **Intro**: 用于记录用户加入或退出某个群组。
* **Path**: `/protocols/simplegroupjoin`
* **Version**: `1.0.1`
* **Content-Type**: `application/json`
* **Payload Schema**:

```json5
{
  "groupId": "{Group_ID}",
  /** 1-加入, -1-退出 */
  "state": 1,
  /** 邀请人 MetaID */
  "referrer": "{MetaID}",
  /** 私密群用于记录可传递的加密密钥 */
  "k": "{Cipher key}"
}

```

## 3. 群组成员管控协议族 (黑/白名单、管理员、踢人)

这些协议结构相似，均用于管控群成员权限。格式均为 `application/json`，版本 `1.0.0`。

* **SimpleGroupJoinWhitelist** (`/protocols/simplegroupjoinwhitelist`) - 允许入群名单(私密群):
`{"groupId": "{ID}", "users": ["MetaID-1"]}`
* **SimpleGroupJoinBlock** (`/protocols/simplegroupjoinblock`) - 拒绝入群名单:
`{"groupId": "{ID}", "users": ["MetaID-1"]}`
* **SimpleGroupAdmin** (`/protocols/simplegroupadmin`) - 设置群管理员:
`{"groupId": "{ID}", "admins": ["MetaID-1"]}`
* **SimpleGroupBlock** (`/protocols/simplegroupblock`) - 禁言名单:
`{"groupId": "{ID}", "users": ["MetaID-1"]}`
* **SimpleGroupRemoveUser** (`/protocols/simplegroupremoveuser`) - 踢出某人:
`{"removeMetaid": "{MetaID}", "groupId": "{ID}", "reason": "违规", "timestamp": "0"}`
* **SimpleGroupChannel** (`/protocols/simplegroupchannel`) - 创建群频道:
`{"groupId": "{ID}", "channelId": "{ID}", "channelName": "新闻频道", "channelIcon": "metafile://pinid", "channelNote": "公告", "channelType": 1}`