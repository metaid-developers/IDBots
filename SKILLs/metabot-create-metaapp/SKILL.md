---
name: metabot-create-metaapp
description: MetaBot 专属的 MetaApp 开发与交付套件。基于 IDFramework (No-Build, MVC) 架构，支持从零构建链上前端应用、编写业务指令 (Commands)、组件开发 (Web Components) 以及最终的打包交付 (Zip)。
dependencies: node.js >= 18, alpine.js, unocss
---

# metabot-create-metaapp

赋予 **MetaBot** 开发 MetaWeb 链上原生应用 (MetaApp) 的能力。集成了架构设计、代码生成与发布打包的全流程。

## 核心工作流 (Workflows)

### 1. 应用开发 (Development)
当用户指令涉及“创建 MetaApp”、“开发前端”、“增加功能”时，**MetaBot 必须严格遵循** IDFramework 架构。

#### 1.0 硬检查清单门禁 (生成前/交付前，强制执行)
为避免“生成产物看似可运行但不符合 MetaApp 规范”的问题，必须执行如下两阶段门禁。**任一失败即停止，不得继续生成或交付**。

* **生成前门禁 (pregen，强制)**
  在仓库根目录执行：
  ```
  node metabot-create-metaapp/scripts/validate_metaapp_checklist.js --phase pregen --project ~/idbots/project/<project_name>
  ```
  通过条件：目标目录位于 `~/idbots/project/` 下、模板/基线文件完整、开发指南文件存在。

* **交付前门禁 (predeliver，强制)**
  在仓库根目录执行：
  ```
  node metabot-create-metaapp/scripts/validate_metaapp_checklist.js --phase predeliver --project ~/idbots/project/<project_name>
  ```
  通过条件：最小可运行文件集齐全、`index.html` 核心脚本与 `id-connect-button` 渲染存在、`app.js` 基础命令注册齐全、登录核心文件与 `idframework/` 基线对齐、无上级运行依赖引用。

* **启动验收门禁 (smoke test，强制)**
  在通过 `predeliver` 后，必须执行”可启动 + 控制台无报错”验收，未通过不得交付：
  1) 在 `~/idbots/project/` 目录下启动本地服务：
     `npx http-server . -a 127.0.0.1 -p 5602 -o /<project_name>/index.html -c-1`
  2) 打开页面后执行首屏验证：页面能正常渲染、`id-connect-button` 显示正常、业务主组件可见。
  3) 打开浏览器控制台检查：不得出现会影响运行的错误（如 `No command registered for event: ...`、模块加载失败、脚本 404、未定义对象异常等）。
  4) 若发现报错：必须先定位并修复（例如补齐 `app.js` 命令注册、补齐缺失文件引用、修正加载顺序），然后重复 1)-3) 直到控制台无阻塞性错误。
  5) 仅当 `predeliver` + `smoke test` 均通过，才允许告知用户本地启动命令并交付。

* **打包门禁联动 (强制)**
  `scripts/package_metaapp.js` 已内置 `predeliver` 硬检查；若检查失败，打包必须中止。

* **前置阅读 (Critical)**: 开发前**必须**读取并理解 `references/MetaApp-Development-Guide.md`。
* **脚手架基线 (强制)**: 必须以 `templates/` 作为生成基线，不允许绕过模板从零散文件拼装生成。
* **项目目录位置 (强制)**: 使用 `metabot-create-metaapp` 生成 MetaApp 时，目标项目目录**必须创建在本机用户根目录的 `idbots/project/` 子目录下**（例如 Windows 系统为 `C:\Users\<用户名>\idbots\project\`，macOS/Linux 系统为 `~/idbots/project/`），路径根据当前用户的 Home 目录动态确定。**禁止**将生成产物放在仓库目录内或 `metabot-create-metaapp/` 目录内。示例：应生成到 `~/idbots/project/Simple-ID-Buzz/`。
* **`index.html` 基线继承 (强制)**: 目标项目 `index.html` 必须以 `templates/index.html` 为基础生成，默认应完整保留其中与登录态初始化、localStorage 持久化、Metalet 事件监听、App/WebView 兼容处理相关的核心逻辑；仅允许做业务区块插入或必要配置调整，禁止删改导致这些能力失效。
* **依赖独立化 (强制)**: 基于 `idframework` 生成 MetaApp 时，所有运行依赖文件（`idframework.js`、`idconfig.js`、`idutils.js`、`metaid.js`、`crypto.js`、`socket-client.js`、`commands/`、`idcomponents/`、`stores/` 等）必须放置在目标项目目录内并使用项目内相对路径引用。**禁止**通过 `../` 或其它上级目录路径引用 `metabot-create-metaapp` 下文件作为运行依赖。
* **多 MetaApp 并存隔离 (强制)**: 当本地同时存在多个 MetaApp 项目时，生成器必须保证每个项目为“完全独立版”。运行时依赖只允许来自当前目标项目目录，**严禁**引用任意其它 MetaApp 目录文件（例如 `../Snake-Score-MetaApp/*`、`../IDChat/*`、`../<other-metaapp>/*`）。若发现跨项目引用，视为生成失败，必须改为将所需文件复制到当前项目内并改为项目内相对路径。
* **最小可运行文件集 (强制)**: 生成任何 MetaApp 至少应包含并正确接线以下文件：`index.html`、`app.css`、`app.js`、`idframework.js`、`idconfig.js`、`idutils.js`、`bootstrap-stores.js`、`app-env-compat.js`、`idcomponents/id-connect-button.js`、`commands/FetchUserCommand.js`、`commands/CheckWebViewBridgeCommand.js`、`commands/CheckBtcAddressSameAsMvcCommand.js`。缺少任一项视为生成不合格。
* **按业务白名单引入 (强制)**: 除“最小可运行文件集”外，其余 `commands/`、`idcomponents/`、`stores/` 文件必须根据当前业务需求按需引入，禁止整包复制模板样例。
* **默认禁带无关业务模块 (强制)**: 生成某一具体业务 MetaApp（例如 Snake）时，若需求未涉及 Buzz/Chat/支付审批，不得默认引入或注册 `FetchBuzzCommand.js`、`PostBuzzCommand.js`、`SendChatMessageCommand.js`、`GetPinDetailCommand.js`、`id-buzz-list.js`、`id-post-buzz.js`、`id-chat-input-box.js`、`stores/useApprovedStore.js` 等无关模块。
* **命令注册时序防竞态 (强制)**: `app.js` 中所有基础命令与业务命令（至少包含 `fetchUser`、`checkWebViewBridge`、`checkBtcAddressSameAsMvc` 及业务新增命令）必须在**模块加载阶段**完成注册（例如顶层立即注册或“框架就绪后立即重试注册”）；**禁止**仅在 `DOMContentLoaded` 内延后注册，避免首屏阶段出现 `No command registered for event: ...`。
* **早期 dispatch 保护 (强制)**: 若 `idcomponents/*` 或 `app-env-compat.js` 在 `connectedCallback`/首屏初始化期间会触发 `IDFramework.dispatch(...)`，必须先确保对应命令已注册（例如轮询 `IDController.commands.has(cmd)`、封装 waitForCommand），再执行 dispatch。
* **目录结构对齐 (强制)**: 生成结果必须对齐 `templates/` 的目录组织（入口文件 + `commands/` + `idcomponents/`，以及按需 `stores/`）。禁止生成与模板结构明显不一致的“扁平化”或“缺目录”项目。
* **基线文件强一致 (强制)**: 凡使用 `metabot-create-metaapp/` 下文件开发 MetaApp 业务（包括但不限于 `idframework.js`、`commands/FetchUserCommand.js`、`idcomponents/id-connect-button.js`、`bootstrap-stores.js`、`app-env-compat.js` 等），目标项目实现必须与 `metabot-create-metaapp/` 对应基线文件保持能力与行为一致；**禁止**由 LLM 自主决策进行阉割、简化、删减关键流程或弱化异常处理。
* **核心依赖七件套强制代码平移 (最高优先级)**: 生成任意 MetaApp 时，以下 7 个文件必须从 `metabot-create-metaapp/idframework/` 同路径文件进行强制性代码平移（作为唯一真值来源），**只允许在其上做增量扩展，不允许任何删减/阉割/简化**：  
  `idframework.js`、`bootstrap-stores.js`、`app-env-compat.js`、`commands/FetchUserCommand.js`、`commands/CheckWebViewBridgeCommand.js`、`commands/CheckBtcAddressSameAsMvcCommand.js`、`idcomponents/id-connect-button.js`。  
  若业务无需某些扩展逻辑，可保持与基线一致；但不得以“精简版/改写版”替代。
* **核心依赖七件套交付前验收 (强制)**: 交付前必须完成并通过以下自检：  
  1) 目标项目上述 7 文件均存在，且路径与命名完全一致；  
  2) `app.js` 已注册 `fetchUser`、`checkWebViewBridge`、`checkBtcAddressSameAsMvc` 三个基础命令；  
  3) `index.html` 已按基线引入 `bootstrap-stores.js`、`idframework.js`、`idcomponents/id-connect-button.js`、`app-env-compat.js`；  
  4) 七件套文件能力完整，不存在删除关键流程、删除异常处理、删除监听链路等“减配”行为（允许新增，但不允许减少）；  
  任一未通过即视为不合格，不得交付。
* **命令注册时序交付验收 (强制)**: 交付前必须确认：  
  1) `app.js` 可在不依赖 `DOMContentLoaded` 的情况下完成命令注册（包含基础命令与业务命令）；  
  2) 首屏初始化链路（含 `app-env-compat.js`、业务组件 `connectedCallback`）中所有 dispatch 的命令均已可用；  
  3) 浏览器控制台不得出现 `No command registered for event: ...`。
* **架构模式**:
    * **View**: `idcomponents/*.js` (Web Components + Alpine.js)。**禁止**在组件内写业务逻辑。
    * **Logic**: `commands/*.js` (Command Pattern)。所有 API 调用、状态变更**必须**在此完成。
    * **Core**: `idframework.js` (MVC 核心) + `app.js` (配置与注册)。

### 2. 应用打包 (Packaging)
当用户指令涉及“打包应用”、“生成 Zip”、“准备发布”时，**必须直接执行**以下脚本。

* **脚本**: `node scripts/package_metaapp.js <project_path> [--output <dir>]`
* **功能**: 自动校验项目结构 -> 执行 predeliver 门禁 -> 过滤开发文件 (.git, node_modules) -> 生成发布包。
* **输出**: `dist-<timestamp>.zip` (位于项目根目录，或 `--output` 指定目录)。
* **校验规则**: 目标目录必须包含 `index.html`, `app.js`, `app.css`, `idframework.js` 及 `idcomponents/`, `commands/` 目录，否则脚本会报错。

## 文件结构与职责 (Architecture)

MetaBot 在编写代码时需严格遵守以下文件职责：

| 文件/目录 | 核心职责 | AI 编写规范 |
| :--- | :--- | :--- |
| **`index.html`** | 入口 | 必须声明并按顺序引入 `bootstrap-stores.js`、`idconfig.js`、`idutils.js`、`idframework.js`、`idcomponents/id-connect-button.js`、`app.js`、`app-env-compat.js`；当业务命令需要 `mvc`/`TxComposer` 时按需引入 `metaid.js`；当组件/命令需要加密能力时按需引入 `crypto.js`（提供 `window.CryptoJS`）；当聊天能力启用时按需引入 `socket-client.js` 与对应 stores；**禁止**把核心业务流程直接写在页面脚本中。 |
| **`app.js`** | 配置 | 注册 ServiceLocator，注册 Models，**注册 Commands**。 |
| **`commands/`** | **业务逻辑** | `export default class XxxCommand`。调用 Delegate，更新 Store。 |
| **`idcomponents/`** | **视图组件** | Shadow DOM 隔离。只负责渲染 Store 数据和 Dispatch 事件。 |
| **`stores/`** | 状态中台 | 承载复杂领域状态（如聊天分页、socket 缓存、支付审批状态），由 Commands 与组件共同消费。 |
| **`app.css`** | 样式 | 定义 CSS 变量 (Theming)。支持深色模式。 |
| **`idframework.js`** | 框架核心 | 仅承载跨业务通用能力（Model/Delegate/Controller/dispatch 机制）。**禁止**塞入聊天、Buzz、具体业务协议细节。 |

## 当前 IDFramework 依赖层级 (按需引入)

以下为 `metabot-create-metaapp/idframework/` 当前可复用能力。生成 MetaApp 时应根据业务启用，不做“一刀切全引入”。

### A. 基础必引入 (所有 MetaApp)
- `index.html`、`app.css`、`app.js`: 入口与应用配置。
- `idframework.js`: MVC 核心、dispatch、命令执行。
- `idconfig.js`、`idutils.js`: 默认服务配置与通用工具。
- `bootstrap-stores.js`、`app-env-compat.js`: store 持久化与 App/WebView 兼容桥接。
- `idcomponents/id-connect-button.js`: 登录入口组件。
- `commands/FetchUserCommand.js`: 登录后用户资料拉取命令。
- `commands/CheckWebViewBridgeCommand.js`、`commands/CheckBtcAddressSameAsMvcCommand.js`: WebView/地址一致性基础校验命令（必须存在并在 `app.js` 注册）。

### B. 业务按需引入
- **总原则**
  - 下列能力均为“按需模块”，只有当需求明确涉及该业务时才允许引入与注册。
  - 未被需求覆盖的模块禁止出现在目标项目目录、`index.html` 引用和 `app.js` 命令注册中。
- **身份与链上能力**
  - `metaid.js`: `MetaIDJs`、`TxComposer`、`mvc` 等链上能力。
  - 仅当命令涉及交易构建/签名/上链时启用；例如业务代码需要 `TxComposer`、`mvc` 对象时必须引入。
- **加密能力**
  - `crypto.js`: 提供 `window.CryptoJS`。
  - 仅当命令或组件存在 AES/ECDH 等加解密逻辑时启用。
- **聊天能力**
  - `socket-client.js`（注意：当前为 `.js`，非 `.ts`）：聊天 websocket 客户端封装。
  - `idcomponents/id-chat-box.js` 与 `idcomponents/id-chat-bubble.js` 通常应成组引入；涉及发言输入时同时引入 `idcomponents/id-chat-input-box.js`。
  - `commands/SendChatMessageCommand.js` 为聊天发送必要命令；结合用户资料展示/会话资料时配套 `commands/FetchUserInfoCommand.js`。
  - `stores/simple-talk.js`、`stores/ws-new.js`、`stores/useApprovedStore.js` 与聊天相关组件/命令强关联，启用聊天业务时应一并评估并按需引入。
- **支付审批能力**
  - `stores/useApprovedStore.js`: smallPay 自动支付能力状态。
- **Buzz 能力**
  - `idcomponents/id-buzz-list.js`、`id-post-buzz.js`、`id-attachments.js`
  - `commands/FetchBuzzCommand.js`、`PostBuzzCommand.js`

## 哪些新增逻辑应写入 `idframework.js` (核心边界)

为了保持“核心稳定 + 业务可插拔”，新增逻辑按以下规则处理：

### 应写入 `idframework.js` 的逻辑
- **通用机制增强**：不依赖具体业务协议、可被任意 MetaApp 复用的能力。
- **store 自动注入策略扩展**：如 dispatch 的通用 store 发现策略（在不破坏兼容的前提下扩展常见 store 名单）。
- **Delegate 通用抽象**：统一请求/鉴权/错误处理能力，但不绑定某一业务接口语义。
- **Built-in Command 的基础能力**：钱包连接、通用 createPin 这类跨业务基础命令。

### 不应写入 `idframework.js` 的逻辑
- 任何具体业务域流程：聊天拉取、Buzz 时间线、帖子协议字段拼装等。
- 具体 API path、特定后端字段映射、业务路由约束。
- UI 交互细节（dropdown、mention、scroll、socket 重连策略等）。

### 新增能力推荐落点
- **`app.js`**：按业务注册命令（如 `fetchBuzz`、`sendChatMessage`、`fetchUserInfo`）。
- **`commands/*.js`**：协议体拼装、业务校验、服务调用。
- **`stores/*.js`**：复杂状态与缓存。
- **`idcomponents/*.js`**：纯视图渲染与事件派发。

## 代码生成规范 (Coding Constraints)

1.  **No-Build 哲学**: 使用原生 ES Modules。**严禁**引入 Webpack/Vite/Babel 或 `require()` 语法。
2.  **路径引用**: 所有 import **必须**使用相对路径 (如 `./commands/Auth.js`)，**严禁**使用绝对路径 (`/src/...`)。
   * 生成项目时，业务运行依赖只允许引用目标项目目录内文件；**严禁**引用上级目录（如 `../metabot-create-metaapp/...`）。
   * 本规则同样适用于“其它同级 MetaApp 目录”：**严禁**出现 `../<other-metaapp>/...` 的模块引用（包含 `index.html` 的 `<script src>`、`import`、动态加载路径、命令注册路径等）。
3.  **Command 模式**:
    * 组件**不直接**调 API，必须 `IDFramework.dispatch('cmdName', payload)`。
    * Command **不直接**操作 DOM，必须修改 Alpine Store (`stores.user.name = ...`) 触发响应式更新。
    * 所有**上链相关逻辑**（如 `createPin`、签名、支付、UTXO 处理、文件上链）必须先做登录态校验：若 `wallet` 未连接、`user` 为空对象或钱包注入不可用，则立即中断并提示“请先登录钱包后再进行上链操作”。
    * `app.js` 中命令注册必须优先于首屏可能触发的 dispatch 链路（如 `app-env-compat.js`、组件 `connectedCallback`）；严禁把“首次注册命令”的唯一入口放在 `DOMContentLoaded` 回调中。
4.  **样式隔离**: 组件内使用 Shadow DOM 和 CSS 变量 (`var(--id-color-bg)`)，确保样式不污染。
5.  **必要脚本声明**:
    * `./idconfig.js`、`./idutils.js` 为基础必引入脚本。
    * `./bootstrap-stores.js` 为强制引入脚本，负责在 `alpine:init` 时注册并持久化 `wallet/app/user` stores；**禁止省略，且必须与 `idframework/bootstrap-stores.js` 基线一致（可增不可减）**。
    * `./app-env-compat.js` 为强制引入脚本，负责 Metalet 事件监听、WebView 兼容与账户状态巡检；**禁止省略，且必须与 `idframework/app-env-compat.js` 基线一致（可增不可减）**。
    * `./idcomponents/id-connect-button.js` 为登录基础组件，默认 MetaApp 必须引入并渲染；生成时其实现必须与 `metabot-create-metaapp/idframework/idcomponents/id-connect-button.js` 保持对齐（以 `idframework` 版本为唯一基线来源，**可增不可减**）。
    * `./commands/FetchUserCommand.js` 为登录后用户信息拉取基础命令，默认 MetaApp 必须在 `app.js` 中注册（如 `fetchUser`），并与 `idframework/commands/FetchUserCommand.js` 基线保持一致（**可增不可减**）。
    * `./commands/CheckWebViewBridgeCommand.js`、`./commands/CheckBtcAddressSameAsMvcCommand.js` 为基础命令，默认 MetaApp 必须存在并在 `app.js` 中注册（如 `checkWebViewBridge`、`checkBtcAddressSameAsMvc`），并分别与 `idframework/commands/` 对应基线保持一致（**可增不可减**）。
    * `./metaid.js` 为按需引入：仅当业务逻辑需要使用 `MetaIDJs`（例如 `mvc`、`TxComposer`）时才引入。
    * `./crypto.js` 为按需引入：仅当组件或 Command 需要 `CryptoJS`（如群聊/私聊消息加密）时才引入，并通过 `window.CryptoJS` 使用，禁止再通过远程 CDN 动态 import。
    * `./socket-client.js` 与 `./stores/*.js` 为按需引入：仅当业务涉及实时通信、复杂分页缓存、支付审批状态等时启用。聊天业务场景下应优先按“组件 + 命令 + stores”成组引入。
    * 除基础命令/组件外，其他 `commands/*.js`、`idcomponents/*.js`、`stores/*.js` 必须按具体业务需求启用，**禁止**“默认全量引入”。

## 常用开发模板

### Command 模板
```javascript
export default class FetchDataCommand {
  async execute({ payload, stores, delegate }) {
    // 1. 调用服务 (通过 Delegate)
    const data = await delegate('service_name', `/api/resource/${payload.id}`);
    // 2. 更新状态 (Alpine Store)
    stores.appData.currentList = data;
  }
}
```

### Component 模板
```javascript
class IdCard extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }); }
  connectedCallback() {
    const store = Alpine.store('appData'); // 绑定数据
    this.shadowRoot.innerHTML = `<div>${store.currentList.name}</div>`;
  }
}
customElements.define('id-card', IdCard);
```

## 模板目录约束 (`templates/`)

`templates/` 是开发 MetaApp 的**参考模板目录**，用于快速起步和能力复用。

- `templates/index.html`、`templates/app.js`、`templates/app.css`、`templates/idframework.js` 为标准入口模板。
- `templates/bootstrap-stores.js`、`templates/app-env-compat.js` 为入口强制依赖脚本，用于承载原先 `index.html` 的关键初始化逻辑（store 持久化 + App/WebView 兼容）。
- `templates/idcomponents/`、`templates/commands/`、`templates/stores/` 仅提供可复用样例；生成时必须按业务白名单挑选，**禁止整目录拷贝**到目标项目。
- `templates/index.html` 为默认唯一入口基线模板：生成目标项目时应复制并在此基础上修改，禁止使用“最简手写 index.html”替代，避免丢失用户信息持久化与 App 打开 MetaApp 的兼容逻辑。
- `templates/index.html` 中这两段关键逻辑（store 持久化初始化、App 环境兼容）已被外置到 `bootstrap-stores.js` 与 `app-env-compat.js`。生成项目时必须一并复制并保持 script 引用，禁止回退为缺失逻辑的精简版入口页。
- 登录基础能力模板要求：以下七件套必须以 `idframework/` 同路径文件为基线并保持对齐，生成目标项目时执行“强制代码平移（可增不可减）”：`idframework.js`、`bootstrap-stores.js`、`app-env-compat.js`、`idcomponents/id-connect-button.js`、`commands/FetchUserCommand.js`、`commands/CheckWebViewBridgeCommand.js`、`commands/CheckBtcAddressSameAsMvcCommand.js`。若 `templates/` 与 `idframework/` 存在差异，上述七件套一律以 `idframework/` 为准同步到目标项目，禁止保留任何简化版实现。
- 当 `templates/` 中暂未覆盖某个 `idframework/` 新能力文件时，允许按业务从 `idframework/` 同步拷贝到目标项目，并保持相对路径与命名一致（`idconfig.js`、`idutils.js` 属基础依赖，若模板缺失应优先从 `idframework/` 补齐）。
- 模板同步原则：优先保持“可运行最小集 + 常用业务模块”，避免把全部实验性文件强制塞入模板。
- 目标项目目录位置要求：目标项目必须位于本机用户根目录的 `idbots/project/` 下（即 `~/idbots/project/<project_name>/`），禁止放置在仓库目录或 `metabot-create-metaapp/` 内。
- 目标项目产物要求：从模板/框架同步到目标项目后，目标项目应可独立运行；入口脚本与模块 import 仅引用项目内路径（例如 `./idframework.js`、`./commands/*.js`、`./idcomponents/*.js`），不得保留对上级目录的运行时引用。
- 多项目并存验收要求（强制）：在交付前必须检查目标项目 `index.html`、`app.js`、`idcomponents/*.js`、`commands/*.js` 中所有脚本与模块路径，确保不包含任何 `../<other-metaapp>/` 或其它跨项目目录引用；发现即不合格，必须修复为当前项目内自包含依赖。
- 生成验收要求：必须检查 `index.html` 是否已引入并渲染 `id-connect-button`，且 `app.css` 文件存在并可被页面成功加载（非 404）。
- 本地启动验证要求（强制）：生成后必须给出并校验正确启动方式，默认在 `~/idbots/project/` 目录下执行 `npx http-server . -a 127.0.0.1 -p 5602 -o /<project>/index.html -c-1`。其中 `<project>` 为 `~/idbots/project/` 下的项目目录名。若出现 `http://127.0.0.1:5602/<project>/index.html` 404，先排查是否在错误目录启动（例如子目录启动导致路由根不一致），并给出可直接复现的修正命令。除页面可访问外，还必须完成控制台无报错检查（尤其是命令未注册、脚本加载失败、运行时未定义异常），否则不得交付。

## 测试目录约束 (`test/`)

- `test/` 目录仅用于放置测试页面（如 `test/index.html`、`test/chat.html`）。
- 测试页面可用于组件联调、命令联调、钱包连接验证、路由与 socket 验证。
- 生产打包时，测试文件不应作为业务入口；仅在开发验证阶段使用。

## 脚本索引 (Script Index)
- scripts/package_metaapp.js: 打包工具。用法: `node scripts/package_metaapp.js ~/idbots/project/my-app`
- scripts/validate_metaapp_checklist.js: 规范硬检查工具。用法: `node scripts/validate_metaapp_checklist.js --phase pregen --project ~/idbots/project/my-app`；`node scripts/validate_metaapp_checklist.js --phase predeliver --project ~/idbots/project/my-app`
- templates/: 标准项目模板 (Reference ONLY)。
- test/: 调试与联调用测试页面目录。

**注意: ** MetaApp 是运行在 MetaWeb 上的去中心化应用，代码质量直接决定用户资产安全。MetaBot 必须确保逻辑严密，并优先使用 commands/ 封装业务。