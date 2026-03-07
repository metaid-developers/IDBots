# id-chat-input-box 新增功能说明

## 本次新增文件

- `idframework/idcomponents/id-chat-input-box.js`
- `templates/idcomponents/id-chat-input-box.js`
- `idframework/commands/SendChatMessageCommand.js`
- `templates/commands/SendChatMessageCommand.js`
- `idframework/stores/useApprovedStore.js`
- `templates/stores/useApprovedStore.js`
- `test/chat.html`

## 核心业务点

### 1) 新增 `id-chat-input-box` 组件

- 按 `idframework` 风格实现，组件只负责 UI/交互并通过 `IDFramework.dispatch` 派发业务命令。
- 支持群聊和私聊两种模式：
  - 群聊：`mode="group"` + `group-id`
  - 私聊：`mode="private"` + `to-metaid`
- 保留聊天占位文案风格：`發消息到 #{群名称}...` / `發消息到 @{用户名}...`

### 2) 输入框行为增强

- 支持动态高度自适应（多行时自动增高，最大高度后内部滚动）。
- 支持 `Shift + Space` 快捷换行。
- PC 端 placeholder 增加“Shift+Space 换行”提示；移动端不显示该提示。

### 3) 文件能力增强（去除红包逻辑）

- 去掉 IDChat 红包相关逻辑（包括 `SimpleMessageType.red` 相关）。
- 支持上传并发送：
  - 图片
  - 视频
  - 其他文件（pdf/zip/md/mp3/txt 等）
- 预览策略：
  - 图片：直接缩略图
  - 视频：提取首帧作为封面
  - 其他文件：按扩展名展示类型图标

### 4) 文件大小限制

- 单文件上限为 `1GB`。
- 超限时提示：`不支持上传超过1GB的文件`。

### 5) 附件上链方式（与 PostBuzzCommand 保持一致）

- 通过复用 `PostBuzzCommand` 的 `_uploadFileToMetafile`：
  - `> 5MB` 走 `runChunkedUploadFlow({ asynchronous:false })`
  - `<= 5MB` 走 `uploadFileToChainDirect(file)`
- 上链成功后使用 `metafile://{txid}i0` 作为附件 URI。

### 6) 聊天消息上链协议

- 新增 `SendChatMessageCommand`，不再依赖 IDChat 的 `tryCreateNode/createShowMsg`。
- 使用 `window.metaidwallet.createPin` 进行上链。
- 协议：
  - 群聊：`/protocols/simplegroupchat`
  - 私聊：`/protocols/simplemsg`
- 消息体字段按需求组织（包含 `groupId/to`、`content`、`contentType`、`timestamp`、`replyPin` 等）。

### 7) smallPay 免确认支持

- 新增 `useApprovedStore`（轻量 no-build 版本），提供：
  - `getPaymentStatus()`
  - `getAutoPayment()`
  - `canUse/canApproved` 状态
- 发送消息前会读取审批状态并判断是否可使用 smallPay。
- 阈值控制：
  - 估算费用 `<= 10000 sats` 才启用 smallPay 标记
  - 超过阈值继续走 `metaidwallet.createPin` 常规路径
- 本实现没有使用 `window.metaidwallet.pay` 作为聊天上链主流程。

### 8) 登录态拦截

- 组件与命令均增加登录态检查：
  - 钱包连接状态
  - 钱包地址
  - `userStore.user` 非空
  - `metaidwallet` 注入可用
- 未登录时直接提示并中断发送。

## 测试页说明

- 新增 `test/chat.html` 用于单页测试。
- 默认群 `groupId`：
  - `cd8fc34e6ea88ffb717cccc267646f2f3cc1da9a40e180b3ea3084c031a24ff4i0`
- 页面已引入：
  - `id-connect-button`（登录）
  - `id-chat-input-box`（发送）
  - `useApprovedStore`、`metaid.js`、`idframework.js`
- 页面初始化时注册命令：
  - `fetchUser`
  - `sendChatMessage`

## 本次增量修改（2026-02-27）

### 1) `SendChatMessageCommand` 增加消息加密

- 文件：
  - `idframework/commands/SendChatMessageCommand.js`
  - `templates/commands/SendChatMessageCommand.js`
- 群聊加密：
  - 使用 `groupId.substring(0, 16)` 作为密钥。
  - 采用 `AES-CBC + Pkcs7 + 固定 iv(0000000000000000)`。
  - 输出格式为十六进制字符串（与 `Buffer.from(base64, 'base64').toString('hex')` 语义一致）。
- 私聊加密：
  - 先用对方 `globalMetaId` 查询用户信息，提取 `chatpubkey`。
  - 再调用 `window.metaidwallet.common.ecdh({ externalPubKey })` 获取 `sharedSecret`。
  - 最后执行 `AES.encrypt(message, sharedSecret).toString()`。
- 命令会根据模式自动写入：
  - 群聊：`encryption: 'aes'`
  - 私聊：`encrypt: 'ecdh'`

### 2) `id-chat-input-box` 改为单文件发送

- 文件：
  - `idframework/idcomponents/id-chat-input-box.js`
  - `templates/idcomponents/id-chat-input-box.js`
- 上传输入框移除 `multiple`，组件在每次选择文件时仅保留最后一个有效文件。
- `_send` 中改为传 `file`（单个）而不是 `files`（数组）。
- 与业务约束一致：`messageContent` 在命令层只会是“文本”或“附件 URI”二选一。

### 3) `FetchUserCommand` 增强 `globalmetaid` 查询兼容

- 文件：
  - `idframework/commands/FetchUserCommand.js`
  - `templates/commands/FetchUserCommand.js`
- 支持两种 payload 字段：
  - `globalMetaId`
  - `globalmetaid`
- 查询接口统一为：
  - `/v1/info/globalmetaid/${globalMetaId}`
- 另外在成功路径返回 `normalizedUserData`，便于上层命令直接复用查询结果。

## 本次增量修改（按最新需求修正）

### 1) `SendChatMessageCommand` 加密与单文件消息内容修正

- 文件：
  - `idframework/commands/SendChatMessageCommand.js`
  - `templates/commands/SendChatMessageCommand.js`
- 群聊加密：
  - `encrypt(content, groupId.substring(0, 16))` 语义实现。
  - `AES-CBC + Pkcs7 + iv=0000000000000000`。
  - 加密结果由 base64 转 hex 后写入 `body.content`。
- 私聊加密：
  - 发送前调用 `fetchUserInfo`（传入对方 `globalMetaId`）获取 `chatpubkey`。
  - 再调用 `window.metaidwallet.common.ecdh({ externalPubKey })` 获取 `sharedSecret`。
  - 最后执行 `AES.encrypt(message, sharedSecret).toString()`。
- 单文件与消息内容规则：
  - 命令只按单文件主流程处理（兼容 `payload.files[0]` 兜底）。
  - `messageContent` 规则改为：有附件时用附件 `metafile://...`，否则用文本 `content`。
  - 不再使用 `{ text, attachments }` 的 JSON 结构作为 `messageContent`。

### 2) `FetchUserInfoCommand` 按 `globalMetaId` 查询并返回接口 `data`

- 文件：
  - `idframework/commands/FetchUserInfoCommand.js`
  - `templates/commands/FetchUserInfoCommand.js`（新增，保持模板同步）
- 查询兼容：
  - 支持 `payload.globalMetaId` / `payload.globalmetaid`。
  - 查询地址：`/v1/info/globalmetaid/${globalmetaid}`。
  - 仍保留 `metaid` 查询兼容（`/info/metaid/${metaid}`）。
- 返回值修正：
  - 统一返回接口响应的 `data` 对象（若无 `data` 则回退原对象），方便直接读取 `chatpubkey`。

### 3) 受影响注册逻辑同步

- 文件：
  - `templates/app.js`
  - `test/chat.html`
- 新增注册：
  - `IDFramework.IDController.register('fetchUserInfo', './commands/FetchUserInfoCommand.js')`
  - 测试页也同步注册 `fetchUserInfo`，确保私聊加密链路可直接调用。

