# templates 目录说明

`templates/` 是 `metabot-create-metaapp` 的参考模板目录，用于快速初始化 MetaApp 项目结构。

## 目录职责

- `index.html` / `app.js` / `app.css` / `idframework.js`：应用入口与基础框架模板。
- `commands/`：业务命令模板，负责 API 调用、校验、状态更新。
- `components/`：Web Components 模板，负责 UI 与事件派发。
- `stores/`：状态管理模板（如 `stores/chat/`、`stores/note/`）。
- `utils/idconfig.js` / `utils/idutils.js`：基础配置与通用工具模板。
- `vendors/`：按需加载的第三方/链上能力运行时文件。

## 与 idframework 目录的关系

- `idframework/` 是能力全集与运行时依赖来源。
- `templates/` 的框架依赖基线与 `idframework/` 保持同结构，生成时仍需按业务白名单选择文件。
- 当业务需要而模板尚未覆盖时，可按需从 `idframework/` 拷贝对应文件到项目目录（保持相对路径、命名和依赖关系一致）。

## 按需引入原则

- 所有项目都应优先包含基础集：`idframework.js`、`utils/idconfig.js`、`utils/idutils.js`。
- 仅当业务需要时再引入：
  - `vendors/metaid.js`（链上交易/TxComposer）
  - `vendors/crypto.js`（加解密）
  - `vendors/socket-client.js` + `stores/chat/simple-talk.js` + `stores/chat/ws-new.js`（实时聊天）

