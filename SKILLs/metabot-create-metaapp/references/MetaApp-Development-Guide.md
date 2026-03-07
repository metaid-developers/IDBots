# MetaApp 开发指南 - AI 开发助手专用

> 本文档专为 AI 开发助手设计，帮助 AI 理解 IDFramework 架构并正确生成 MetaApp 代码

## 📋 目录

- [框架概述](#框架概述)
- [IDFramework 核心职责](#idframework-核心职责)
- [MVC 架构设计](#mvc-架构设计)
- [项目结构规范](#项目结构规范)
- [文件编写指南](#文件编写指南)
- [组件开发规范](#组件开发规范)
- [命令开发规范](#命令开发规范)
- [AI 开发工作流](#ai-开发工作流)
- [常见场景示例](#常见场景示例)

---

## 框架概述

### 技术栈

- **响应式系统**：Alpine.js (CDN) - 提供全局状态管理和响应式绑定
- **样式系统**：UnoCSS Runtime (CDN) - 提供工具类样式
- **组件系统**：Native Web Components (Custom Elements) - 视图层组件
- **架构模式**：Command Pattern + MVC - 业务逻辑组织方式

### 核心特性

1. **No-Build 架构**：纯原生 ES 模块，无需编译步骤，直接运行
2. **单数据源（Single Source of Truth）**：所有应用状态集中在 Model 层（Alpine.js stores）
3. **事件驱动**：组件通过事件通信，不直接调用
4. **按需加载**：组件和命令支持动态导入，减少初始加载时间
5. **链上存储**：所有文件最终可存储在区块链上（MetaID Protocol）

---

## IDFramework 核心职责

### 1. 什么是 IDFramework？

`idframework.js` 是每个 MetaApp 项目的**核心框架文件**，必须引入。它提供了：

- **Model 层管理**：初始化和管理全局状态（Alpine.js stores）
- **Controller 层**：事件到命令的映射和路由
- **Delegate 层**：服务通信抽象（API 调用）
- **内置命令**：提供常用功能（如 `connectWallet`、`createPin`）

### 2. IDFramework 如何工作？

#### 数据流向

```
View (组件) 
  ↓ 派发事件
IDController (控制器)
  ↓ 路由到命令
Command (业务逻辑)
  ↓ 调用服务
BusinessDelegate (服务代理)
  ↓ 获取数据
Model (状态更新)
  ↓ 响应式绑定
View (自动更新)
```

#### 关键 API

**初始化框架**：
```javascript
IDFramework.init({
  // 自定义 Models
  user: { name: '', email: '' },
  buzz: { list: [], isLoading: false }
});
```

**注册命令**：
```javascript
// 注册文件命令（懒加载）
IDFramework.IDController.register('fetchUser', './commands/FetchUserCommand.js');

// 注册内置命令
IDFramework.IDController.registerBuiltIn('connectWallet', IDFramework.BuiltInCommands.connectWallet);
```

**派发事件**：
```javascript
// 在组件或任何地方调用
await IDFramework.dispatch('fetchUser', { metaid: 'xxx' });

// dispatch 会返回命令执行的结果
const result = await IDFramework.dispatch('gameScores', {
  metaAppPinId: 'xxx',
  score: 100,
  gameName: 'Tetris'
});
// result 包含命令 execute 方法的返回值
if (result?.txids?.length) {
  console.log('上链成功，Txid:', result.txids[0]);
}
```

**重要说明**：
- `IDFramework.dispatch()` 返回一个 Promise，解析值为命令 `execute` 方法的返回值
- 如果命令的 `execute` 方法返回了值，`dispatch` 会将该值传递给调用者
- 如果命令没有返回值，`dispatch` 会返回 `undefined`
- 命令执行出错时，`dispatch` 会抛出异常

**加载组件**：
```javascript
// 动态加载组件（用于路由或按需加载）
await IDFramework.loadComponent('./idcomponents/id-buzz-card.js');
```

**调用服务**：
```javascript
// 在 Command 中使用
const data = await delegate('metaid_man', '/pin/path/list', {
  method: 'GET'
});
```

---

## MVC 架构设计

### 架构层次说明

#### 1. Model 层（数据层）

**位置**：`app.js` 或 `index.html` 的 `alpine:init` 中定义

**职责**：
- 存储应用的所有状态
- 提供单一数据源（Single Source of Truth）
- 通过 Alpine.js stores 实现响应式更新

**内置 Models**：
- `wallet`：钱包连接状态、地址、MetaID 等
- `app`：应用级状态（登录状态、当前视图、路由参数等）

**自定义 Models**：
```javascript
// 在 app.js 中定义
const UserModel = {
  user: {},
  isLoading: false,
  error: null
};

// 在 IDFramework.init() 中注册
IDFramework.init({
  user: UserModel
});
```

**访问方式**：
```javascript
// 在 JavaScript 中
const userStore = Alpine.store('user');

// 在 HTML/Alpine 模板中
<div x-text="$store.user.name"></div>
```

#### 2. View 层（视图层）

**位置**：`/idcomponents/` 目录

**职责**：
- **展示数据**：从 Model 绑定数据并渲染
- **派发事件**：用户交互时派发事件，不处理业务逻辑
- **"愚蠢"组件**：不包含业务逻辑，只负责 UI

**特点**：
- 使用 Web Components (Custom Elements)
- 使用 Shadow DOM 隔离样式
- 通过 `IDFramework.dispatch()` 派发事件

#### 3. Controller 层（控制层）

**位置**：`idframework.js` 中的 `IDFramework.IDController`

**职责**：
- 映射事件名称到命令
- 支持懒加载命令文件
- 管理内置命令和文件命令

**工作流程**：
1. 接收事件（通过 `IDFramework.dispatch()`）
2. 查找对应的命令（内置或文件）
3. 懒加载文件命令（如果是文件路径）
4. 执行命令并传递参数

#### 4. Command 层（业务逻辑层）

**位置**：`/commands/` 目录

**职责**：
- 执行具体的业务逻辑
- 调用 BusinessDelegate 获取数据
- 转换数据格式（DataAdapter）
- 更新 Model 层

**特点**：
- 原子化：一个命令只做一件事
- 可复用：不依赖特定的 View
- 独立测试：可以单独测试业务逻辑

#### 5. Delegate 层（服务代理层）

**位置**：`idframework.js` 中的 `IDFramework.Delegate`

**职责**：
- 抽象远程服务通信
- 处理 HTTP 请求和响应
- 错误处理
- 返回原始 JSON 数据

**两种 Delegate**：
- `BusinessDelegate`：通用 API 通信
- `UserDelegate`：用户相关 API（带 IndexedDB 缓存）

---

## 项目结构规范

### 标准目录结构

每个 MetaApp 应用的最基础要求必须包含以下目录结构：

```
metaapp/
├── index.html              # 应用入口页面（必须）
├── app.js                  # 应用配置、命令注册（必须）
├── app.css                 # 全局样式、主题变量（必须）
├── idframework.js          # 框架核心（必须，内置）
│
├── idcomponents/           # 视图组件目录
│   ├── id-connect-button.js # 用户登录组件（必须）
│   └── ...                 # 更多组件
│
└── commands/               # 业务命令目录
    ├── FetchUserCommand.js # 获取登录用户信息（必须）
    ├── CheckWebViewBridgeCommand.js # 兼容App环境所需（必须）
    ├── CheckBtcAddressSameAsMvcCommand.js # 兼容App环境所需（必须）
    └── ...                 # 更多命令
```

### 模板文件规范

**重要**：每个 MetaApp 的初始编写 `index.html` 都必须依照 `test/other/index.html` 作为初始模板规范基础上继续进行编程。

#### 1. index.html 模板

- **模板位置**：`test/other/index.html`
- **用途**：作为所有 MetaApp 的 `index.html` 初始模板
- **要求**：
  - 所有新创建的 MetaApp 必须基于此模板开始
  - 模板包含完整的 Alpine.js 初始化、localStorage 持久化、WebView 兼容性等基础功能
  - 模板已包含必要的脚本加载顺序和事件监听器设置
  - 开发者只需在此基础上添加应用特定的内容

#### 2. 最小单位目录结构参考

- **参考位置**：`test/demo/`
- **用途**：`test/demo` 相当于一个 MetaApp 的最小单位目录结构
- **要求**：
  - 即使是一个空白项目，都需要依赖 `test/demo` 的目录结构和代码
  - `test/demo` 包含了所有必需的基础文件：
    - `index.html`：基于 `test/other/index.html` 模板
    - `app.js`：包含 ServiceLocator、Model 定义、命令注册
    - `app.css`：全局样式和 CSS Variables
    - `idframework.js`：框架核心（从项目根目录复制）
    - `idcomponents/id-connect-button.js`：用户登录组件
    - `commands/FetchUserCommand.js`：获取用户信息命令
    - `commands/CheckWebViewBridgeCommand.js`：WebView 检测命令
    - `commands/CheckBtcAddressSameAsMvcCommand.js`：BTC/MVC 地址检查命令

#### 3. 开发流程

当通过大模型生成一个新的 MetaApp 时，应遵循以下步骤：

1. **创建项目目录**：创建新的 MetaApp 目录（如 `test/my-new-app/`）

2. **复制基础文件**：
   - 从 `test/other/index.html` 复制作为 `index.html` 模板
   - 从 `test/demo/` 复制以下必需文件：
     - `app.js`（作为基础配置模板）
     - `app.css`（作为样式模板）
     - `idframework.js`（框架核心，必须与项目根目录保持一致）
     - `idcomponents/id-connect-button.js`（用户登录组件）
     - `commands/FetchUserCommand.js`（获取用户信息）
     - `commands/CheckWebViewBridgeCommand.js`（WebView 检测）
     - `commands/CheckBtcAddressSameAsMvcCommand.js`（地址检查）

3. **基于模板开发**：
   - 在 `index.html` 的 `<div class="container">` 中添加应用特定内容
   - 在 `app.js` 中添加应用特定的 Model 和命令注册
   - 在 `app.css` 中添加应用特定的样式变量
   - 创建应用特定的组件和命令

### 文件职责说明

| 文件/目录 | 职责 | 是否必须 | 说明 |
|----------|------|---------|------|
| `index.html` | 应用入口，引入依赖，定义页面结构 | ✅ 必须 | **必须基于 `test/other/index.html` 模板** |
| `app.js` | ServiceLocator、Model 定义、命令注册 | ✅ 必须 | **参考 `test/demo/app.js` 结构** |
| `app.css` | 全局样式、CSS Variables 主题 | ✅ 必须 | **参考 `test/demo/app.css` 结构** |
| `idframework.js` | 框架核心 | ✅ 必须 | **内置，从项目根目录复制，AI 不需要生成** |
| `idcomponents/id-connect-button.js` | 用户登录组件 | ✅ 必须 | **从 `test/demo/idcomponents/` 复制** |
| `commands/FetchUserCommand.js` | 获取用户信息 | ✅ 必须 | **从 `test/demo/commands/` 复制** |
| `commands/CheckWebViewBridgeCommand.js` | WebView 检测 | ✅ 必须 | **从 `test/demo/commands/` 复制** |
| `commands/CheckBtcAddressSameAsMvcCommand.js` | 地址检查 | ✅ 必须 | **从 `test/demo/commands/` 复制** |
| `idcomponents/` | 视图组件 | ⚠️ 按需 | AI 根据需求生成 |
| `commands/` | 业务命令 | ⚠️ 按需 | AI 根据需求生成 |

---

## 文件编写指南

### 1. index.html 编写规范

#### 基本结构

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>My MetaApp</title>
  
  <!-- 1. Alpine.js (必须) -->
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
  
  <!-- 2. 初始化 Alpine Stores (必须在 alpine:init 中) -->
  <script>
    window.addEventListener('alpine:init', () => {
      // 定义自定义 Models（如果需要）
      // 注意：内置 Models (wallet, app) 由 IDFramework.init() 自动创建
      
      // 示例：自定义 Model
      if (!Alpine.store('myModel')) {
        Alpine.store('myModel', {
          data: [],
          isLoading: false
        });
      }
    });
  </script>
  
  <!-- 3. UnoCSS Runtime (必须) -->
  <script>
    window.__unocss = {
      theme: {},
      shortcuts: {},
      rules: []
    };
  </script>
  <script type="module" src="https://cdn.jsdelivr.net/npm/@unocss/runtime"></script>
  
  <!-- 4. 全局样式 (必须) -->
  <link rel="stylesheet" href="./app.css">
</head>
<body>
  <!-- 应用内容 -->
  <div x-data>
    <!-- 使用组件 -->
    <id-connect-button></id-connect-button>
  </div>

  <!-- 5. 基础依赖 (必须，使用相对路径) -->
  <script src="./idconfig.js"></script>
  <script src="./idutils.js"></script>

  <!-- 5.1 可选依赖（按需） -->
  <!-- 仅当命令中需要使用 MetaIDJs.mvc / MetaIDJs.TxComposer 时才引入 -->
  <!-- <script src="./metaid.js"></script> -->

  <!-- 6. 框架核心 (必须，使用相对路径) -->
  <script type="module" src="./idframework.js"></script>
  
  <!-- 7. 应用配置 (必须，使用相对路径) -->
  <script type="module" src="./app.js"></script>
</body>
</html>
```

#### 关键要点

1. **路径必须使用相对路径**：所有 `src` 和 `href` 必须使用 `./` 开头，不能使用绝对路径 `/`
2. **加载顺序**：
   - Alpine.js 必须最先加载（使用 `defer`）
   - `alpine:init` 脚本必须在 Alpine.js 之后、DOM 之前
   - `idconfig.js`、`idutils.js` 必须在 `idframework.js` 之前加载
   - 仅在需要 `MetaIDJs`（`mvc` / `TxComposer`）时才引入 `metaid.js`，且同样应在 `idframework.js` 之前加载
   - `idframework.js` 必须在 `app.js` 之前
3. **组件引入**：
   - 基础组件可以在 `index.html` 中静态引入
   - 页面组件应该通过路由动态加载（使用 `IDFramework.loadComponent()`）

#### 路由页面模板（如果使用路由）

```html
<body>
  <!-- 使用 Alpine.js x-if 根据 currentView 切换页面 -->
  <template x-if="$store.app.currentView === 'home'">
    <id-home-page></id-home-page>
  </template>
  
  <template x-if="$store.app.currentView === 'profile'">
    <id-profile-page></id-profile-page>
  </template>
  
  <!-- 默认页面 -->
  <div x-show="!$store.app.currentView">
    <h1>Welcome</h1>
  </div>
  
  <!-- 框架和配置脚本 -->
  <script type="module" src="./idframework.js"></script>
  <script type="module" src="./app.js"></script>
</body>
```

### 2. app.js 编写规范

#### 基本结构

```javascript
/**
 * App Configuration, ServiceLocator, & Initialization
 * 
 * 此文件包含：
 * - ServiceLocator: 服务端点配置
 * - 应用特定的 Models: 自定义模型
 * - 命令注册: 注册应用命令
 * - 应用初始化: 启动逻辑
 */

// ============================================
// ServiceLocator - 服务端点配置
// ============================================
// 定义各种服务的基础 URL
// 服务通过 serviceKey 在 BusinessDelegate 调用中访问
window.ServiceLocator = {
  metaid_man: 'https://manapi.metaid.io',        // MetaID 数据索引 API
  metafs: 'https://file.metaid.io/metafile-indexer/api', // MetaFS 服务（用户信息和头像）
  idchat: 'https://api.idchat.io/chat-api/group-chat',   // IDChat API 服务
  // 添加更多服务：
  // custom_service: 'https://api.example.com',
};

// ============================================
// 应用特定的 Models
// ============================================
// 这些模型扩展了框架的内置模型（wallet, app）
// 所有模型通过 Alpine.js stores 进行响应式更新

// 示例：UserModel
const UserModel = {
  user: {},        // 用户数据
  isLoading: false,
  error: null,
};

// 示例：BuzzModel
const BuzzModel = {
  list: [],        // Buzz 列表
  isLoading: false,
  error: null,
};

// ============================================
// 框架初始化
// ============================================
// 初始化 IDFramework 并注册自定义模型
// 注意：Stores 可能已经在 index.html 的 alpine:init 中注册
// 这确保了即使框架在 alpine:init 之后加载，初始化也能正常工作
window.addEventListener('alpine:init', () => {
  const initFramework = () => {
    if (window.IDFramework) {
      // 初始化框架并注册自定义模型
      // 如果 stores 已存在，initModels 不会覆盖它们
      IDFramework.init({
        user: UserModel,
        buzz: BuzzModel,
        // 添加更多自定义模型：
        // settings: SettingsModel,
      });
    } else {
      // 框架尚未加载，稍等再试
      setTimeout(initFramework, 10);
    }
  };
  
  initFramework();
});

// ============================================
// 应用初始化
// ============================================
// 注册应用命令并执行启动任务
window.addEventListener('DOMContentLoaded', async () => {
  // 等待 Alpine 完全加载
  const waitForAlpine = () => {
    return new Promise((resolve) => {
      if (typeof Alpine !== 'undefined') {
        resolve();
        return;
      }
      
      const checkInterval = setInterval(() => {
        if (typeof Alpine !== 'undefined') {
          clearInterval(checkInterval);
          resolve();
        }
      }, 50);
      
      setTimeout(() => {
        clearInterval(checkInterval);
        console.error('Alpine.js failed to load within 5 seconds');
        resolve();
      }, 5000);
    });
  };

  await waitForAlpine();

  // 验证框架已初始化
  if (!window.IDFramework) {
    console.error('IDFramework is not loaded. Please include idframework.js before app.js');
    return;
  }

  // 确保框架已初始化（注册内置命令）
  // 这可以安全地多次调用 - initModels 不会覆盖现有 stores
  IDFramework.init({
    user: UserModel,
    buzz: BuzzModel,
  });

  // ============================================
  // 注册应用命令
  // ============================================
  // 注册文件命令（懒加载）
  
  // 内置命令已由 IDFramework.init() 注册
  // 内置命令包括：connectWallet, createPin
  
  // 注册自定义命令
  IDFramework.IDController.register('fetchUser', './commands/FetchUserCommand.js');
  IDFramework.IDController.register('fetchBuzz', './commands/FetchBuzzCommand.js');
  IDFramework.IDController.register('postBuzz', './commands/PostBuzzCommand.js');
  
  // 如果需要注册内置命令的别名或自定义内置命令：
  // IDFramework.IDController.registerBuiltIn('customCommand', customFunction);

  // ============================================
  // 应用启动任务
  // ============================================
  // 执行任何初始化任务，例如：
  // - 动态加载组件（懒加载）
  // - 自动获取初始数据
  // - 检查钱包连接状态
  // - 恢复用户会话
  
  // 示例：自动获取初始数据
  // await IDFramework.dispatch('fetchBuzz', { cursor: 0, size: 30 });
});
```

#### 关键要点

1. **ServiceLocator 必须定义**：所有 API 调用都需要通过 ServiceLocator 配置服务地址
2. **Model 定义**：在 `alpine:init` 和 `DOMContentLoaded` 中都要初始化（确保兼容性）
3. **命令注册**：所有自定义命令必须在 `DOMContentLoaded` 中注册
4. **路径使用相对路径**：命令路径必须使用 `./commands/...` 格式

### 3. app.css 编写规范

#### 基本结构

```css
/**
 * 全局样式和主题变量
 * 
 * 使用 CSS Variables 实现主题系统
 * 所有组件应该使用这些变量以确保一致性
 */

:root {
  /* 颜色系统 */
  --id-color-primary: #3b82f6;
  --id-color-primary-hover: #2563eb;
  --id-color-secondary: #6b7280;
  --id-color-success: #10b981;
  --id-color-warning: #f59e0b;
  --id-color-error: #ef4444;
  
  /* 背景色 */
  --id-bg-body: #ffffff;
  --id-bg-card: #ffffff;
  --id-bg-button: var(--id-color-primary);
  --id-bg-button-hover: var(--id-color-primary-hover);
  --id-bg-button-disabled: #9ca3af;
  
  /* 文本颜色 */
  --id-text-main: #1f2937;
  --id-text-secondary: #6b7280;
  --id-text-inverse: #ffffff;
  --id-text-title: #111827;
  
  /* 间距系统 */
  --id-spacing-xs: 0.25rem;
  --id-spacing-sm: 0.5rem;
  --id-spacing-md: 1rem;
  --id-spacing-lg: 1.5rem;
  --id-spacing-xl: 2rem;
  
  /* 圆角系统 */
  --id-radius-small: 0.25rem;
  --id-radius-button: 0.5rem;
  --id-radius-card: 0.5rem;
  
  /* 阴影系统 */
  --id-shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --id-shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
  --id-shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
  
  /* 边框 */
  --id-border-color: #e5e7eb;
  
  /* 字体 */
  --id-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
  --id-font-size-xs: 0.75rem;
  --id-font-size-sm: 0.875rem;
  --id-font-size-base: 1rem;
  --id-font-size-lg: 1.125rem;
  --id-font-weight-normal: 400;
  --id-font-weight-semibold: 600;
  --id-font-weight-bold: 700;
  
  /* 过渡动画 */
  --id-transition-fast: 0.1s;
  --id-transition-base: 0.2s;
  --id-transition-slow: 0.3s;
}

/* 深色模式支持 */
@media (prefers-color-scheme: dark) {
  :root {
    --id-bg-body: #111827;
    --id-bg-card: #1f2937;
    --id-text-main: #f9fafb;
    --id-text-secondary: #9ca3af;
    --id-border-color: #374151;
  }
}

/* 全局样式 */
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 0;
  font-family: var(--id-font-family);
  background-color: var(--id-bg-body);
  color: var(--id-text-main);
}
```

#### 关键要点

1. **CSS Variables 命名规范**：使用 `--id-*` 前缀
2. **提供回退值**：组件中使用 `var(--id-*, fallback)` 格式
3. **深色模式支持**：使用 `@media (prefers-color-scheme: dark)` 提供深色模式变量

---

## 组件开发规范

### 组件职责

`/idcomponents/` 目录下的组件是**视图层**，职责是：

1. **展示数据**：从 Model（Alpine stores）绑定数据并渲染
2. **派发事件**：用户交互时派发事件，不处理业务逻辑
3. **"愚蠢"组件**：不包含业务逻辑，不直接调用 API

### 组件命名规范

- 文件名必须以 `id-` 开头（如 `id-buzz-card.js`）
- 使用 kebab-case 命名
- 对应的自定义元素标签名与文件名一致（如 `<id-buzz-card>`）

### 组件模板

```javascript
/**
 * id-my-component - 组件描述
 * 
 * 使用 Shadow DOM 和 CSS Variables 进行主题化
 * 结构（布局）通过 CSS 管理，皮肤（主题）通过 CSS Variables 管理
 */

class IdMyComponent extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    // 组件内部状态（非业务逻辑状态）
    this._internalState = null;
  }

  static get observedAttributes() {
    return ['prop1', 'prop2']; // 需要观察的属性
  }

  connectedCallback() {
    this.render();
    // 绑定事件监听器
    this._setupEventListeners();
  }

  disconnectedCallback() {
    // 清理事件监听器
    this._cleanupEventListeners();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue !== newValue) {
      this.render();
    }
  }

  render() {
    const prop1 = this.getAttribute('prop1') || '';
    const prop2 = this.getAttribute('prop2') || '';
    
    // 1. 样式部分（使用 CSS Variables）
    const styles = `
      <style>
        :host {
          display: block;
          font-family: var(--id-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
        }
        
        .container {
          background-color: var(--id-bg-card, #ffffff);
          padding: var(--id-spacing-md, 1rem);
          border-radius: var(--id-radius-card, 0.5rem);
          color: var(--id-text-main, #1f2937);
        }
        
        .button {
          background-color: var(--id-bg-button, var(--id-color-primary, #3b82f6));
          color: var(--id-text-inverse, #ffffff);
          padding: var(--id-spacing-sm, 0.5rem) var(--id-spacing-md, 1rem);
          border: none;
          border-radius: var(--id-radius-button, 0.5rem);
          cursor: pointer;
          transition: background-color var(--id-transition-base, 0.2s);
        }
        
        .button:hover {
          background-color: var(--id-bg-button-hover, var(--id-color-primary-hover, #2563eb));
        }
      </style>
    `;
    
    // 2. HTML 模板部分
    const template = `
      <div part="container" class="container">
        <h3>${this.escapeHtml(prop1)}</h3>
        <p>${this.escapeHtml(prop2)}</p>
        <button class="button" data-action="click">Click Me</button>
      </div>
    `;
    
    this.shadowRoot.innerHTML = styles + template;
    
    // 3. 重新绑定事件（因为 innerHTML 会清除事件）
    this._setupEventListeners();
  }

  _setupEventListeners() {
    const button = this.shadowRoot.querySelector('[data-action="click"]');
    if (button) {
      button.addEventListener('click', () => this._handleClick());
    }
  }

  _cleanupEventListeners() {
    // 清理逻辑（如果需要）
  }

  _handleClick() {
    // 派发事件，不处理业务逻辑
    if (window.IDFramework) {
      window.IDFramework.dispatch('myAction', {
        prop1: this.getAttribute('prop1'),
        prop2: this.getAttribute('prop2')
      }).catch(err => {
        console.error('Failed to dispatch event:', err);
      });
    }
  }

  // 工具方法：转义 HTML
  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// 自动注册组件
if (!customElements.get('id-my-component')) {
  customElements.define('id-my-component', IdMyComponent);
}
```

### 组件使用方式

#### 1. 静态引入（基础组件）

在 `index.html` 中直接引入：

```html
<script type="module" src="./idcomponents/id-connect-button.js"></script>

<body>
  <id-connect-button></id-connect-button>
</body>
```

#### 2. 动态加载（页面组件）

在路由命令中使用 `IDFramework.loadComponent()`：

```javascript
// commands/MapsCommand.js
async execute({ payload, stores, delegate }) {
  const route = payload.route;
  
  if (route === '/home') {
    // 动态加载组件
    await IDFramework.loadComponent('./idcomponents/id-home-page.js');
    stores.app.currentView = 'home';
  }
}
```

### 组件布局规范

#### Header 布局模式

当组件需要作为页面顶部固定 header 时，应遵循以下规范：

**1. 使用语义化 HTML 元素**

在组件内部使用 `<header>` 元素作为容器，而不是 `<div>`：

```javascript
render() {
  const template = `
    <header part="user-info" class="user-info">
      <div class="user-info-content">
        <!-- 内容 -->
      </div>
    </header>
  `;
}
```

**2. Header 固定定位样式**

Header 组件应使用固定定位，始终保持在页面右上角。**重要**：`header.user-info` 的高度必须等于 `container` 的 `margin-top` 值，以确保内容不重叠：

```css
header.user-info {
  display: block;
  position: fixed;
  top: 0;
  right: 0;
  z-index: 1000;
  padding: 8px;
  width: auto;
  min-width: fit-content;
  /* Height must match container margin-top value */
  height: var(--id-header-height, 64px);
  box-sizing: border-box;
}

.user-info-content {
  display: flex;
  align-items: center;
  gap: var(--id-spacing-sm, 0.5rem);
  padding: 5px 10px;
  border-radius: var(--id-radius-button, 0.5rem);
  background-color: var(--id-bg-body, #fff);
}
```

**在 `app.css` 中定义 CSS 变量**：

```css
:root {
  /* ... 其他变量 ... */
  --id-header-height: 64px; /* Header height, used for container margin-top */
}
```

**3. Host 元素样式调整**

`:host` 元素应设置为 `display: block` 和 `position: static`，让内部的 header 元素负责定位：

```css
:host {
  display: block;
  position: static;
}
```

**4. 页面容器布局**

在 `index.html` 中，主容器（container）需要添加 `margin-top`，其值必须等于 `header.user-info` 的高度，以避免与固定 header 重叠：

```html
<div class="connect-button-wrapper">
  <id-connect-button></id-connect-button>
</div>

<div class="container" style="margin-top: var(--id-header-height, 64px);">
  <!-- 页面内容 -->
</div>
```

**关键规则**：
- `header.user-info` 的 `height` 值 = `container` 的 `margin-top` 值
- 两者都应使用相同的 CSS 变量 `--id-header-height` 来保持同步
- 在 `app.css` 中定义 `--id-header-height` 变量，确保全局一致性

**5. 事件绑定注意事项**

由于 header 是块级元素，内部交互元素应使用 `.user-info-content` 类进行事件绑定：

```javascript
_setupEventListeners() {
  const userInfoEl = this.shadowRoot.querySelector('.user-info-content');
  if (userInfoEl) {
    userInfoEl.addEventListener('click', (e) => this.handleUserInfoClick(e));
  }
}
```

**完整示例：id-connect-button.js**

```javascript
render() {
  const template = `
    <header part="user-info" class="user-info">
      <div class="user-info-content">
        <img class="avatar" src="${avatarUrl}" />
        <div class="user-info-text">
          <span class="name">${name}</span>
          <span class="metaid">MetaID:${metaid}</span>
        </div>
        <!-- 下拉菜单 -->
      </div>
    </header>
  `;
}
```

**样式示例：**

```css
:host {
  display: block;
  position: static;
}

header.user-info {
  display: block;
  position: fixed;
  top: 0;
  right: 0;
  z-index: 1000;
  padding: 8px;
}

.user-info-content {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 5px 10px;
  background-color: var(--id-bg-body, #fff);
  border-radius: var(--id-radius-button, 0.5rem);
}
```

---

### 组件与 Model 交互

#### 方式 1：通过属性传递（推荐用于简单数据）

```html
<id-buzz-card 
  content="Hello World" 
  author="user123" 
  txid="abc123"
></id-buzz-card>
```

#### 方式 2：在组件内部访问 Alpine Store（用于复杂数据）

```javascript
// 在组件方法中
_getDataFromStore() {
  if (typeof Alpine === 'undefined') return null;
  const store = Alpine.store('buzz');
  return store.list || [];
}

render() {
  const data = this._getDataFromStore();
  // 使用 data 渲染
}
```

#### 方式 3：使用 Alpine.js 模板绑定（在 index.html 中）

```html
<div x-data>
  <template x-for="item in $store.buzz.list">
    <id-buzz-card 
      :content="item.content"
      :author="item.author"
      :txid="item.txid"
    ></id-buzz-card>
  </template>
</div>
```

---

## 命令开发规范

### 命令职责

`/commands/` 目录下的命令是**业务逻辑层**，职责是：

1. **执行业务逻辑**：处理具体的业务操作
2. **调用服务**：通过 Delegate 获取远程数据
3. **数据转换**：使用 DataAdapter 转换数据格式
4. **更新 Model**：直接修改 Alpine stores 的状态

### 命令命名规范

- 文件名使用 PascalCase（如 `FetchUserCommand.js`）
- 类名与文件名一致（如 `FetchUserCommand`）
- 使用描述性名称，清楚表达命令的用途

### 命令模板

```javascript
/**
 * FetchUserCommand - 获取用户信息的业务逻辑
 * 
 * Command Pattern 实现，遵循 IDFramework 架构
 * 
 * 此命令：
 * 1. 使用 UserDelegate 获取用户数据（带 IndexedDB 缓存）
 * 2. 更新 Model（user store）中的用户信息
 * 
 * @class FetchUserCommand
 */
export default class FetchUserCommand {
  /**
   * 执行命令
   * 
   * 命令执行流程：
   * 1. 从 payload 中提取参数
   * 2. 调用 UserDelegate 获取用户数据（先检查 IndexedDB，然后 API）
   * 3. 更新 Model（user store）中的用户信息
   * 
   * @param {Object} params - 命令参数
   * @param {Object} params.payload - 事件载荷
   *   - metaid: {string} - 要获取用户信息的 MetaID
   * @param {Object} params.stores - Alpine stores 对象
   *   - user: {Object} - User store (user, isLoading, error)
   *   - wallet: {Object} - Wallet store (可选)
   *   - app: {Object} - App store (可选)
   * @param {Function} params.delegate - BusinessDelegate 函数（来自 IDFramework.Delegate.BusinessDelegate）
   * @param {Function} params.userDelegate - UserDelegate 函数（来自 IDFramework.Delegate.UserDelegate）
   * @returns {Promise<void>}
   */
  async execute({ payload = {}, stores, delegate, userDelegate }) {
    const userStore = stores.user;
    if (!userStore) {
      console.error('FetchUserCommand: User store not found');
      return;
    }

    const { metaid } = payload;
    if (!metaid) {
      console.error('FetchUserCommand: metaid is required');
      userStore.error = 'MetaID is required';
      return;
    }

    // 检查是否已存在相同 metaid 的用户
    if (userStore.user && userStore.user.metaid === metaid) {
      return; // 已存在，不需要重新获取
    }

    // 设置加载状态
    userStore.isLoading = true;
    userStore.error = null;

    try {
      // 使用 UserDelegate 获取用户数据（带 IndexedDB 缓存）
      if (!userDelegate) {
        throw new Error('UserDelegate is not available');
      }
      
      const userData = await userDelegate('metafs', `/info/metaid/${metaid}`, {
        metaid: metaid,
      });

      // 更新 Model：存储用户数据
      userStore.user = userData;
      userStore.isLoading = false;
      userStore.error = null;
    
    } catch (error) {
      console.error('FetchUserCommand error:', error);
      userStore.error = error.message || 'Failed to fetch user information';
      userStore.isLoading = false;
    }
  }
}
```

### 命令注册

在 `app.js` 的 `DOMContentLoaded` 事件中注册：

```javascript
window.addEventListener('DOMContentLoaded', async () => {
  // ... 其他初始化代码 ...
  
  // 注册命令（使用相对路径）
  IDFramework.IDController.register('fetchUser', './commands/FetchUserCommand.js');
  IDFramework.IDController.register('postBuzz', './commands/PostBuzzCommand.js');
});
```

### 命令返回值

**重要**：命令的 `execute` 方法可以返回任何值，该返回值会通过 `IDFramework.dispatch()` 传递给调用者。

**返回值示例**：

```javascript
export default class GameScoresCommand {
  async execute({ payload = {}, stores, delegate }) {
    try {
      // ... 业务逻辑 ...
      
      // 调用 createPin 并返回结果
      const pinResult = await IDFramework.BuiltInCommands.createPin({
        payload: {
          operation: 'create',
          body: JSON.stringify(body),
          path: '/protocols/gamescorerecording',
          contentType: 'application/json'
        },
        stores: stores
      });
      
      // 返回结果，调用者可以通过 dispatch 获取
      return pinResult;
    } catch (error) {
      console.error('GameScoresCommand error:', error);
      throw error;
    }
  }
}
```

**在调用处使用返回值**：

```javascript
// 在组件或页面中
async recordScore() {
  try {
    // dispatch 会返回命令 execute 方法的返回值
    const pinRes = await window.IDFramework.dispatch('gameScores', {
      metaAppPinId: 'xxx',
      score: 100,
      gameName: 'ThunderGame',
      metaData: {
        level: 1,
        weaponLevel: 2,
        enemiesKilled: 50
      }
    });
    
    // 使用返回值
    if (pinRes?.txids?.length) {
      alert(`分数已成功上链！Txid: ${pinRes.txids[0]}`);
    }
  } catch (error) {
    console.error('Failed to record score:', error);
    alert('上链失败: ' + (error.message || error));
  }
}
```

**返回值规则**：
- 如果命令返回了值，`dispatch` 会将该值传递给调用者
- 如果命令没有返回值（或返回 `undefined`），`dispatch` 会返回 `undefined`
- 如果命令抛出异常，`dispatch` 会抛出异常，调用者需要使用 `try-catch` 处理

**常见问题：命令返回值丢失**

**问题描述**：
当命令的 `execute` 方法返回了值，但调用 `IDFramework.dispatch()` 时却得到 `undefined`。

**原因分析**：
这个问题通常是因为 `idframework.js` 中的 `IDController.execute` 和 `IDFramework.dispatch` 方法没有正确返回命令的执行结果。

**修复方法**：

1. **检查 `IDController.execute` 方法**：
   - 对于内置命令（built-in commands），需要捕获返回值并返回：
   ```javascript
   const result = await builtInCommand({
     payload,
     stores,
     delegate: IDFramework.Delegate.BusinessDelegate.bind(IDFramework.Delegate),
     userDelegate: IDFramework.Delegate.UserDelegate.bind(IDFramework.Delegate),
   });
   return result; // 必须返回结果
   ```
   
   - 对于文件命令（file-based commands），也需要捕获返回值并返回：
   ```javascript
   const result = await command.execute({
     payload,
     stores,
     delegate: IDFramework.Delegate.BusinessDelegate.bind(IDFramework.Delegate),
     userDelegate: IDFramework.Delegate.UserDelegate.bind(IDFramework.Delegate),
   });
   return result; // 必须返回结果
   ```

2. **检查 `IDFramework.dispatch` 方法**：
   - 需要返回 `IDController.execute` 的结果：
   ```javascript
   static async dispatch(eventName, payload = {}, storeName = null) {
     // ... 解析 stores ...
     return await this.IDController.execute(eventName, payload, stores); // 必须返回结果
   }
   ```

**验证修复**：
修复后，命令的返回值应该能够正确传递：
```javascript
// 在组件中调用
const response = await window.IDFramework.dispatch('getPinListByPath', {
  path: '/protocols/gamescorerecording',
  cursor: 0,
  size: 100
});
console.log(response); // 应该能正确输出命令返回的数据
```

---

#### 方式 1：在组件中调用（推荐）

```javascript
// 在组件方法中
async handleAction() {
  // dispatch 返回命令的返回值
  const result = await window.IDFramework.dispatch('fetchUser', { 
    metaid: 'xxx' 
  });
  // 使用返回值
  if (result) {
    console.log('User fetched:', result);
  }
}
```

#### 方式 2：在命令中调用其他命令

```javascript
// 在另一个命令中
async execute({ payload, stores, delegate }) {
  // 调用其他命令并获取返回值
  const result = await IDFramework.dispatch('fetchUser', { metaid: 'xxx' });
  // 使用返回值
  if (result) {
    // 处理结果
  }
}
```

#### 方式 3：在 app.js 启动时调用

```javascript
window.addEventListener('DOMContentLoaded', async () => {
  // ... 注册命令 ...
  
  // 启动时自动获取数据
  const result = await IDFramework.dispatch('fetchBuzz', { cursor: 0, size: 30 });
  // 使用返回值
  if (result) {
    console.log('Buzz list:', result);
  }
});
```

### 使用内置命令

#### connectWallet

```javascript
// 连接钱包
await IDFramework.dispatch('connectWallet');
```

#### createPin

```javascript
// 创建 PIN（上链）
const pinRes = await IDFramework.BuiltInCommands.createPin({
  payload: {
    operation: 'create',
    body: {
      content: 'Hello MetaID',
      // ... 其他字段
    },
    path: '/protocols/simplebuzz',
    contentType: 'application/json'
  },
  stores: {
    wallet: Alpine.store('wallet'),
    app: Alpine.store('app'),
    user: Alpine.store('user')
  }
});
```

---

## AI 开发工作流

### 1. 理解用户需求

当用户提出需求时，AI 需要：

1. **识别功能类型**：
   - 是否需要新组件？（视图层）
   - 是否需要新命令？（业务逻辑层）
   - 是否需要新 Model？（数据层）
   - 是否需要新服务？（ServiceLocator）

2. **分析数据流**：
   - 数据从哪里来？（API、用户输入、其他 Model）
   - 数据如何转换？（DataAdapter）
   - 数据存储在哪里？（哪个 Model）
   - 数据如何展示？（哪个组件）

### 2. 生成代码步骤

#### 步骤 1：更新 app.js

如果需要新 Model：
```javascript
// 在 app.js 中添加
const NewModel = {
  data: [],
  isLoading: false,
  error: null
};

// 在 IDFramework.init() 中注册
IDFramework.init({
  // ... 现有 models
  newModel: NewModel
});
```

如果需要新服务：
```javascript
// 在 app.js 的 ServiceLocator 中添加
window.ServiceLocator = {
  // ... 现有服务
  newService: 'https://api.example.com'
};
```

如果需要新命令：
```javascript
// 在 app.js 的 DOMContentLoaded 中注册
IDFramework.IDController.register('newCommand', './commands/NewCommand.js');
```

#### 步骤 2：创建命令文件（如果需要）

在 `/commands/` 目录创建命令文件，遵循命令模板。

#### 步骤 3：创建组件文件（如果需要）

在 `/idcomponents/` 目录创建组件文件，遵循组件模板。

#### 步骤 4：更新 index.html

如果需要静态引入组件：
```html
<script type="module" src="./idcomponents/id-new-component.js"></script>
```

如果需要使用组件：
```html
<id-new-component prop1="value1" prop2="value2"></id-new-component>
```

### 3. 代码生成检查清单

生成代码后，AI 需要检查：

- [ ] 所有路径使用相对路径（`./` 开头）
- [ ] `index.html` 中正确引入了 `idconfig.js`、`idutils.js`、`idframework.js`、`app.js`
- [ ] 若业务使用 `mvc` / `TxComposer`，已按需引入 `metaid.js`
- [ ] `app.js` 中注册了所有自定义命令
- [ ] 组件文件名以 `id-` 开头
- [ ] 组件使用 Shadow DOM 和 CSS Variables
- [ ] 命令使用 `export default class` 导出
- [ ] 命令在 `app.js` 中正确注册
- [ ] Model 在 `IDFramework.init()` 中注册
- [ ] ServiceLocator 中定义了所需服务

---

## 常见场景示例

### 场景 1：创建新的数据展示组件

**需求**：创建一个显示用户列表的组件

**步骤**：

1. **创建组件** `idcomponents/id-user-list.js`：
```javascript
class IdUserList extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
    this._watchStore();
  }

  _watchStore() {
    // 监听 store 变化
    setInterval(() => {
      const store = Alpine.store('user');
      if (store && store.list) {
        this.render();
      }
    }, 300);
  }

  render() {
    const store = Alpine.store('user');
    const users = store?.list || [];
    
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .user-item {
          padding: var(--id-spacing-md, 1rem);
          border-bottom: 1px solid var(--id-border-color, #e5e7eb);
        }
      </style>
      <div>
        ${users.map(user => `
          <div class="user-item">
            <h3>${this.escapeHtml(user.name)}</h3>
            <p>${this.escapeHtml(user.metaid)}</p>
          </div>
        `).join('')}
      </div>
    `;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

customElements.define('id-user-list', IdUserList);
```

2. **在 index.html 中引入**：
```html
<script type="module" src="./idcomponents/id-user-list.js"></script>
<body>
  <id-user-list></id-user-list>
</body>
```

### 场景 2：创建新的数据获取命令

**需求**：创建一个获取用户列表的命令

**步骤**：

1. **创建命令** `commands/FetchUserListCommand.js`：
```javascript
export default class FetchUserListCommand {
  async execute({ payload = {}, stores, delegate }) {
    const userStore = stores.user;
    if (!userStore) {
      console.error('FetchUserListCommand: User store not found');
      return;
    }

    userStore.isLoading = true;
    userStore.error = null;

    try {
      const rawData = await delegate('metaid_man', '/users/list', {
        method: 'GET'
      });

      // 数据转换
      const userList = this.dataAdapter(rawData);
      
      // 更新 Model
      userStore.list = userList;
      userStore.isLoading = false;
    } catch (error) {
      console.error('FetchUserListCommand error:', error);
      userStore.error = error.message;
      userStore.isLoading = false;
    }
  }

  dataAdapter(rawData) {
    if (!rawData || !rawData.data) return [];
    return rawData.data.map(item => ({
      name: item.name,
      metaid: item.metaid,
      address: item.address
    }));
  }
}
```

2. **在 app.js 中注册**：
```javascript
IDFramework.IDController.register('fetchUserList', './commands/FetchUserListCommand.js');
```

3. **在组件或启动时调用**：
```javascript
await IDFramework.dispatch('fetchUserList');
```

### 场景 3：创建带路由的新页面

**需求**：创建一个用户详情页面，通过路由访问

**步骤**：

1. **创建页面组件** `idcomponents/id-user-detail-page.js`：
```javascript
class IdUserDetailPage extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
    this._loadUserData();
  }

  _loadUserData() {
    const appStore = Alpine.store('app');
    const userId = appStore.routeParams?.id;
    
    if (userId && window.IDFramework) {
      window.IDFramework.dispatch('fetchUser', { metaid: userId });
    }
  }

  render() {
    const appStore = Alpine.store('app');
    const userStore = Alpine.store('user');
    const userId = appStore.routeParams?.id || '';
    const user = userStore?.user || {};
    
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; padding: var(--id-spacing-lg, 1.5rem); }
        .page-title { font-size: 2rem; margin-bottom: var(--id-spacing-md, 1rem); }
      </style>
      <div>
        <h1 class="page-title">User Detail</h1>
        <p>User ID: ${this.escapeHtml(userId)}</p>
        <p>Name: ${this.escapeHtml(user.name || 'Loading...')}</p>
      </div>
    `;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

customElements.define('id-user-detail-page', IdUserDetailPage);
```

2. **在路由命令中加载组件**（假设有 `MapsCommand.js`）：
```javascript
async execute({ payload, stores, delegate }) {
  const route = payload.route;
  
  if (route.startsWith('/user/')) {
    const userId = route.split('/user/')[1];
    stores.app.routeParams = { id: userId };
    
    await IDFramework.loadComponent('./idcomponents/id-user-detail-page.js');
    stores.app.currentView = 'user-detail-page';
  }
}
```

3. **在 index.html 中添加模板**：
```html
<template x-if="$store.app.currentView === 'user-detail-page'">
  <id-user-detail-page></id-user-detail-page>
</template>
```

---

## 总结

### 核心原则

1. **单一数据源**：所有状态在 Model 层（Alpine stores）
2. **关注点分离**：View 只展示，Command 只处理业务逻辑
3. **事件驱动**：组件通过事件通信，不直接调用
4. **按需加载**：组件和命令支持动态导入

### AI 开发要点

1. **理解架构**：清楚 MVC 各层的职责
2. **遵循规范**：命名、路径、结构都要符合规范
3. **使用相对路径**：所有路径必须使用 `./` 开头
4. **正确注册**：命令必须在 `app.js` 中注册
5. **组件隔离**：使用 Shadow DOM 和 CSS Variables

### 文件生成顺序

1. 先更新 `app.js`（Model、ServiceLocator、命令注册）
2. 再创建命令文件（如果需要）
3. 然后创建组件文件（如果需要）
4. 最后更新 `index.html`（引入组件、使用组件）

---

**本文档持续更新中，如有疑问请参考项目示例代码。**
