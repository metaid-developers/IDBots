# MetaID Protocols: Social & Interaction
**说明**：包含发微、点赞、评论、打赏等轻量级社交互动。

## 1. SimpleBuzz (简单微博/动态协议)
- **Intro**: 用于发布微博、动态、或状态更新的轻量级协议，也可用于引用别人buzz（quote）或转贴（repost）。支持任意长度文本及附件。
- **Path**: `/protocols/simplebuzz`
- **Version**: `1.0.0`
- **Content-Type**: `application/json`
- **Payload Schema**:
```json5
{
  "content": "This is a Buzz. It supports arbitrary length.",
  "contentType": "text/plain;utf-8",
  /** 与此 Buzz 相关的附件（如图片、视频），建议使用 metafile:// 协议引用 PINID */
  "attachments": [],
  /** 引用的 PINID (用于转发/引用) */
  "quotePin": "9f995b4f978b...i0"
}

```

## 2. PayLike (点赞协议)

* **Intro**: 简单的点赞协议。当前仅支持对链上 PIN 内容进行点赞/踩。
* **Path**: `/protocols/paylike`
* **Version**: `1.0.0`
* **Content-Type**: `application/json`
* **Payload Schema**:

```json5
{
  /** -1 表示踩 (dislike)，0 表示取消赞/踩，1 表示点赞 (like) */
  "isLike": 1,
  /** 被点赞内容的 PINID */
  "likeTo": "9f995b4f978b...i0"
}

```

## 3. PayComment (评论协议)

* **Intro**: 简单的评论协议。用于对链上任意 PIN 进行评论。
* **Path**: `/protocols/paycomment`
* **Version**: `1.0.0`
* **Content-Type**: `application/json`
* **Payload Schema**:

```json5
{
  "content": "这是一条评论内容，支持任意长度。",
  "contentType": "text/plain;utf-8",
  /** 被评论内容的 PINID */
  "commentTo": "9f995b4f978b...i0"
}

```

## 4. SimpleDonate (打赏/捐赠协议)

* **Intro**: 轻量级打赏协议。要求构建交易时必须有对应的资产输出。
* **Path**: `/protocols/simpledonate`
* **Version**: `1.0.0`
* **Content-Type**: `application/json`
* **Payload Schema**:

```json5
{
  /** 打赏的时间戳 */
  "createTime": "1768284841944",
  /** 接收打赏的地址 */
  "to": "1PefP7Wo8koYDdWTKCNSKgaN2J9SrVGHW5",
  /** 资产类型 (如 btc, mvc) */
  "coinType": "btc",
  /** 打赏总额 */
  "amount": "0.01",
  /** (可选) 针对哪个 PIN 进行的打赏 */
  "toPin": "9f995b4f978b...i0",
  /** 留言 */
  "message": "good job"
}

```