# 服务订单失败处理与退款机制设计文档

**日期**: 2026-03-25  
**项目**: IDBots  
**状态**: 已确认设计，待规划实施

---

## 1. 背景与目标

### 1.1 现状问题

当前 IDBots 的服务订单主流程只覆盖正常路径：

`支付 -> B 端执行服务 -> 交付 -> A 端评价上链`

这条路径在理想情况下可用，但对失败情况几乎没有正式处理机制。现实里，B 端可能因为网络异常、LLM 配置错误、技能执行失败、进程中断等原因无法及时响应或交付，结果会变成：

- A 已支付费用
- B 没有按预期交付
- A 无法通过系统发起正式退款
- B 也没有统一入口处理退款
- 服务广场无法识别“历史退款处理很差”的服务提供者

这会直接削弱服务订单的大规模采用能力。

### 1.2 本设计的目标

本设计为服务订单增加一套完整、可落地、可自动化验证的失败与退款机制，目标是：

- 明确界定服务订单失败标准
- 在失败后由 A 自动发起退款申请
- 为 B 提供明显、可执行的退款处理入口
- 让 A 能确认退款已处理完成
- 让服务广场可以根据未处理退款情况标记或隐藏高风险服务
- 在实现复杂度、上线速度、数据安全之间取得平衡

### 1.3 设计原则

- **先保交易公平，再保流程灵活**：第一版优先保证“付费未交付可追偿”，不追求复杂争议仲裁
- **本地状态机负责运行态，链上协议负责凭证态**
- **老用户数据优先保留**：迁移必须幂等、保守、无感
- **优先自动化验证**：后续实施必须尽量以自动化测试覆盖核心状态流

---

## 2. v1 已确认决策

以下规则已在设计阶段确认，为第一版固定约束：

### 2.1 SLA 与失败标准

- 所有服务订单使用固定阈值，不支持服务级自定义 SLA
- `5 分钟内` 未收到首次响应，判定失败
- `15 分钟内` 未收到最终结构化交付，判定失败

### 2.2 首次响应与最终交付定义

- **首次响应**：B 发出一条与该订单关联的私聊回复消息，A 实际收到后，记为首次响应成功
- **最终交付**：B 必须发出结构化交付消息；普通文本消息不算最终交付

### 2.3 退款规则

- 第一版只支持 **全额退款**
- A 在系统判定失败后 **自动发起退款申请**
- 如果当时离线或链上广播失败，下次启动或后续轮询时自动补发
- B 第一版只允许 **人类手动确认退款**
- 第一版 **不支持退款拒绝**

### 2.4 订单并发限制

- 同一对 A/B（buyer metabot 与 seller globalMetaID）**同时只允许 1 笔进行中的服务订单**
- 第一版不支持同一对手方并发多单

### 2.5 退款后补交付规则

- 一旦订单进入 `退款处理中`，后续补发交付 **不再恢复为已完成**
- 第一版只允许继续走退款完成路径

### 2.6 服务广场惩罚规则

- 如果 provider 存在未处理退款申请，服务卡 **标红**
- 如果未处理持续超过 `72 小时`，服务从服务广场默认列表中 **隐藏**

### 2.7 退款完成标准

退款完成必须同时满足：

1. B 已广播 `service-refund-finalize` 协议  
2. 协议中的退款 `txid` 已通过链上校验，确认原金额已全额退回给 A

---

## 3. 范围与非目标

### 3.1 v1 范围

- 新增服务订单本地台账
- 新增订单失败状态机
- 新增结构化交付约束
- 新增退款申请与退款完成链上协议
- 新增 A/B 两端退款 UI
- 新增服务广场退款风险标记/隐藏逻辑
- 新增自动化测试覆盖主状态流

### 3.2 v1 非目标

- 不支持部分退款
- 不支持退款协商金额
- 不支持退款拒绝协议
- 不支持仲裁或第三方裁决
- 不支持同一对 A/B 并发多单
- 不对旧版历史订单做激进追溯补判

---

## 4. 整体方案选择

本设计采用 **显式订单台账** 方案。

### 4.1 为什么不采用“薄层补丁”

如果只在现有 A2A 会话和私聊流程上加若干超时器、退款协议和 UI 提示，短期实现会很快，但会导致：

- 状态分散在会话映射、消息文本、链上协议之间
- 应用重启后恢复逻辑脆弱
- 服务广场风险聚合难以稳定实现
- 后续扩展多单、仲裁、退款统计时成本很高

### 4.2 为什么不采用“链上即真相”

如果几乎不维护本地订单台账，全部依赖链上协议反推状态，则：

- 超时判定不适合作为纯链上逻辑
- 本地 UI 很难实时、清晰地表达“正在等待 / 已失败 / 正在退款”
- 离线补偿和幂等重试都会变复杂

### 4.3 选定方案

第一版采用：

- **本地 `service_orders` 台账**：负责运行态与超时判定
- **链上 refund 协议**：负责可验证凭证
- **现有 A2A 会话**：负责展示订单与退款相关消息

这是在实现速度、风险可控性和后续扩展性之间最合适的平衡点。

---

## 5. 架构与职责划分

### 5.1 新增/调整模块

建议新增两个主服务，并保留现有 `privateChatDaemon`：

- `serviceOrderLifecycleService`
  - 负责本地订单台账创建与状态推进
  - 负责超时判定
  - 负责 A 端自动退款申请与重试

- `serviceRefundSyncService`
  - 负责扫描链上退款申请/完成协议
  - 负责回填本地订单状态
  - 负责为服务广场提供 provider 风险聚合信息

- 现有 `privateChatDaemon`
  - 保持“收私聊消息 / 解密 / 发消息 / 订单路由 / 邀评流程”职责
  - 不再承担主要订单状态机职责，只负责把消息事件上报给订单生命周期服务

### 5.2 责任边界

#### privateChatDaemon

- 识别 `[ORDER]`
- 识别结构化 `[DELIVERY]`
- 识别 `[NeedsRating]`
- 发送私聊消息
- 将“订单消息已收到”“交付消息已收到”等事件交给 `serviceOrderLifecycleService`

#### serviceOrderLifecycleService

- 创建 buyer/seller 本地台账
- 计算 deadline
- 判定首次响应是否超时
- 判定交付是否超时
- 失败后触发退款申请
- 维护退款申请的幂等重试状态

#### serviceRefundSyncService

- 扫描 `/protocols/service-refund-request`
- 扫描 `/protocols/service-refund-finalize`
- 验证退款 tx
- 回填 A/B 两端订单状态
- 统计 provider 是否存在未处理退款，以及持续时长

---

## 6. 本地数据模型

### 6.1 新增表：service_orders

在现有用户 SQLite 中新增 `service_orders` 表。该表与现有 `cowork_sessions` / `cowork_messages` 并存，不替代它们。

建议字段：

| 字段 | 含义 |
| --- | --- |
| `id` | 本地 UUID 主键 |
| `role` | `buyer` / `seller` |
| `local_metabot_id` | 本地 MetaBot ID |
| `counterparty_global_metaid` | 对端 MetaBot GlobalMetaID |
| `service_pin_id` | skill-service pin ID |
| `service_name` | 服务名 |
| `payment_txid` | 原支付 txid |
| `payment_chain` | `mvc` / `btc` / `doge` |
| `payment_amount` | 人类可读金额字符串 |
| `payment_currency` | `SPACE` / `BTC` / `DOGE` |
| `order_message_pin_id` | 发单消息对应 pin |
| `cowork_session_id` | 对应 A2A 会话 ID |
| `status` | 当前订单状态 |
| `first_response_deadline_at` | 首次响应截止时间 |
| `delivery_deadline_at` | 交付截止时间 |
| `first_response_at` | 首次响应实际时间 |
| `delivery_message_pin_id` | 结构化交付消息 pin |
| `delivered_at` | 实际交付时间 |
| `failed_at` | 失败判定时间 |
| `failure_reason` | 失败原因，例如 `first_response_timeout` / `delivery_timeout` |
| `refund_request_pin_id` | 退款申请协议 pin |
| `refund_finalize_pin_id` | 退款完成协议 pin |
| `refund_txid` | 实际退款 txid |
| `refund_requested_at` | 退款申请时间 |
| `refund_completed_at` | 退款完成时间 |
| `refund_apply_retry_count` | 自动申请退款的重试次数 |
| `next_retry_at` | 下次自动申请退款重试时间 |
| `created_at` | 创建时间 |
| `updated_at` | 更新时间 |

### 6.2 订单状态

建议使用以下有限状态：

- `awaiting_first_response`
- `in_progress`
- `completed`
- `failed`
- `refund_pending`
- `refunded`

说明：

- `failed` 是内部过渡态，用于触发自动退款申请
- `refund_pending` 表示已发起退款申请，等待 B 处理
- `refunded` 表示退款完成并经链上校验

### 6.3 唯一性与幂等

建议至少保证以下幂等约束：

- 同一 `payment_txid + role + local_metabot_id` 不重复建单
- 同一 `refund_request_pin_id` 不重复回填
- 同一 `refund_finalize_pin_id` 不重复回填

第一版不新增单独退款 outbox 表，退款申请重试状态直接挂在 `service_orders` 上。

---

## 7. 订单消息与链上协议

### 7.1 结构化交付消息

第一版不新增单独 delivery 链上协议，继续走现有私聊 `simplemsg`，但 **最终交付必须使用结构化 `[DELIVERY]` 消息**。

建议消息体字段：

```json
{
  "version": "1.0.0",
  "paymentTxid": "原支付 txid",
  "servicePinId": "skill-service pin id",
  "serviceName": "服务名",
  "result": "最终交付结果",
  "deliveredAt": 1770000000
}
```

说明：

- `result` 保持字符串，兼容当前 UI 渲染
- `paymentTxid + servicePinId` 用于与订单台账关联
- 15 分钟 SLA 的“最终交付”只认这种结构化消息

### 7.2 退款申请协议

协议路径：

`/protocols/service-refund-request`

建议 payload：

```json
{
  "version": "1.0.0",
  "paymentTxid": "原支付 txid",
  "servicePinId": "skill-service pin id",
  "serviceName": "服务名",
  "refundAmount": "0.001",
  "refundCurrency": "SPACE",
  "refundToAddress": "A 的退款地址",
  "buyerGlobalMetaId": "A 的 globalMetaID",
  "sellerGlobalMetaId": "B 的 globalMetaID",
  "orderMessagePinId": "订单消息 pin",
  "failureReason": "first_response_timeout | delivery_timeout",
  "failureDetectedAt": 1770000000,
  "reasonComment": "服务超时",
  "evidencePinIds": ["相关 pin 列表"]
}
```

### 7.3 退款完成协议

协议路径：

`/protocols/service-refund-finalize`

建议 payload：

```json
{
  "version": "1.0.0",
  "refundRequestPinId": "对应退款申请 pin",
  "paymentTxid": "原支付 txid",
  "servicePinId": "skill-service pin id",
  "refundTxid": "实际退款 txid",
  "refundAmount": "0.001",
  "refundCurrency": "SPACE",
  "buyerGlobalMetaId": "A 的 globalMetaID",
  "sellerGlobalMetaId": "B 的 globalMetaID",
  "comment": "B 的备注"
}
```

---

## 8. 订单生命周期与失败处理

### 8.1 创建订单

当 A 在 `gigSquare:sendOrder` 中完成支付并成功发送 `[ORDER]` 后：

1. 检查同一 `(buyer metabot, seller globalMetaID)` 是否已有未终态订单  
2. 若已有，则拒绝重复下单  
3. 若没有，则创建 buyer 侧 `service_orders` 记录  
4. 记录 `first_response_deadline_at = now + 5 分钟`  
5. 记录 `delivery_deadline_at = now + 15 分钟`

当 B 收到 `[ORDER]` 且支付校验通过后：

1. 创建 seller 侧 `service_orders` 记录  
2. 使用 `payment_txid` 做幂等去重，避免重复入库  

### 8.2 首次响应

规则：

- B 发出一条关联订单的私聊消息后，不立即视为成功
- 只有 **A 实际收到** 该消息并成功关联到本地订单，才将 buyer 订单推进到 `in_progress`
- seller 侧可同步记录“已发起首次响应”的辅助时间，但 buyer 侧观测结果才是 SLA 真相

### 8.3 最终交付

规则：

- B 必须发送结构化 `[DELIVERY]` 消息
- A 实际收到并解析成功后，订单推进到 `completed`
- 进入 `completed` 后继续复用现有 `[NeedsRating] -> skill-service-rate` 流程

### 8.4 失败判定

定时扫描规则：

- `awaiting_first_response` 超过 `first_response_deadline_at` 且无 `first_response_at`：判定失败
- `in_progress` 超过 `delivery_deadline_at` 且无 `delivery_message_pin_id`：判定失败

失败后：

1. 状态推进为 `failed`
2. 记录 `failed_at`
3. 记录 `failure_reason`
4. 立即进入退款申请流程

### 8.5 自动退款申请

当 buyer 订单进入 `failed` 后：

1. 构造 `service-refund-request`
2. 尝试上链广播
3. 成功则状态推进到 `refund_pending`
4. 失败则记录 `refund_apply_retry_count` 与 `next_retry_at`
5. 后续轮询或下次启动时继续重试

### 8.6 退款处理中与补交付

一旦订单进入 `refund_pending`：

- 后续来自 B 的补交付消息不再恢复订单为 `completed`
- UI 仍可展示这些消息，但不会改变订单终局方向

这是第一版用于降低状态分叉复杂度的刻意约束。

### 8.7 卖家处理退款

B 在会话中看到退款请求后：

1. 人类点击“处理退款”
2. 系统展示金额、链、退款地址、原支付 txid、comment
3. 人类确认后发起退款转账
4. 转账成功后广播 `service-refund-finalize`

第一版不提供“拒绝退款”入口。

### 8.8 退款完成

当系统扫描到 `service-refund-finalize` 后：

1. 提取 `refundTxid`
2. 校验该 tx 已将原金额全额退回 A 的地址
3. 校验通过后将订单推进到 `refunded`
4. 回填 `refund_finalize_pin_id`、`refund_txid`、`refund_completed_at`

---

## 9. UI 与服务广场行为

### 9.1 A 端买家会话

订单进入 `refund_pending` 后：

- A2A 会话标题转橙
- 插入系统消息：明确因超时已自动发起退款申请
- 会话底部显示固定退款状态卡，展示：
  - 退款状态
  - 原支付 txid
  - 申请金额与币种
  - 失败原因
  - refund-request pin

退款完成后：

- 再插入系统成功消息
- 底部卡切换为完成态
- 展示 `refund txid` 与 `refund-finalize pin`

### 9.2 B 端卖家会话

当系统扫描到针对该订单的退款请求后：

- A2A 会话标题转橙
- 底部出现“退款请求待处理”卡
- 卡片内展示：
  - 退款金额
  - 退款地址
  - 原支付 txid
  - 申请原因
  - refund-request pin
- 提供唯一主动作按钮：`处理退款`

### 9.3 服务广场

如果 provider 存在未处理退款申请：

- 服务卡继续显示，但整体标红
- 增加风险 badge，例如 `REFUND RISK`

如果未处理持续超过 `72 小时`：

- 服务从默认服务列表中隐藏

第一版默认不做复杂筛选切换，优先实现主列表隐藏逻辑。

---

## 10. 旧用户升级与兼容策略

### 10.1 迁移原则

- 只新增表、索引、可空字段
- 所有迁移必须幂等
- 不删除、不清空、不重建旧库
- 不改写已有 `cowork` 历史消息

### 10.2 对旧订单的处理策略

升级前旧用户已经存在的订单历史，分两类处理：

#### 可无歧义重建

如果能够从现有会话消息与 metadata 中明确识别：

- 原支付 txid
- provider / buyer 对应关系
- service pin 或 service 标识

则允许补建最小订单台账记录。

#### 不可无歧义重建

如果无法可靠重建，则：

- 保留原会话历史不变
- 不自动补判失败
- 不自动发起退款申请

这样做是为了避免旧数据被误解释为失败单，导致错误退款行为。

### 10.3 升级无感要求

对已升级用户，迁移完成后应满足：

- 原会话仍可正常查看
- 原服务广场缓存仍可读取
- 新版本新建订单自动走新台账
- 即使迁移后未命中旧订单重建，也不影响新订单使用

---

## 11. 自动化验证与调试策略

### 11.1 自动化测试优先

该需求要求尽量通过自动化测试验证，至少覆盖：

- `service_orders` 仓储与状态机测试
- 超时判定测试
- 自动退款申请幂等与重试测试
- `[DELIVERY]` 解析与状态推进测试
- refund request/finalize 协议同步测试
- 退款 tx 校验测试
- 服务广场标红/72h 隐藏测试
- 数据迁移与旧用户兼容测试

### 11.2 主流程端到端测试

应至少建立以下主流程集成测试：

1. `支付 -> 首次响应 -> 结构化交付 -> 评价`
2. `支付 -> 首次响应超时 -> 自动退款申请`
3. `支付 -> 交付超时 -> 自动退款申请`
4. `退款申请 -> B 手动退款 -> finalize -> A 端完成提示`

### 11.3 编译与调试现实约束

当前仓库存在“新 worktree 直接跑全量 `node --test tests/*.test.mjs` 并不全绿”的基线现实，主要原因包括：

- 当前环境 Node 版本与仓库 engine 声明不完全一致
- 多个测试依赖 `dist-electron` 构建产物
- 仓库已有若干与本需求无关的现存失败

因此，后续实施阶段的验证策略应是：

- 先补齐 `npm run compile:electron` 或 `npm run build`
- 建立与本需求直接相关的 targeted tests
- 用 `npm run electron:dev` 做交互联调
- 在功能完成后再补做更完整的回归验证

本设计不以“当前全仓全量测试天然全绿”作为实施前提，但要求本需求新增测试必须可稳定复现、可重复运行。

---

## 12. 风险与控制措施

### 12.1 误退款风险

风险：旧订单或模糊关联订单被错误判定失败，自动发起退款。  
控制：

- 历史订单保守迁移
- 新订单强保证，旧订单弱追溯
- 只对无歧义订单自动申请退款

### 12.2 重复退款风险

风险：重复扫描、重复点击、重启恢复导致多次退款。  
控制：

- `payment_txid + service_pin_id` 维度做幂等
- finalize 与 tx 校验双重确认

### 12.3 假退款风险

风险：B 只广播 finalize，不实际退款。  
控制：

- finalize 不构成单独完成条件
- 必须校验退款 tx

### 12.4 状态漂移风险

风险：本地状态与链上协议不同步。  
控制：

- 本地状态机负责运行态
- 链上协议负责凭证态
- 通过周期扫描做回填和修正

### 12.5 升级破坏风险

风险：老用户数据库在升级时受损。  
控制：

- 迁移只增不删
- 迁移幂等
- 所有新逻辑先以“表存在且迁移完成”为前提

---

## 13. 分阶段实施建议

建议将实现拆成四批：

### 阶段 1：数据底座

- 新增 `service_orders`
- 编写迁移
- 建立仓储 API
- 建立基础状态机单测

### 阶段 2：订单生命周期

- A 发单建台账
- 同对手方重复下单拦截
- 首次响应事件推进
- 结构化 `[DELIVERY]` 交付推进

### 阶段 3：退款链路

- 超时扫描
- A 自动退款申请与重试
- B 手动退款处理
- finalize 与退款 tx 校验

### 阶段 4：UI 与服务广场

- A/B 会话橙色告警与底部卡片
- 退款完成提示
- 服务广场标红与 72 小时隐藏

---

## 14. 结论

第一版服务订单失败与退款机制应采用“显式订单台账 + 链上退款凭证 + 现有 A2A 会话承载展示”的组合方案。

该方案满足以下关键要求：

- 失败标准清晰
- 退款发起自动化
- 卖家处理路径明确
- 买家结果可感知
- 服务广场可对持续不处理退款的 provider 施加可见惩罚
- 对老用户数据库升级足够保守
- 后续实现可通过自动化测试逐步稳固

这是当前阶段在开发难度、上线速度、用户保护与后续扩展之间的最优平衡。
