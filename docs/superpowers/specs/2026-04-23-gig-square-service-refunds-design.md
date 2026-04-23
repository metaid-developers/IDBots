# Bot Hub 服务退款集中处理面板设计文档

**日期**: 2026-04-23
**项目**: IDBots
**状态**: 已确认设计，待进入实现计划

---

## 1. 背景与目标

当前 IDBots 已经具备服务订单失败退款机制：

- 买方在订单超时后会自动发起退款申请
- 卖方可以在对应的 A2A 会话中看到退款状态
- 卖方可以在 A2A 会话中点击 `处理退款`
- 退款完成后，订单会进入 `refunded` 状态，并同步到现有订单与服务视图

但实际使用中，退款处理入口过度依赖 A2A 会话的可见性。由于会话恢复、匹配、展示时机等原因，用户经常无法及时在 A2A 窗口里看到退款按钮，导致：

- 买方已经付款并已触发退款申请
- 卖方理论上需要处理退款，但没有稳定入口查看待办
- 买方无法集中查看自己已发起退款的处理进展
- 退款相关信息分散，容易漏单、延迟处理

本设计的目标是：

- 在 Bot Hub 顶部为退款增加一个集中入口
- 让卖方稳定看到“我需处理的退款”列表，并直接处理
- 让买方稳定看到“我发起的退款”列表，并查看处理进展
- 将退款列表的展示与处理从“会话是否出现”解耦，改为以 `service_orders` 退款记录为准
- 保持现有 A2A 对话框中的退款 UI 和业务不变，两套入口并存

---

## 2. 已确认决策

以下规则已在本次设计阶段确认，作为第一版固定约束：

### 2.1 入口位置

- 在 Bot Hub 顶部，将新按钮 `服务退款` 放在 `我的服务` 按钮旁边
- 该按钮与现有 `我的服务`、`发布技能服务` 同级
- 如果当前存在待卖方处理的退款，可在按钮上显示待处理数量徽标

### 2.2 面板结构

- 点击 `服务退款` 后，打开一个独立的大面板
- 面板包含两个 Tab：
  - `我需处理的退款`
  - `我发起的退款`
- 面板为集中查看与处理工作台，不复用“我的服务”弹窗内部视图

### 2.3 “我需处理的退款”列表口径

- 该列表展示本机作为 **卖方** 的退款记录
- 数据来源为本地 `service_orders` 中 `role = seller` 且状态为：
  - `refund_pending`
  - `refunded`
- 已处理和未处理都要展示，便于卖方回看历史
- 对于 `refund_pending` 行，显示 `处理退款` 按钮
- 点击后执行的退款语义必须与当前 A2A 对话框中的 `处理退款` 完全一致

### 2.4 “我发起的退款”列表口径

- 该列表展示本机作为 **买方** 发起的退款记录
- 数据来源为本地 `service_orders` 中 `role = buyer` 且状态为：
  - `refund_pending`
  - `refunded`
- 该列表不提供退款处理按钮，仅展示状态和相关信息

### 2.5 列表字段

`我需处理的退款` 列表至少包含：

- 申请用户信息：`globalmetaid + 头像`
- 金额
- 日期
- 技能服务
- 处理状态

`我发起的退款` 列表至少包含：

- 对方信息：`globalmetaid + 头像`
- 金额
- 日期
- 技能服务
- 处理状态

### 2.6 与 A2A 的关系

- 现有 A2A 对话框中的退款申请/退款处理 UI 与业务 **不做修改**
- 新面板不是替代 A2A，而是新增一个集中入口
- 即使某笔退款没有成功出现在 A2A 中，也必须能在新面板中看到并处理

### 2.7 本次非目标

- 不新增退款协议
- 不新增退款状态
- 不修改退款成功/失败的链上校验规则
- 不改动自动发起退款申请逻辑
- 不在本次引入退款分页、筛选器、批量操作

---

## 3. 方案选择

本设计采用 **独立退款面板 + 订单维度聚合** 方案。

### 3.1 选定方案

退款中心直接以本地 `service_orders` 为真实来源：

- 查询退款订单
- 聚合对手方信息
- 解析可跳转的 A2A 会话
- 对卖方待处理订单直接执行退款处理

这样，退款中心不再依赖 A2A 会话先被正确恢复或正确展示。

### 3.2 为什么不采用“继续围绕 A2A 补按钮”

如果仍然把退款处理入口绑定在 A2A 会话上：

- 会话缺失时依旧无法处理退款
- 仍会出现“链路已经存在，但入口看不到”的老问题
- 不能实现集中查看“我需处理的退款”和“我发起的退款”

因此这不是根因修复。

### 3.3 为什么不并入“我的服务”弹窗

把退款做进“我的服务”虽然实现较快，但会带来两个问题：

- 不符合“`我的服务`旁边单独有一个`服务退款`按钮”的产品要求
- “我发起的退款”是买方视角数据，与“我的服务”经营视图混合后语义不清

因此采用独立退款面板更合适。

### 3.4 为什么要按订单而不是按会话组织

当前退款问题的根因是“会话展示不稳定”，而不是“订单状态不存在”。

`service_orders` 已经稳定记录：

- 退款申请 pin
- 退款完成 txid
- 退款申请时间
- 退款完成时间
- 买/卖双方角色
- 技能服务名
- 对手方 globalmetaid

因此第一版集中退款面板应明确以订单为主语，而不是会话为主语。

---

## 4. 架构与职责划分

### 4.1 Main 进程职责

Main 进程新增一组 Bot Hub 退款聚合能力，职责包括：

- 读取 `service_orders` 里的买/卖方退款订单
- 聚合退款中心所需的列表行数据
- 补充对手方名称与头像
- 解析可跳转的 A2A 会话 ID
- 对卖方待处理退款执行处理逻辑

### 4.2 Renderer 职责

Renderer 负责：

- 在 Bot Hub 顶部增加 `服务退款` 按钮
- 展示待处理数量徽标
- 渲染退款中心面板与双 Tab
- 在列表中展示状态、金额、技能服务、对手方信息
- 对卖方待处理行提供 `处理退款`
- 在已解析到会话时提供 `查看会话`
- 处理 loading、empty、error、processing 等 UI 状态

### 4.3 复用现有退款处理链路

退款处理本身不新建业务语义。

当前 A2A 的 `处理退款` 最终会走主进程里的卖方退款结算服务。新面板应复用同一条业务链路，只是把入口从“按 sessionId 调用”扩展为“按 orderId 调用”。

这样可保证：

- 退款转账逻辑不分叉
- finalize pin 写链逻辑不分叉
- 本地 buyer/seller 订单状态回填不分叉
- A2A 与退款中心看到的是同一笔订单的同一状态

---

## 5. 数据模型与查询设计

### 5.1 数据来源

退款中心完全基于现有 `service_orders` 表，不新增数据库表，不变更 schema。

使用的关键字段包括：

- `id`
- `role`
- `local_metabot_id`
- `counterparty_global_metaid`
- `service_pin_id`
- `service_name`
- `payment_amount`
- `payment_currency`
- `cowork_session_id`
- `status`
- `failure_reason`
- `refund_request_pin_id`
- `refund_txid`
- `refund_requested_at`
- `refund_completed_at`
- `created_at`
- `updated_at`

### 5.2 新增 renderer 使用的退款行模型

建议新增一个面向 renderer 的统一类型，例如 `GigSquareRefundItem`，字段包括：

- `orderId`
- `role`
- `servicePinId`
- `serviceName`
- `paymentAmount`
- `paymentCurrency`
- `status`
- `failureReason`
- `refundRequestPinId`
- `refundTxid`
- `refundRequestedAt`
- `refundCompletedAt`
- `counterpartyGlobalMetaid`
- `counterpartyName`
- `counterpartyAvatar`
- `coworkSessionId`
- `canProcessRefund`

语义说明：

- `role` 用来区分该行属于卖方退款收件箱还是买方退款发起记录
- `counterparty*` 字段统一表示“列表中要展示的对手方”
- `canProcessRefund` 只会在 `role = seller && status = refund_pending` 时为 `true`

### 5.3 列表分组规则

退款中心返回的数据建议直接分为两组：

- `pendingForMe`
- `initiatedByMe`

其中：

- `pendingForMe = listOrdersByStatuses('seller', ['refund_pending', 'refunded'])`
- `initiatedByMe = listOrdersByStatuses('buyer', ['refund_pending', 'refunded'])`

### 5.4 排序规则

为方便运营处理，建议排序如下：

`我需处理的退款`

1. `refund_pending` 在前
2. 同状态内按 `refundRequestedAt` 升序
3. 若缺少 `refundRequestedAt`，回退到 `updatedAt`/`createdAt`

这样最早待处理的退款会排在最前面。

`我发起的退款`

1. `refund_pending` 在前
2. 同状态内按最近时间倒序
3. 已退款记录按 `refundCompletedAt` 或 `updatedAt` 倒序

这样买方更容易先看到仍未完成的退款，再看最近历史。

### 5.5 对手方信息补全

退款记录只保存了 `counterparty_global_metaid`，因此需要像“我的服务”订单明细一样，补一层展示信息：

- 通过 `globalmetaid` 拉取 MetaID 用户资料
- 尝试补齐 `name`
- 尝试补齐 `avatar`

失败时：

- 名称回退为 `globalmetaid`
- 头像回退为默认头像或占位首字母

### 5.6 A2A 会话解析

退款中心不能依赖会话存在，但若能解析出会话，应提供 `查看会话` 入口。

会话解析规则与“我的服务”订单明细保持一致：

1. 优先使用 `service_orders.cowork_session_id`
2. 若缺失，则按既有 `paymentTxid + localMetabotId + counterpartyGlobalMetaid` 规则解析
3. 若解析成功，回写 `service_orders.cowork_session_id`
4. 若解析失败，不阻断退款中心展示，也不阻断卖方处理退款

---

## 6. IPC 与服务边界设计

### 6.1 新增 Gig Square 退款 IPC

建议在 `window.electron.gigSquare` 下新增两类接口：

- `fetchRefunds()`
- `processRefundOrder({ orderId })`

原因：

- 该功能从产品归属上属于 Bot Hub / Gig Square
- 不应再要求 renderer 先拿到 `sessionId` 才能退款
- 可以与现有 `fetchMyServices` / `fetchMyServiceOrders` 保持同级风格

### 6.2 `fetchRefunds()` 语义

返回值建议包含：

- `pendingForMe`
- `initiatedByMe`
- `pendingCount`

其中 `pendingCount` 用于顶栏按钮徽标。

### 6.3 `processRefundOrder({ orderId })` 语义

该接口只接受卖方退款订单：

- 根据 `orderId` 找到订单
- 校验该订单存在且状态为 `refund_pending`
- 调用现有卖方退款结算服务
- 成功后返回最新退款结果
- renderer 侧随后刷新整个退款列表

### 6.4 与现有 `cowork:session:processServiceRefund` 的关系

保留现有 `cowork:session:processServiceRefund`，不做删除或语义改变。

新增的 `gigSquare:processRefundOrder` 与其底层复用同一个 refund settlement service，只是定位订单的入口不同：

- A2A 入口按 `sessionId`
- Bot Hub 退款中心入口按 `orderId`

---

## 7. UI 设计

### 7.1 顶部入口

在 [src/renderer/components/gigSquare/GigSquareView.tsx](/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/src/renderer/components/gigSquare/GigSquareView.tsx) 顶部按钮组中新增：

- `我的服务`
- `服务退款`
- `发布技能服务`

`服务退款` 视觉要求：

- 与现有按钮系统保持同一层级
- 有待处理数量时显示小型 badge
- badge 数字只统计卖方 `refund_pending`

### 7.2 面板总体结构

面板延续 Bot Hub 现有 modal 风格，但内部布局按“收件箱式工作台”组织：

- 标题：`服务退款`
- 副标题：说明该面板集中展示待处理与已发起退款
- Tab 条：`我需处理的退款` / `我发起的退款`
- 内容区：列表、空态、错误态、加载态

第一版不做分页，使用可滚动列表。

### 7.3 列表行设计

列表以“分隔行”而不是厚重卡片为主，避免面板过于拥挤。

每一行包含：

- 左侧：头像
- 主信息：
  - 对手方显示名
  - `globalmetaid`
  - 技能服务名
- 次信息：
  - 金额
  - 日期
  - 失败原因（若有）
- 右侧：
  - 状态 badge
  - 次级 `查看会话` 按钮（若存在会话）
  - 主操作 `处理退款`（仅卖方待处理）

### 7.4 状态表达

第一版只需要明确两种状态文案：

- `待处理`
- `已退款`

建议卖方待处理状态使用警示色，已退款使用成功色。

### 7.5 行为规则

`我需处理的退款`

- `refund_pending`：显示 `处理退款`
- `refunded`：不显示处理按钮，只展示完成状态

`我发起的退款`

- 从不显示 `处理退款`
- 若能解析到会话，可显示 `查看会话`

### 7.6 空态与错误态

空态文案建议区分两个 Tab：

- `我需处理的退款` 为空：`暂无需要你处理的退款`
- `我发起的退款` 为空：`暂无你发起的退款`

错误态需要支持：

- 列表加载失败
- 退款处理失败

退款处理失败时，优先显示 inline error 或 toast，并保持当前行可再次尝试。

---

## 8. 交互与状态流

### 8.1 打开面板

1. 用户点击 `服务退款`
2. renderer 打开退款中心 modal
3. 调用 `gigSquare.fetchRefunds()`
4. 渲染两个 Tab 的列表与按钮徽标

### 8.2 卖方处理退款

1. 用户在 `我需处理的退款` 中点击 `处理退款`
2. 当前行进入 `处理中...` 状态
3. renderer 调用 `gigSquare.processRefundOrder({ orderId })`
4. main 复用现有退款结算服务执行退款
5. 成功后刷新退款列表
6. 该行状态更新为 `已退款`
7. 若该订单对应的 A2A 会话存在，则 A2A 中的状态卡也会通过既有流程体现完成状态

### 8.3 查看会话

1. 用户点击 `查看会话`
2. renderer 切回 `cowork`
3. 加载对应会话
4. 若会话不存在，则该按钮本身不显示

### 8.4 徽标更新

待处理徽标来源于最新退款列表数据：

- 面板打开时刷新
- 退款处理成功后刷新
- Bot Hub 页面重新进入时刷新

第一版不要求通过全局事件实现实时推送更新。

---

## 9. 测试策略

本次实现必须遵守 TDD，优先补自动化测试，再写实现代码。

### 9.1 Main 进程测试

新增或扩展测试覆盖：

- 退款列表聚合服务：
  - 卖方 `refund_pending/refunded` 是否正确归入 `pendingForMe`
  - 买方 `refund_pending/refunded` 是否正确归入 `initiatedByMe`
  - 排序是否符合设计
  - 对手方信息缺失时是否正确回退
  - 会话解析缺失时是否仍返回可展示记录

- 退款处理 IPC：
  - `refund_pending` 卖方订单可正常处理
  - 非卖方或非 `refund_pending` 订单会被拒绝
  - 处理成功后返回结果可驱动刷新

### 9.2 Renderer 测试

新增或扩展测试覆盖：

- Bot Hub 顶部出现 `服务退款` 按钮
- 待处理数量徽标显示正确
- 退款面板双 Tab 正常切换
- `我需处理的退款` 中：
  - 待处理行显示 `处理退款`
  - 已退款行不显示 `处理退款`
- `我发起的退款` 中不显示 `处理退款`
- 金额、日期、服务名、状态、globalmetaid 正常渲染
- `查看会话` 缺失时按钮不显示

### 9.3 回归重点

必须确认以下既有能力不受影响：

- A2A 对话中的退款状态卡仍可正常显示
- A2A 中原有 `处理退款` 入口仍可正常使用
- “我的服务”列表与订单明细不受影响
- 退款完成后，原有订单状态聚合仍正确

---

## 10. 风险与兼容性

### 10.1 与旧数据兼容

本设计不引入新表或新字段，因此：

- 不需要数据库迁移
- 老用户现有退款订单可直接进入新面板展示

### 10.2 会话缺失兼容

第一版的核心兼容要求是：

- 即使会话不存在，也必须能在退款中心展示退款记录
- 即使没有会话，也必须允许卖方直接处理退款

这正是本次改造要解决的核心问题。

### 10.3 处理中的重复点击

renderer 必须为单行退款处理加本地 loading 锁，避免重复点击。

main 侧仍需依赖既有退款结算逻辑的幂等保护，防止重复转账或重复 finalize。

---

## 11. 实施范围建议

建议实现时修改以下区域：

- 主进程
  - `src/main/main.ts`
  - 新增退款列表聚合服务，例如 `src/main/services/gigSquareRefundsService.ts`
  - 复用现有订单与会话解析逻辑

- 预加载与类型
  - `src/main/preload.ts`
  - `src/renderer/types/electron.d.ts`
  - `src/renderer/types/gigSquare.ts`

- 渲染层
  - `src/renderer/components/gigSquare/GigSquareView.tsx`
  - 新增 `src/renderer/components/gigSquare/GigSquareRefundsModal.tsx`
  - 可能新增小型 presentation helper
  - `src/renderer/services/i18n.ts`

- 测试
  - main 服务测试
  - renderer modal 测试

---

## 12. 结论

本设计把退款中心从“附着在 A2A 会话上的局部能力”升级为“Bot Hub 内稳定可见的集中处理入口”。

核心原则是：

- **以订单台账为真相**
- **以集中面板承接退款待办**
- **复用既有退款处理业务链**
- **不改动现有 A2A 退款语义**

这样可以在不推翻现有退款实现的前提下，直接解决“退款按钮经常看不到、退款容易遗漏”的实际问题，并为后续更完整的退款运营能力打下基础。
