# templates 目录说明

`templates/` 是 `metabot-create-metaapp` 的参考模板目录，用于快速初始化 MetaApp 项目结构。

## 目录职责

- `index.html` / `app.js` / `app.css` / `idframework.js`：应用入口与基础框架模板。
- `commands/`：业务命令模板，负责 API 调用、校验、状态更新。
- `idcomponents/`：Web Components 模板，负责 UI 与事件派发。
- `stores/`：状态管理模板（如支付审批等）。
- `idconfig.js` / `idutils.js`：基础配置与通用工具模板。

## 与 idframework 目录的关系

- `idframework/` 是能力全集与运行时依赖来源。
- `templates/` 是可复制、可起步的参考集，不要求 1:1 覆盖 `idframework/` 的所有文件。
- 当业务需要而模板尚未覆盖时，可按需从 `idframework/` 拷贝对应文件到项目目录（保持相对路径、命名和依赖关系一致）。

## 按需引入原则

- 所有项目都应优先包含基础集：`idframework.js`、`idconfig.js`、`idutils.js`。
- 仅当业务需要时再引入：
  - `metaid.js`（链上交易/TxComposer）
  - `crypto.js`（加解密）
  - `socket-client.js` + `stores/simple-talk.js` + `stores/ws-new.js`（实时聊天）

