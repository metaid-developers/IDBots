# Baoyu Image Studio 技能设计文档

**日期**: 2026-03-24
**项目**: IDBots
**状态**: 设计已确认，待进入实现计划

---

## 1. 背景与目标

### 1.1 背景

IDBots 已经具备目录式 `SKILLs/` 能力，可以将内置技能加入默认路由与默认启用清单中。此前内置的 `superpowers-*` 更偏工程流程类技能，主要依赖 `SKILL.md` 提示与少量脚本。

`baoyu-skills` 与其不同。它包含一组面向内容生产的技能，其中“生成图片”相关能力具备较高业务价值，但整包直接引入存在以下问题：

- 上游技能数量较多，用户侧入口分散
- 多个技能依赖 `bun`、脚本运行时与外部图像 provider
- 发布类技能带有 Web2 平台、登录态、浏览器自动化等额外复杂度
- IDBots 当前目标只需要本地生成图片文件，后续主要用于链上发送，不需要 Web2 发布链路

因此，本次设计不以“原样搬运上游整包技能”为目标，而是抽取其中最适合 IDBots 的“做图能力”，封装为一个 IDBots 原生内置技能。

### 1.2 目标

新增一个独立内置技能 `baoyu-image-studio`，用于在 IDBots 中统一承接图片生成需求。

它需要满足以下目标：

- 对用户只暴露一个做图技能入口
- 支持多种图片场景，而不是只提供底层文生图命令
- 输出稳定的本地图片文件，便于后续上链使用
- 尽量复用 IDBots 现有 provider 配置，不新增设置页
- 一次性支持 7 家图片 provider 的代码路径
- 避免把 `baoyu-skills` 的 Web2 发布、浏览器自动化、登录态等复杂链路带入 IDBots

### 1.3 非目标

第一版明确不做以下内容：

- 微信公众号、X、微博、小红书等 Web2 发布
- 浏览器/CDP/登录态能力
- 自动将图片上链
- 新增 IDBots 全局设置页或 provider UI
- 复杂多页信息图工作流
- 复杂漫画 PDF 合集工作流
- 整包 vendoring `baoyu-skills`

---

## 2. 总体方案

### 2.1 方案选择

可选路线有三种：

1. 原样搬运上游多个图片技能
2. 只引入底层 `baoyu-image-gen`
3. 做一个 IDBots 原生聚合技能 `baoyu-image-studio`

本设计选择方案 3。

### 2.2 选择理由

方案 3 最符合 IDBots 当前产品目标与技能机制：

- 用户体验最好：用户只需要记住一个技能名
- 自动路由更稳定：做图相关请求统一命中同一技能
- 实现边界清晰：内部可吸收上游 provider 抽象与模板思路，外部保持 IDBots 原生体验
- 后续演进平滑：封面图、信息图、漫画等能力都在同一技能内扩展

---

## 3. 技能边界

### 3.1 技能名称

新增独立技能目录：

`SKILLs/baoyu-image-studio/`

技能 ID：

`baoyu-image-studio`

### 3.2 技能职责

`baoyu-image-studio` 只负责三件事：

- 根据用户意图识别图片工作模式
- 组织 prompt、风格、尺寸、文件名等生成参数
- 调用底层图片 provider，生成本地图片文件并返回路径

### 3.3 工作模式

第一版支持 4 种模式：

- `generate`
  - 通用文生图
  - 参考图改图
  - 风格化图片生成
- `cover`
  - 文章封面
  - 海报
  - 头图
- `infographic`
  - 知识卡片
  - 信息图
  - 图文卡片
- `comic`
  - 漫画风配图
  - 解释型分镜
  - 轻量故事图

### 3.4 模式范围收敛

为保证第一版成功率，两个模式需要刻意收敛：

- `infographic` 第一版只做单张图卡，不做多页轮播
- `comic` 第一版只做单张漫画风图，或最多 2 到 4 张轻量分镜，不做 PDF 合集

---

## 4. Provider 与凭证策略

### 4.1 基本原则

本技能不新增设置页，不要求用户维护单独的图片 provider UI。

技能应优先复用 IDBots 已有的 provider 凭证配置，仅在无法复用时回退到环境变量。

### 4.2 Provider 支持范围

第一版代码路径一次性支持以下 7 家 provider：

- `openai`
- `google`
- `openrouter`
- `dashscope`
- `replicate`
- `jimeng`
- `seedream`

### 4.3 与 MetaBot 的桥接关系

MetaBot 当前绑定的是 `llm_id`，在现有实现中它代表 provider key，而不是具体模型 ID。

因此本技能不直接复用当前文本模型 ID，而是先将当前 MetaBot 的 `llm_id` 视为“首选 provider”，再映射到图片 provider。

自动桥接映射如下：

- `openai -> openai`
- `gemini -> google`
- `openrouter -> openrouter`
- `qwen -> dashscope`

下列 provider 第一版不做自动图片桥接：

- `anthropic`
- `deepseek`
- `moonshot`
- `zhipu`
- `minimax`
- `xiaomi`
- `ollama`

这些 provider 如需使用图片技能，需依赖系统中其他已配置的可桥接 provider，或依赖环境变量兜底 provider。

### 4.4 凭证解析优先级

运行时 provider 与凭证解析顺序固定如下：

1. 优先尝试当前 MetaBot `llm_id` 对应的可桥接图片 provider
2. 若不可用，则扫描 IDBots 中已配置的可桥接 provider
3. 若仍不可用，则扫描纯环境变量 provider：
   - `replicate`
   - `jimeng`
   - `seedream`
4. 若仍无可用 provider，则失败并给出明确提示

可桥接 provider 的固定扫描顺序为：

- `openai`
- `gemini`
- `openrouter`
- `qwen`

完整 provider 自动回退顺序为：

- `openai`
- `gemini`
- `openrouter`
- `qwen`
- `replicate`
- `jimeng`
- `seedream`

### 4.5 baseUrl 策略

第一版默认不直接复用当前聊天 provider 的 `baseUrl`，原因是聊天接口与图片接口不一定兼容。

默认策略如下：

- `apiKey` 优先复用 IDBots 现有 provider 配置
- `baseUrl` 优先使用图片 provider 自身默认值
- 用户若需要覆盖，则通过环境变量指定

这比强行复用聊天接口 `baseUrl` 更稳妥。

---

## 5. 默认模型与环境变量

### 5.1 默认模型

为减少后续维护成本，第一版默认模型命名尽量与上游 `baoyu-image-gen` 保持一致：

- `openai`: `gpt-image-1.5`
- `google`: `gemini-3-pro-image-preview`
- `openrouter`: `google/gemini-3.1-flash-image-preview`
- `dashscope`: `qwen-image-2.0-pro`
- `replicate`: `google/nano-banana-pro`
- `jimeng`: `jimeng_t2i_v40`
- `seedream`: `doubao-seedream-5-0-260128`

### 5.2 环境变量命名

第一版尽量复用上游约定的环境变量名。

凭证类：

- `OPENAI_API_KEY`
- `GOOGLE_API_KEY`
- `GEMINI_API_KEY`
- `OPENROUTER_API_KEY`
- `DASHSCOPE_API_KEY`
- `REPLICATE_API_TOKEN`
- `JIMENG_ACCESS_KEY_ID`
- `JIMENG_SECRET_ACCESS_KEY`
- `ARK_API_KEY`

默认模型类：

- `OPENAI_IMAGE_MODEL`
- `GOOGLE_IMAGE_MODEL`
- `OPENROUTER_IMAGE_MODEL`
- `DASHSCOPE_IMAGE_MODEL`
- `REPLICATE_IMAGE_MODEL`
- `JIMENG_IMAGE_MODEL`
- `SEEDREAM_IMAGE_MODEL`

可选自定义 endpoint：

- `OPENAI_BASE_URL`
- `GOOGLE_BASE_URL`
- `OPENROUTER_BASE_URL`
- `DASHSCOPE_BASE_URL`
- `REPLICATE_BASE_URL`
- `JIMENG_BASE_URL`
- `SEEDREAM_BASE_URL`

### 5.3 技能级轻量覆盖

第一版允许提供一个轻量技能级配置入口，但不做 UI：

- `default_provider`
- `default_model`
- `default_quality`

实现形式可以是技能配置文件或 `EXTEND.md`。

若未配置，则完全走自动 provider 选择逻辑。

---

## 6. 用户交互设计

### 6.1 触发方式

技能支持两类触发方式：

- 用户显式指定：
  - 例如“使用 baoyu-image-studio 做一张封面图”
- 自动路由命中：
  - 当用户请求明显属于生成图片、头图、海报、信息图、漫画、配图等场景

### 6.2 交互原则

第一版遵循以下交互原则：

- 能自动判断模式时，不额外追问
- 信息不足时，最多补问 1 到 2 轮
- 不做长链路策划式问答
- 成功后必须明确返回本地图片路径

### 6.3 各模式最小输入与输出

#### generate

最小输入：

- 主题或目标画面
- 可选风格
- 可选参考图
- 可选比例

最小输出：

- 1 张本地图片文件
- 返回 provider、model、尺寸、输出路径摘要

#### cover

最小输入：

- 标题或主题
- 场景/风格方向
- 可选副标题
- 可选比例

最小输出：

- 1 张封面图文件

#### infographic

最小输入：

- 核心主题
- 3 到 7 个信息点
- 可选目标受众
- 可选视觉风格

最小输出：

- 1 张单页信息图或知识卡片

#### comic

最小输入：

- 主体主题
- 角色/场景描述
- 想表达的情绪或冲突
- 可选页数偏好

最小输出：

- 1 张漫画风图，或最多 2 到 4 张轻量分镜图

### 6.4 失败提示原则

失败提示必须可操作，而不是笼统报错。

至少需要说明：

- 当前 MetaBot 绑定的 provider 是什么
- 它是否可直接桥接到图片 provider
- 当前系统中有哪些已配置的可桥接 provider
- 若系统中无可桥接 provider，应提示可通过环境变量启用 `replicate`、`jimeng` 或 `seedream`

---

## 7. 仓库落地结构

### 7.1 新增目录

第一版新增一个独立技能目录，不整包 vendoring 上游仓库：

```text
SKILLs/baoyu-image-studio/
├── SKILL.md
├── scripts/
│   ├── index.js
│   ├── providerResolver.js
│   ├── promptBuilder.js
│   ├── outputPaths.js
│   └── providers/
│       ├── openai.js
│       ├── google.js
│       ├── openrouter.js
│       ├── dashscope.js
│       ├── replicate.js
│       ├── jimeng.js
│       └── seedream.js
├── templates/
│   ├── cover.md
│   ├── infographic.md
│   └── comic.md
└── EXTEND.example.md
```

### 7.2 各文件职责

- `SKILL.md`
  - 定义技能入口、模式分流、用户提示与执行流程
- `scripts/index.js`
  - 统一命令入口
  - 调用 provider 解析、prompt 构建、输出路径生成
- `scripts/providerResolver.js`
  - 实现 MetaBot provider 到图片 provider 的桥接逻辑
  - 处理 IDBots 配置与环境变量优先级
- `scripts/promptBuilder.js`
  - 构建 4 种模式对应的 prompt
- `scripts/outputPaths.js`
  - 统一输出路径、文件命名和扩展名处理
- `scripts/providers/*.js`
  - 封装各 provider 的实际 API 调用
- `templates/*.md`
  - 存放高层图片模式模板

### 7.3 运行时原则

第一版应尽量适配为 IDBots 当前更稳定的运行方式，不将 `bun` 作为对用户暴露的硬依赖。

实现层面应优先选择：

- 预编译 JavaScript 入口
- Node/Electron 兼容运行方式

而不是要求终端必须额外存在 `bun` 才能使用。

---

## 8. 测试与验收

### 8.1 单元测试

至少覆盖以下内容：

- MetaBot `llm_id` 到图片 provider 的桥接逻辑
- provider 自动选择顺序
- IDBots 配置与环境变量的优先级
- 默认模型选择逻辑
- 输出路径、文件扩展名与命名规则

### 8.2 集成测试

至少覆盖以下场景：

- IDBots 已配置 `openai/gemini/openrouter/qwen` 时，技能可直接复用凭证
- 可桥接 provider 均不可用时，环境变量 provider 能接管
- provider 不可用时，错误提示足够明确

### 8.3 人工验收

人工验收至少包含：

- 同一 MetaBot 触发 `generate`
- 同一 MetaBot 触发 `cover`
- 同一 MetaBot 触发 `infographic`
- 同一 MetaBot 触发 `comic`
- 每种模式都能生成本地图片文件并返回路径
- 全流程不要求改动 IDBots Settings UI
- 对不支持的 provider 有清晰替代建议

### 8.4 第一版验收标准

第一版验收通过的标准如下：

- 技能名统一为 `baoyu-image-studio`
- 四种模式都能触发
- 7 家 provider 在代码路径上被支持
- 至少 4 家桥接 provider 可直接复用 IDBots 已有凭证
- 输出稳定为本地图片文件
- 不引入新的设置页

---

## 9. 风险与后续演进

### 9.1 已知风险

- 不同 provider 在参考图、尺寸、输出格式上的能力差异较大
- 聊天 provider 的现有 `baseUrl` 未必能直接用于图片接口
- 某些 provider 的默认图片模型可能后续变更

### 9.2 风险缓解

- 使用统一 provider 适配层隔离能力差异
- 默认只复用 `apiKey`，不强复用聊天 `baseUrl`
- 通过环境变量保留高级覆盖能力
- 使用清晰错误提示引导用户切换 provider 或补充配置

### 9.3 后续演进方向

第一版完成后，可考虑逐步增加：

- 多页信息图工作流
- 更完整的漫画分镜工作流
- 输出目录与文件命名的高级配置
- 直接对接链上发送工作流，但应作为独立后续能力，不纳入本技能第一版职责

---

## 10. 结论

本设计选择将 `baoyu-skills` 中最有业务价值的做图能力抽象为一个 IDBots 原生技能 `baoyu-image-studio`。

它以单技能入口统一承接做图需求，支持 4 种图片模式与 7 家 provider 的代码路径，同时尽量复用 IDBots 已有 provider 凭证，不改动现有设置 UI，不引入 Web2 发布链路。

这条路线在“体验优先”和“工程可控”之间取得了较好的平衡，适合作为 IDBots 内置图片技能的第一版基线。
