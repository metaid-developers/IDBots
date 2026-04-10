# IDBots 元应用一级栏目设计文档

**日期**: 2026-03-27  
**项目**: IDBots  
**状态**: 设计已确认，待实现

---

## 1. 背景

当前 IDBots 已经具备本地 MetaApp 的底层能力：

- 仓库根目录存在 `METAAPPs/`，当前内置 `buzz` 和 `chat` 两个符合规范的 MetaApp
- 主进程已存在 `MetaAppManager`，能够从 `APP.md` frontmatter 解析 MetaApp 元数据
- 主进程已存在本地静态服务与 `openMetaApp` / `resolveMetaAppUrl` 能力
- Cowork / Quick Actions 已经有“打开本地元应用”的产品语义

但前端目前没有一个独立的一级栏目来展示和使用 MetaApp，导致：

- 用户无法像查看技能一样集中查看本地 MetaApp
- MetaApp 的“打开”与“带着应用上下文开始协作”没有统一入口
- 已有的 MetaApp 能力只在局部流程里可见，不形成稳定的信息架构

本次工作只做 UI 和展示接线，不扩展 MetaApp 安装、更新、远程推荐拉取等管理能力。

---

## 2. 目标与范围

### 2.1 目标

新增一个一级栏目 `元应用`：

- 左侧导航新增入口，位置在 `技能` 前面
- 页面布局整体对标 `技能` 栏目
- 展示所有本地 MetaApp
- 每个 MetaApp 卡片提供两个动作：
  - `使用该应用`
  - `打开`
- 页面预留 `本地 / 推荐` 双 tab，其中 `推荐` 先做空状态

### 2.2 本次范围

本次只包含：

- 新增 `元应用` 顶级导航入口与独立页面
- 复用现有 `METAAPPs/*/APP.md` 数据构建本地列表
- 接通 renderer 到 main 的 MetaApp IPC
- 实现本地列表展示、搜索、空状态、错误提示
- 实现 `打开` 与 `使用该应用` 两个动作

### 2.3 明确不做

本次不包含：

- MetaApp 下载、安装、删除、升级
- 推荐 MetaApp 的真实远程数据源
- MetaApp 分类、排序、筛选系统
- MetaApp 权限系统
- MetaApp 设置页或详情页
- 修改现有 `METAAPPs` 目录规范

---

## 3. 信息架构

### 3.1 左侧导航

左侧导航顺序调整为：

1. 定时任务
2. 服务广场
3. 元应用
4. 技能
5. MetaBots

这样做的原因：

- 用户要求 `元应用` 位于 `技能` 之前
- MetaApp 是产品级对象，不应继续隐藏在技能语境下
- 与 Quick Actions 中“打开本地元应用”的语义保持一致

### 3.2 页面结构

`元应用` 页面的骨架与 `技能` 页面对齐：

- 同样的标题栏区域
- 同样的 sidebar 折叠/展开交互
- 同样的主内容宽度和上下间距
- 同样的卡片网格布局

新页面由以下两个组件组成：

- `MetaAppsView`
  - 负责页面标题栏和整体容器
- `MetaAppsManager`
  - 负责 tab、搜索、列表、空状态、错误提示和按钮交互

### 3.3 Tab 结构

顶部 tab 固定为：

- `本地`
- `推荐`

行为定义：

- 默认进入 `本地`
- `本地` tab 展示从本地 `METAAPPs/` 解析出的应用
- `推荐` tab 先只显示空状态，占位未来扩展

`推荐` 的文案不使用“官方推荐”，只使用“推荐”。

---

## 4. 交互设计

### 4.1 本地列表

本地列表展示内容：

- 应用名称 `name`
- 应用简介 `description`
- 官方标识（如 `official: true`）
- 版本号 `version`

搜索行为：

- 搜索范围只覆盖 `name + description`
- 与技能页保持一致的轻量搜索，不引入复杂过滤器

### 4.2 卡片样式

采用“方案 A”：

- 最大限度复用技能页现有视觉结构
- 维持双列卡片网格
- 卡片头部展示应用 icon 占位 + 名称
- 卡片正文展示简介，必要时两行截断
- 卡片底部左侧展示 badge / 版本元信息
- 卡片底部右侧展示动作按钮

卡片不展示：

- 入口文件完整路径
- APP.md 绝对路径
- 来源类型原始枚举值

原因：

- 本次目标是“看得懂、能使用”，不是做调试面板
- 过多路径信息会破坏与技能页的一致性

### 4.3 两个动作的语义

#### 打开

`打开` 的语义是：

- 直接打开该 MetaApp
- 调用现有主进程 MetaApp 打开能力
- 这是立即执行动作，不进入对话流

#### 使用该应用

`使用该应用` 的语义是：

- 创建一个新的 Cowork 会话
- 自动带入一条与该 MetaApp 对应的 prompt
- 让 AI 按现有 MetaApp 路由逻辑理解用户意图，必要时打开该应用

推荐的默认 prompt 方向：

> 请帮我使用本地元应用 {MetaAppName}。如果需要，请直接打开它，并基于这个应用继续协助我完成任务。

这样可以和 `打开` 区分开：

- `打开`：直接启动应用
- `使用该应用`：把这个应用纳入 AI 协作流程

---

## 5. 数据与接口设计

### 5.1 数据来源

本地 MetaApp 列表直接复用主进程现有 `MetaAppManager.listMetaApps()`。

该数据已经能够提供：

- `id`
- `name`
- `description`
- `isOfficial`
- `updatedAt`
- `entry`
- `appPath`
- `appRoot`
- `version`
- `creatorMetaId`
- `sourceType`

### 5.2 Renderer 服务

扩展现有 `src/renderer/services/metaApp.ts`，形成完整 `metaAppService`，提供：

- `listMetaApps()`
- `openMetaApp(appId, targetPath?)`
- `resolveMetaAppUrl(appId, targetPath?)`
- `onMetaAppsChanged(callback)`
- 保留已有 `getAutoRoutingPrompt()`

### 5.3 Preload / IPC / 类型定义

需要补齐以下链路：

- `src/main/preload.ts`
- `src/renderer/types/electron.d.ts`
- `src/main/main.ts`

建议新增的 renderer 可见 API：

- `window.electron.metaapps.list()`
- `window.electron.metaapps.open(input)`
- `window.electron.metaapps.resolveUrl(input)`
- `window.electron.metaapps.onChanged(callback)`
- 保留 `window.electron.metaapps.autoRoutingPrompt()`

### 5.4 列表刷新

主进程 `MetaAppManager` 已经会发送 `metaapps:changed` 事件。

本次前端应复用该事件：

- 首次进入页面时加载一次列表
- 当 `metaapps:changed` 到来时自动刷新列表

这样可保证：

- 用户目录下的 `METAAPPs` 有变化时，页面能同步更新
- 行为与技能页的 `skills:changed` 一致

---

## 6. 推荐 Tab 设计

`推荐` tab 本次不接真实数据源。

展示空状态：

- 标题：`推荐元应用即将开放`
- 文案：`这里将展示推荐安装的 MetaApp。当前版本先支持本地已安装元应用。`

设计原则：

- 这是“预留壳子”，不是报错
- 不渲染伪造推荐卡片
- 不使用“官方推荐”命名

---

## 7. 错误处理

### 7.1 列表加载失败

当 `listMetaApps()` 失败时：

- 在 `本地` tab 内显示页内错误提示
- 使用现有 `ErrorMessage` 风格，避免新增新的错误样式体系

### 7.2 打开失败

当 `打开` 动作失败时：

- 显示操作级错误提示
- 保持当前页面上下文，不跳转

### 7.3 使用失败

当 `使用该应用` 动作失败时：

- 如果是 MetaApp prompt / cowork 启动失败，显示操作级错误提示
- 不清空当前列表状态
- 不自动切换到 Cowork

### 7.4 空状态

本地列表为空时，显示：

- `暂无本地元应用`
- 说明当前版本会从本地 `METAAPPs/` 目录读取应用

空状态和错误状态要区分：

- 空状态表示“当前没有数据”
- 错误状态表示“加载数据失败”

---

## 8. 测试与验证

### 8.1 实现策略

遵循先测后写的原则：

- 先补最小必要测试
- 再实现 renderer / IPC / 视图逻辑

### 8.2 建议测试范围

#### 纯逻辑 / 服务层

- `metaAppService` 能正确调用：
  - `list`
  - `open`
  - `resolveUrl`
  - `onChanged`

#### 页面状态与显示

- `MetaAppsManager` 的本地过滤逻辑
- `推荐` tab 空状态文案
- 本地空状态与错误状态区分

#### 导航接线

- `Sidebar` 可切到 `metaapps`
- `App.tsx` 能正确渲染 `MetaAppsView`

### 8.3 回归验证

实现完成后至少执行：

```bash
npm run compile:electron
node --test tests/metaAppLocalServer.test.mjs tests/metaAppCoworkPrompt.test.mjs tests/quickActionPresentation.test.mjs
```

如果新增了专门测试，再额外运行对应测试文件。

---

## 9. 实施摘要

本次实现的最小闭环是：

1. 新增左侧一级导航 `元应用`
2. 新增 `MetaAppsView` / `MetaAppsManager`
3. 补全 MetaApp renderer service + preload + IPC
4. 从本地 `METAAPPs/*/APP.md` 加载列表
5. 本地 tab 展示卡片网格
6. 推荐 tab 展示空状态
7. 实现 `使用该应用` / `打开`
8. 完成最小测试与编译验证

该方案控制了范围，最大限度复用现有技能页与 MetaApp 主进程能力，适合本次“先做好 UI 和展示”的目标。
