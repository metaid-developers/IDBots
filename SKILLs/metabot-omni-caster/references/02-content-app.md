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

## 45. MetaBot-Skill (MetaBot 技能协议)

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