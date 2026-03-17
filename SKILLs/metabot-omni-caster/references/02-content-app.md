# MetaID Protocols: Content & Applications
**说明**：包含长文笔记、图片相册、应用发布等重资产协议。

## 1. SimpleNote (简单笔记/长文协议)
- **Intro**: 用于发布长文笔记、博客文章的协议。
- **Path**: `/protocols/simplenote`
- **Version**: `1.0.1`
- **Content-Type**: `application/json`
- **Payload Schema**:
```json5
{
  "title": "笔记标题",
  "subtitle": "副标题内容",
  "coverImg": "metafile://封面图PINID",
  "contentType": "text/markdown",
  "content": "笔记内容主体",
  /** content 的加密方式，默认为空即不加密 */
  "encryption": "",
  "createTime": "创建时间戳",
  "tags": ["标签1", "标签2"],
  "attachments": ["附件PINID1", "附件PINID2"]
}

```

## 2. SimplePhotoShare (简单相册/图片分享协议)

* **Intro**: 应用于相册和图片分享场景。
* **Path**: `/protocols/simplephotoshare`
* **Version**: `1.0.2`
* **Content-Type**: `application/json`
* **Payload Schema**:

```json5
{
  /** 分享描述 */
  "description": "这是一组风景照",
  /** 创建时间戳 */
  "createTime": "1768284841944",
  "tags": ["风景", "旅游"],
  /** 提及某人 (MetaID列表) */
  "mention": ["MetaID_1", "MetaID_2"],
  /** 以 metafile 格式存储的图片 PINID 列表 */
  "photos": [
    "metafile://{PINID_1}",
    "metafile://{PINID_2}"
  ]
}

```

## 3. MetaApp Wrapper (MetaApp 应用包装协议)

* **Intro**: 用于将基于 MetaID 的应用（前端代码、静态资源）包装成上链应用 (MetaApp)。
* **Path**: `/protocols/metaapp`
* **Version**: `1.0.0`
* **Content-Type**: `application/json`
* **Payload Schema**:

```json5
{
  "title": "应用标题",
  "appName": "应用名称",
  /** 若由 AI 生成，记录提示词 */
  "prompt": "You are an AI...",
  "icon": "metafile://pinid",
  "coverImg": "metafile://pinid",
  "introImgs": ["metafile://pinid1", "metafile://pinid2"],
  "intro": "应用介绍文本...",
  /** 支持的运行环境 (如 browser/android/ios) */
  "runtime": "browser/android/ios",
  "version": "1.0.0",
  "contentType": "text/html",
  /** 应用的运行时主内容 PINID */
  "content": "metafile://pinid",
  /** 入口文件 */
  "indexFile": "index.html",
  /** 源码压缩包 PINID */
  "code": "metafile://pinid",
  "contentHash": "sha256_hash_here",
  "metadata": "any data",
  "tags": ["工具", "Web3"],
  "disabled": false,
  "codeType": "application/zip"
}

```

## 4. MetaProtocol (自定义协议描述包装)

* **Intro**: 聚合与描述所有自定义协议用途的“协议说明书”。
* **Path**: `/protocols/metaprotocol`
* **Version**: `1.0.0`
* **Content-Type**: `application/json5`
* **Payload Schema**:

```json5
{
  "title": "协议标题",
  "protocolName": "协议名称",
  /** 自定义协议的实际路径 */
  "path": "/protocols/your_custom_path",
  "authors": "作者名称",
  "version": "1.0.0",
  /** 目标协议的具体字段格式说明 */
  "protocolContent": "{\n  \"field\": \"value\"\n}",
  "protocolContentType": "application/json",
  "intro": "这是关于此自定义协议的详细说明...",
  "protocolAttachments": [],
  "metadata": "Arbitrary data"
}

```

## 5. MetaBot-Skill (MetaBot 技能协议)

* **Intro**: MetaBot技能封装协议。用户上传技能.zip后，再用这个协议封装
* **Path**: `/protocols/metabot-skill`
* **Version**: `1.0.0`
* **Content-Type**: `application/json`
* **Payload Schema**:

```json5
{
  "name": "metabot-post-buzz",
  "description": "让 MetaBot 可以发 buzz 的官方核心技能。",
  "version": "1.0.1",
  /** 指向提前上传到 /file 路径下的 ZIP 压缩包的 PINID */
  "skill-file": "metafile://<zip_pinid>"
}

```
## 6. skill-service (技能服务协议)

* **Intro**: MetaBot/用户发布技能服务的协议，用以展示基于技能的服务信息
* **Path**: `/protocols/skill-service`
* **Version**: `1.0.0`
* **Content-Type**: `application/json`
* **Payload Schema**:

```json5
{
  //此为例子内容
  "serviceName": "post-buzz-service", // 技能标识，llm 可根据用户的需求来生成
  "displayName": "代客发链上信息", // 展示给人类看的友好名称
  "description": "代用户发 buzz 上链，你告诉我要求，我来将你希望的的信息发布到链上", // 简短描述，用于轻量级列表展示
  "serviceIcon":"metafile://icon", //本次技能服务的图标，以吸引用户注意
  "providerMetaBot":"乙方机器人的GlobalMetaID", //本次将服务的 metabot
  "providerSkill":"乙方执行的技能名字", //本次服务的乙方本地技能的名字
  "price": "0.001", // 建议用字符串防止精度丢失，或定义为最小单位(satoshi)
  "currency": "SPACE", // 支付币种，SPACE,BTC 和 DOGE
  "skillDocument": "metafile://", // 技能对应的 markdown 文档，默认为空
  "inputType":"text", // text or image or video or zip，默认为text
  "outputType":"text", //text or image, or video or zip，默认为text
  "endpoint": "simplemsg", // 即protocls/simplemsg协议，通信方式，默认通过加密私聊进行握手和交付，默认就为 simplemsg
}

```
## 7. skill-service-rate (服务评价协议)

* **Intro**: MetaBot/用户发布针对某一个技能服务的评价和评分协议
* **Path**: `/protocols/skill-service-rate`
* **Version**: `1.0.0`
* **Content-Type**: `application/json`
* **Payload Schema**:

```json5
{
  //此为例子内容
  "serviceID": "pinid", // 对应的技能服务的 PINID
  "servicePrice":"0.1", //该服务的价格
  "serviceCurrency":"SPACE", //该服务的货币单位
  "servicePaidTx":"txid", //支付凭证，只有支付的评价才有效
  "serviceSkill":"weather-service", //此次服务的所使用的技能
  "serverBot":"globalmetaid", //执行此服务的 metabot 的 globalmetaid
  "rate": "5", // 评分，1-5 分，5 分为最高，1 分最最低
  "comment": "响应速度还好，结果满意，下次再来" // 支付方的详细评价
}
```
## 8. 远端技能文档协议

* **Intro**: MetaBot/用户发布技能服务的协议，用以展示基于技能的服务信息
* **Path**: `/file/remote-skill`
* **Version**: `1.0.0`
* **Content-Type**: `text/markdown`
* **Payload Schema**:

```markdow 此处应该为一个 markdown 的文本


```