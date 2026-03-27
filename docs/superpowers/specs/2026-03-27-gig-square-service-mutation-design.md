# Gig Square 服务撤销与修改设计文档

**日期**: 2026-03-27
**项目**: IDBots
**状态**: 已评审，待进入实现计划

---

## 1. 背景

Gig Square 已具备以下能力：

- 发布技能服务
- 浏览服务广场
- “我的服务”中查看自己已发布服务及订单明细

当前“我的服务”中的 `撤销` 与 `修改` 按钮仍为占位状态。下一步目标是让两者都能完整可用，并且与 MetaID 协议及 MAN 的索引语义保持一致。

本次设计覆盖：

- 链上 `modify` / `revoke` 规则接入
- 本地 SQLite 缓存层对服务版本链与可用状态的建模
- “我的服务”列表的按钮状态与创建 MetaBot 展示
- 修改表单、撤销确认、广播后刷新与失败提示

本次不覆盖：

- 重新上架已撤销服务
- 合并旧版本与新版本的统计
- 物理删除 SQLite 历史记录

---

## 2. 官方约定与约束

本设计依赖以下 MetaID 官方约定：

- Protocol Spec: [https://docs.metaid.io/metaid-specification/protocol-spec](https://docs.metaid.io/metaid-specification/protocol-spec)
- MetaID PIN Conventions: [https://docs.metaid.io/metaid-app-node/metaid-pin-conventions](https://docs.metaid.io/metaid-app-node/metaid-pin-conventions)
- PIN Data Structure: [https://docs.metaid.io/metaid-app-node/pin-data-structure](https://docs.metaid.io/metaid-app-node/pin-data-structure)

关键规则：

1. `modify` / `revoke` 使用 MetaID 七元组中的 `<operation>` 与 `<path>` 表达，其中：
   - `operation` 为 `modify` 或 `revoke`
   - `path` 必须写成 `@{pinId}`，指向目标 PIN
2. 发起 `modify` / `revoke` 的地址必须与目标旧版本 PIN 的创建地址一致，且目标 PIN 未被转移
3. 被修改/撤销的目标 PIN 必须是当前最新版本，否则该操作无效
4. 新操作 PIN 与目标 PIN 必须处于不同区块高度，否则无效

PIN `status` 约定：

- `0`: 正常可用
- `1`: 该 PIN 已被修改
- `-1`: 该 PIN 已被撤销
- `-101/-102/-201...`: 语义上无效的修改/撤销状态，表示目标不存在、区块高度无效、地址不匹配、目标不是最新版本等异常

这些状态必须被 IDBots 本地缓存层正确识别，不能仅靠前端展示层临时推断。

---

## 3. 用户确认的产品边界

### 3.1 服务身份口径

采用方案 A：

- 修改后把新的 modify PIN 当作新的当前服务 ID
- 旧版本服务不再在“我的服务”列表中单独展示
- 新旧版本统计不合并
- 修改后等价于“对外当前版本被替换为新 PIN”

### 3.2 操作阻塞口径

只要该服务存在任一卖家侧非终态订单，就禁止撤销与修改。

终态仅包括：

- `completed`
- `refunded`

其他状态统一视为非终态，包括但不限于：

- `awaiting_first_response`
- `in_progress`
- `refund_pending`
- `failed`

### 3.3 撤销后的行为

- 撤销后服务不再在“我的服务”列表中显示
- 撤销后不允许恢复
- 如需重新上架，用户必须重新发布新服务
- SQLite 中保留历史记录，但标记为不可用

### 3.4 修改后的行为

- 修改后新版本替换旧版本成为当前版本
- 原版本保留为历史记录
- 统计重新开始，不与旧版本聚合
- 修改后允许再次撤销

### 3.5 钱包与创建者约束

撤销和修改操作必须使用“目标 PIN 的创建 MetaBot”对应的钱包发起。

因此：

- “我的服务”列表必须展示“创建 MetaBot”
- 撤销/修改确认 UI 中必须明确提示将使用哪个 MetaBot 的钱包
- 后端必须校验：发起操作的 MetaBot 与目标当前版本服务 PIN 的创建者一致

---

## 4. 总体方案

采用方案 B：

- 保留链上原始 PIN 记录
- 在本地缓存中建立“服务版本链”与“当前服务视图”两层语义
- 前端和 IPC 不直接操作原始服务 pin 列表，而是面向“当前服务视图”

实现上仍以现有 `remote_skill_service` 表为核心，不新建复杂 revision 表，但会增加状态与链路字段，并新增一层集中归并逻辑。

高层结构：

1. **链上原始服务记录层**
   - 保存每条 `skill-service` PIN 的原始链上状态
2. **服务版本链归并层**
   - 根据 `status`、`operation`、`path` 识别 create / modify / revoke 关系
3. **当前服务视图层**
   - 只暴露“当前可见、可操作、属于本机 MetaBot”的服务
4. **修改/撤销执行层**
   - 统一做校验、发链、等待、同步、刷新

---

## 5. 数据模型设计

### 5.1 `remote_skill_service` 扩展字段

现有表需要补充以下字段：

- `pin_id TEXT`
- `status INTEGER NOT NULL DEFAULT 0`
- `operation TEXT`
- `path TEXT`
- `original_id TEXT`
- `create_address TEXT`
- `source_service_pin_id TEXT`
- `available INTEGER NOT NULL DEFAULT 1`

字段语义：

- `pin_id`
  当前记录对应的链上 PIN ID。为兼容现有实现，可与 `id` 保持同值，但后续查询统一语义上使用 `pin_id`
- `status`
  MAN 返回的链上状态码
- `operation`
  `create` / `modify` / `revoke`
- `path`
  原始链上 path。对于 modify/revoke，预期是 `@pinId`
- `original_id`
  MAN 返回的原始目标 PIN ID，若可用则优先使用
- `create_address`
  该 PIN 的创建地址，用于地址一致性审计与调试
- `source_service_pin_id`
  当前服务链的“源服务标识”
  - create 服务：等于自己
  - modify 服务：等于它指向的原始目标 PIN 或其服务链源 PIN
- `available`
  是否应该出现在当前服务视图中。该值不是链上原值，而是本地归并结果

### 5.2 兼容性与迁移

所有新字段必须通过 SQLite migration 安全添加，要求：

- 幂等
- 对已有用户数据库不丢数据
- 旧数据默认可被视为 `operation=create`、`status=0`

---

## 6. 服务版本链归并语义

新增集中逻辑层，建议命名为：

- `gigSquareServiceStateService`

职责：

- 识别每条服务 PIN 所属的版本链
- 判断某条服务是否是当前版本
- 判断某条服务链是否已撤销
- 生成前端所需的“当前服务视图”

### 6.1 版本链规则

#### create

- `operation=create`
- `path` 为 `/protocols/skill-service`
- 该记录创建一个新的服务链起点
- `source_service_pin_id = pin_id`

#### modify

- `operation=modify`
- `path=@targetPinId`
- 该记录不创建新服务链，而是加入目标服务链
- `source_service_pin_id` 应归并到目标服务链源 PIN
- modify PIN 自身在链上 `status=0` 时，表示它是一个正常记录；被它修改的目标记录在链上应为 `status=1`

#### revoke

- `operation=revoke`
- `path=@targetPinId`
- revoke 记录本身不作为服务列表项展示
- 只作为“服务链已终止”的状态事件参与归并

### 6.2 当前版本规则

一个服务链只有一条“当前版本”：

- 必须是该链上最新的、可用的、正常的服务内容记录
- 旧 create pin 与中间 modify 版本均不再作为当前项展示

如果该服务链最新状态已经对应 revoke，则：

- 整条服务链不再出现在“我的服务”列表
- 但历史记录保留在 SQLite

### 6.3 无效状态处理

以下记录不应作为当前服务显示：

- `status = 1`
- `status = -1`
- `status < 0` 的其他无效状态

处理方式：

- 保留原始记录供诊断与后续修复使用
- 标记 `available=0`
- 记录 warning 日志，便于后续与 MAN 接口联调

---

## 7. 我的服务视图模型

“我的服务”页不直接展示原始 `remote_skill_service`，而展示归并后的视图模型。

新增返回字段：

- `currentPinId`
- `sourceServicePinId`
- `creatorMetabotId`
- `creatorMetabotName`
- `creatorMetabotAvatar`
- `canModify`
- `canRevoke`
- `blockedReason`

字段说明：

- `currentPinId`
  当前版本的服务 PIN
- `sourceServicePinId`
  服务链源 PIN
- `creatorMetabot*`
  当前版本服务 PIN 的创建 MetaBot 信息，用于展示和钱包选择提示
- `canModify` / `canRevoke`
  后端已完成判断，前端不二次推导
- `blockedReason`
  稳定 key，不返回临时自然语言

建议阻塞 key：

- `gigSquareMyServicesBlockedActiveOrders`
- `gigSquareMyServicesBlockedNotCurrent`
- `gigSquareMyServicesBlockedRevoked`
- `gigSquareMyServicesBlockedMissingCreatorMetabot`

---

## 8. 撤销流程

### 8.1 前置校验

执行前必须满足：

1. 服务存在
2. 服务属于当前用户本机 MetaBot
3. 该服务是当前版本
4. 该服务链不存在非终态卖家订单
5. 服务未撤销
6. 创建该 PIN 的 MetaBot 仍存在且可用

### 8.2 链上请求

构造 MetaID PIN：

- `operation: 'revoke'`
- `path: '@<currentPinId>'`
- `payload: ''`
- `contentType: 'application/json'` 或现有 createPin 允许的空内容兼容写法

发起钱包：

- 必须使用 `creatorMetabotId` 对应钱包

### 8.3 成功后时序

1. 返回广播成功
2. UI 显示“已广播撤销，正在同步链上状态”
3. 等待约 3 秒
4. 触发本地优先服务同步
5. 重建当前服务视图
6. 如链上已同步为 `status=-1`，服务从列表消失
7. Toast 提示“服务已撤销”

### 8.4 广播后同步延迟

若广播成功但短时间未同步到：

- 不视为失败
- 提示“已广播，链上同步可能稍慢，请稍后刷新”
- 不对本地列表做乐观删除

---

## 9. 修改流程

### 9.1 修改面板

复用现有发布表单字段，模式改为 `modify`。

默认填入当前版本服务的值：

- `serviceName`
- `displayName`
- `description`
- `providerSkill`
- `price`
- `currency`
- `outputType`
- `serviceIcon`

顶部需展示：

- 当前服务名
- 当前 PIN
- 创建 MetaBot 名称
- 将使用哪个钱包发起
- 风险提示：
  - 修改后原版本不再展示
  - 统计将从新版本重新开始

### 9.2 提交前校验

1. 仍然是当前版本
2. 无非终态订单
3. 创建 MetaBot 可用
4. 至少有一项内容发生变更

若用户未改任何字段：

- 阻止提交
- 提示“未检测到变更”

### 9.3 链上请求

构造 MetaID PIN：

- `operation: 'modify'`
- `path: '@<currentPinId>'`
- `payload: <新的 skill-service JSON>`

发起钱包：

- 必须使用当前版本服务 PIN 的创建 MetaBot 钱包

### 9.4 成功后时序

1. 返回广播成功
2. UI 显示“已广播修改，正在同步链上状态”
3. 等待约 3 秒
4. 触发本地优先同步
5. 重建当前服务视图
6. 新 modify PIN 成为当前版本并出现在“我的服务”中
7. 旧版本从列表中消失
8. Toast 提示“服务已修改”

---

## 10. 按钮状态与 UI 设计

### 10.1 我的服务列表项

在现有信息之外新增：

- `创建 MetaBot：<name>`
- 可选显示紧凑头像

按钮状态不再使用 `Coming soon`，改为：

- 可点击
- 禁用但有明确原因

### 10.2 撤销按钮

点击后弹确认框，展示：

- 服务名
- 当前 PIN
- 创建 MetaBot
- 钱包提示
- 风险提示：撤销后不可恢复，只能重新发布

### 10.3 修改按钮

点击后打开修改面板，文案与发布面板区分：

- 标题：`修改技能服务`
- 提交按钮：`上链修改`

### 10.4 禁用原因

当按钮被禁用时，优先显示后端返回的 `blockedReason` 对应文案，例如：

- 有进行中的订单，暂不可操作
- 当前服务不是最新版本
- 创建该服务的 MetaBot 不可用

---

## 11. Main Process 结构建议

为避免继续把业务堆入 `main.ts`，建议新增以下服务模块：

### 11.1 `gigSquareServiceStateService`

职责：

- 服务链归并
- 当前版本判定
- 可用性判定
- 生成当前服务视图

### 11.2 `gigSquareServiceMutationService`

职责：

- 撤销/修改前置校验
- 构造 MetaID payload
- 调用 `createPin`
- 广播后等待与同步刷新

暴露方法建议：

- `revokeService({ servicePinId, actorMetabotId })`
- `modifyService({ servicePinId, actorMetabotId, nextPayload })`

### 11.3 IPC

新增：

- `gigSquare:revokeService`
- `gigSquare:modifyService`

返回结构统一：

- `success`
- `txids`
- `pinId`
- `warning`
- `error`
- `errorCode`

---

## 12. Renderer 结构建议

建议不要把“修改模式”硬塞进现有发布弹窗组件的大量条件分支中，而是拆出共享表单层：

- `GigSquareServiceForm`
- `GigSquareServiceMutationModal`

模式：

- `publish`
- `modify`

这样可以复用字段与校验，同时让“修改”保有独立的确认文案和风险提示。

---

## 13. SQLite 与同步策略

### 13.1 数据保存策略

- 不物理删除旧服务版本
- 不物理删除 revoke / invalid 记录
- 通过 `available` 与归并逻辑控制是否参与展示

### 13.2 刷新策略

“我的服务”页的以下动作触发同步：

- 打开面板
- 点击刷新
- 修改成功后等待 3 秒
- 撤销成功后等待 3 秒

保持现有本地优先架构：

- 先查本地 / MAN-P2P
- 语义缺失时再 fallback 远端 API
- 最终统一落库到 SQLite，前端仍然从本地缓存读取

---

## 14. 测试策略

### 14.1 同步与归并

- `gigSquareRemoteServiceSync`
  - 解析 `status`
  - 解析 `operation`
  - 解析 `path=@pinId`
  - 解析 `originalId`

- `gigSquareServiceStateService`
  - create -> modify，只显示最新版本
  - create -> modify -> modify，只显示最后一个 modify
  - create -> modify -> revoke，整条链隐藏
  - 无效状态记录不展示

### 14.2 修改/撤销执行

- `gigSquareServiceMutationService`
  - 有非终态订单时禁止操作
  - 不是创建 MetaBot 时禁止操作
  - revoke payload 构造正确
  - modify payload 构造正确
  - 广播成功后触发刷新

### 14.3 UI

- 我的服务列表展示创建 MetaBot
- 撤销按钮禁用原因正确
- 修改表单默认值正确
- 撤销确认文案正确
- 修改成功后替换为新版本服务

### 14.4 集成回归

- 与已有“我的服务明细”不冲突
- 与订单修复逻辑不冲突
- 修改/撤销后按钮状态更新正确

---

## 15. 风险与注意事项

1. **MAN 返回格式差异**
   如果远端或本地 P2P 返回未包含 `status` / `operation` / `originalId` 等字段，则需要先确认接口是否可补；本设计默认 MAN 语义完备

2. **同块修改无效**
   由于 MetaID 要求目标 PIN 与新 modify/revoke PIN 处于不同区块高度，广播成功不代表语义有效，因此刷新后必须以 MAN 返回 `status` 为准

3. **历史数据兼容**
   老数据没有状态字段时要默认按 create + normal 处理，避免升级后全部消失

4. **统计重新开始**
   当前产品明确选择“修改后统计不继承旧版本”，实现中不能再按同名或 source 链把新旧版本收入/评分重新合并

---

## 16. 结论

本次功能将基于 MetaID 官方 `modify` / `revoke` 语义，为 Gig Square 增加：

- 完整可用的服务撤销
- 完整可用的服务修改
- 服务版本链与当前版本视图
- 明确的钱包使用者提示
- 对进行中订单的严格保护

该方案保持了现有本地优先缓存架构，同时为后续更多链上服务生命周期操作保留了可扩展空间。
