# S3 法币收款收口报告（缺陷 1 / 2 修复 + 缺陷 3 实弹清单）

- 工作树：`/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/.worktrees/s3-fiat-closure`
- 分支：`fix/s3-fiat-closure`（基线 `main` `c9a5c513`，main 零改动）
- 日期：2026-11-12
- 范围：只动本工作树；无 push、无合 main、无上链、无转账/付费。

## 0. 结论先行

| 缺陷 | 状态 | 一句话 |
|---|---|---|
| 1 桌面端拉不起支付宝 | 已修，**真机未验** | 新增 `isAllowedPaymentLaunchUrl` 精确放行 variant-C 拉起 URL，并在 `will-navigate` / `setWindowOpenHandler` 优先判断；Electron 41 的导航事件路径已用探针证实会触发，但没有在装有支付宝的桌面上真点过按钮。 |
| 2 付款记录只写不读 | 已修 | 读侧补 `status` 归一（旧记录按 pending）、新增「待核验」列表页签与「确认已收到」动作；闭环止于本机人工确认。 |
| 3 担保交易零实弹 | **未执行** | 只产出第 5 节的可照做清单；`escrow_orders` 仍是 0 行，我没有跑任何一单。 |

测试：`tsc --noEmit` / `compile:electron` / `eslint`（改动文件）全绿；`pnpm test` 31 个 runner 共 **3116 项，0 失败，退出码 0**；新增/改动的 S3 支付套件 37 项全绿。

---

## 1. 缺陷 1：桌面端永远拉不起支付宝

### 1.1 根因（文件 + 行号，均为修改前行号）

1. `src/main/main.ts:2785`

   ```ts
   const EXTERNAL_URL_PROTOCOL_ALLOWLIST = new Set(['http:', 'https:', 'mailto:', 'tel:']);
   ```

   `alipays:` 不在其中，`isAllowedExternalUrl()`（`main.ts:2789-2800`）对它是 `false`。

2. `src/main/main.ts:20579-20583`（`setWindowOpenHandler`）与 `src/main/main.ts:20586-20605`（`will-navigate`）：两条路径都只调用 `isAllowedExternalUrl(url)`，命中才 `shell.openExternal`。`alipays:` 命中不了 → 既不导航也不交给系统 → 静默无操作。

3. `src/renderer/components/chat/PaymentCard.tsx:139`（`window.location.href = url`）发出的是 `buildAlipayVariantCUrl()` 产的 `alipays://platformapi/startapp?…`；`paymentLaunchWatchdog.ts:12` 的 2000ms 看门狗等不到页面隐藏，2 秒后 `setPhase('degraded')` —— 这就是主人看到的「什么都不发生，然后降级成二维码」。

**为什么不能只把 `alipays:` 加进第 2785 行那个 Set**：那个 Set 是「通用外链」闸门，放进去等于允许任意 `alipays://` URL（转账页、任意小程序 `appId`、账户页）从任何聊天内容里被拉起；卡片内容来自任意对端消息，属于不可信文本。要开的口子只应该是「收款码扫描入口」这一个形状。

### 1.2 修法

新增 `src/main/paymentLaunchUrl.ts`（DOM-free、electron-free，可单测）：

```ts
export const isAllowedPaymentLaunchUrl = (value: string): boolean => …
```

判定链（全部满足才放行）：

- 原始串非空、≤2048 字符、**不含任何空白/控制字符**（`new URL` 会剥掉 tab/换行，否则会出现「校验的是解析后、交给系统的是原始串」的错位）；
- 原始串以 `alipays://platformapi/startapp?` 开头（精确前缀；`alipays://platformapi/x/../startapp?…` 会被 URL 归一化成合法 host/path，但过不了这一条）；
- 解析后：`protocol === 'alipays:'`、`hostname === 'platformapi'`、`pathname === '/startapp'`、无 port / userinfo / hash；
- 参数名只能是 `saId` / `clientVersion` / `qrcode`，且**每个最多出现一次**（防「我校验第一个 qrcode、支付宝读第二个」）；
- `saId === '10000007'`（扫码入口，而不是任意小程序 id）；
- `qrcode` 解码后必须过与卡片同源的收款码闸：`https://qr.alipay.com/` + `[A-Za-z0-9_-]{6,}` + ≤512，不允许空白。

`src/main/main.ts` 两处接线（`main.ts:20580`、`main.ts:20603`）：

```ts
if (isAllowedPaymentLaunchUrl(url) || isAllowedExternalUrl(url)) {
  void shell.openExternal(url);
}
```

`EXTERNAL_URL_PROTOCOL_ALLOWLIST`（`main.ts:2785`）**原样未动**，`testapp:` 等未知协议继续被拦。

### 1.3 安全取舍

- **精确形状，而不是协议族**：`alipays:` 能寻址的东西远多于收款码；卡片 payload 来自对端消息，属不可信输入。限定 host/path/saId/qrcode 后，能被拉起的只剩「扫一个支付宝收款码」这一种动作，即使有人伪造卡片也只能让受害者打开一个收款页（不产生支付授权）。
- **参数白名单 + 去重**：只校验 `qrcode` 而不限制参数集，会留下「重复参数」这一类解析歧义绕过。
- **原始串前缀 + 无空白**：避免 URL 解析器归一化（`..`、tab/换行剥离）造成的校验/执行不一致。
- **失败即静默拒绝**：不命中就保持旧行为（拦截），不降级为「先打开再说」。

### 1.4 验证到什么程度

做了一次性 Electron 41 探针（脚本跑完即删，未入库；探针只监听事件、**不调用** `shell.openExternal`，因此没有真的唤起任何 App）：

```
PROBE_EVENTS [{"event":"will-navigate","url":"alipays://platformapi/startapp?saId=10000007&qrcode=https%3A%2F%2Fqr.alipay.com%2Fprobe123"},{"event":"will-navigate","url":"alipays://platformapi/startapp?saId=10000007&qrcode=https%3A%2F%2Fqr.alipay.com%2Fprobe123"}]
PROBE_FINAL_URL data:text/html,<html><body><button id="b">go</button></body></html>
PROBE_HTTP_EVENTS [{"event":"will-navigate","url":"https://example.com/"}]
[probe exit: 0]
```

结论：`location.href = alipays://…`（脚本赋值与锚点点击各一次）**确实触发 `will-navigate`**，`preventDefault()` 后页面留在原页 —— 说明「在 `will-navigate` 里接住再交给系统」这条路在 Electron 41 上是成立的，不是空写。

**未验证**：`shell.openExternal('alipays://…')` 在真机上是否真的唤起支付宝、以及未安装支付宝时的失败表现。见第 7 节。

### 1.5 已知残留（未改，明确记录）

桌面端页面不会因为支付宝被唤起而隐藏，所以 2 秒看门狗**仍会**把卡片降级成二维码（在已打开的支付宝窗口下面）。这是 `paymentLaunchWatchdog` 的既有语义，本次没动。若要消除，需要走 preload 的 `openExternal` IPC 并在桌面端跳过降级——那会改动卡片状态机，超出本次「只开白名单」的范围，留作后续项。

---

## 2. 缺陷 2：付款后没有到账跟进（只写不读）

### 2.1 根因（文件 + 行号，均为修改前）

1. 写：`src/renderer/components/chat/PaymentCard.tsx:161-166` 调 `addPendingPaymentRecord({ orderId, amountCents, memo: orderId, recordedAt: Date.now() })`，落到 `localStorage['idbots.payment.pendingRecords']`。
2. 读：`src/renderer/components/chat/paymentPendingRecords.ts` 只导出 `listPendingPaymentRecords` / `hasPendingPaymentRecord`；其中 `hasPendingPaymentRecord` 的唯一运行时代码消费方是 `PaymentCard.tsx:53`（决定按钮是否显示「已记录待核对」）。
3. 复核命令与结果：

   ```
   $ grep -rn "listPendingPaymentRecords\|hasPendingPaymentRecord\|addPendingPaymentRecord" \
       --include=*.ts --include=*.tsx src tests
   src/renderer/components/chat/PaymentCard.tsx:38,39,53,161
   tests/paymentPendingRecords.test.ts:4-6,34-73
   ```

   除卡片自身与单测外，没有任何列表视图、没有卖方确认入口——记录写完即孤证。

### 2.2 修法

**数据层** `src/renderer/components/chat/paymentPendingRecords.ts`：

- `PendingPaymentRecord` 增两个可选字段：`status?: 'pending' | 'confirmed'`、`confirmedAt?: number`。
- 所有读取经 `normalizeRecord()`：`status` 缺失或非法 → `'pending'`；`memo`/`recordedAt` 缺失 → 以 `orderId`/`0` 兜底（**不丢行**，只有 `orderId`+`amountCents` 是必需，与旧版过滤条件一致）。
- 新增 `confirmPendingPaymentRecord(orderId, storage?, now?)`：把该行置为 `confirmed` + `confirmedAt` 并写回；找不到订单返回 `null` 且不写盘。
- 新增 `paymentRecordElapsed()`：把「已过多久」分桶成 minute/hour/day，排序交给调用方做 i18n。
- `addPendingPaymentRecord` 每次写入固定 `status: 'pending'`（重复点「我已支付」= 新的一次付款声明，会把旧的 confirmed 复位，注释写明）。

**视图层** 新增 `src/renderer/components/settings/PendingPaymentRecordsPanel.tsx`：

- 列出：金额（分转元，复用 `formatCentsToYuan`）、订单号、备注、记录时间（`toLocaleString`）、已过多久（i18n 分/时/天）。
- pending 行右侧「确认已收到」按钮 → `confirmPendingPaymentRecord` → 重新 `listPendingPaymentRecords` 刷新；confirmed 行显示绿色「已确认收款」+ 确认时间。
- 底部明示「记录只存在本机；换设备或清除缓存后无法找回」。

**入口** `src/renderer/components/settings/PaymentReceivingSettings.tsx`：`PaymentSettingsTab` 扩为 `'alipay' | 'pending'`，`PAYMENT_SETTINGS_TABS` 加 `{ key: 'pending', labelKey: 'paymentSettingsTabPending' }`，body 增加 `state.activeTab === 'pending' ? <PendingPaymentRecordsPanel /> : null`。用户设置 → 收款设置 → 「待核验」页签。

**i18n** `src/renderer/services/i18n.ts`：zh/en 各补 13 个 key（`paymentSettingsTabPending`、`pendingRecords*`）。

### 2.3 取舍与边界（必须说清）

- **闭环止于人工确认**：没有支付宝回调 API，没有「平台已到账」这种状态。确认动作只是把本机一条记录标成 confirmed，不触发任何转账、不上链。
- **记录是本机的**：买方在 A 机器的记录，卖方在 B 机器看不到。本次交付的是「同一客户端上的记录 → 可见 → 可确认」，跨设备传递（例如买方把凭证发给卖方、卖方在自己的机器上落一条）没有实现——那需要传输层，属于订单系统范畴，本次明确不铺。
- **列表读的是全部记录**（含 confirmed），不是只读 pending：否则一确认就从列表里消失，卖方无法复核「我刚才确认了哪一单」。

### 2.4 向后兼容

旧记录（无 `status`）在读取时补 `'pending'`，不因解析失败整条丢失；这一点由 `tests/paymentPendingRecords.test.ts` 的 `treats a record written before the status field existed as pending` 与 `keeps a record whose memo/recordedAt are missing instead of dropping it` 两条用例钉住。

---

## 3. 缺陷 3：担保交易实弹验证清单

前提：**不改代码、本次不执行**。以下每一步都写明输入与判据；判据不满足就停在该步，不要跳步。

### 3.1 本机先决条件（逐项确认后才开始）

| # | 需要什么 | 怎么确认 | 不满足就停 |
|---|---|---|---|
| P1 | 3 个不同的本地 MetaBot：卖方、买方、担保人 | `metabot` 列表 / `wallet_balance(names=[...])` 三个都有地址 | 缺一个就先建/选 |
| P2 | 卖方持有至少 1 个 MRC-721 item（建议用无价值测试藏品），记下 item pinId（64 hex + `i0`） | `mrc721_balance(names=[卖方])` | 没有就先铸一个测试 item |
| P3 | 三个地址的 MVC 余额：卖方 ≥0.01 SPACE、担保人 ≥0.01 SPACE（两次转移手续费）、买方 ≥0.001 SPACE | `wallet_balance` | 不足先充值 |
| P4 | 买方有可真实付款的支付宝；单笔金额定为 **100 分（¥1.00）**；备注必须是订单号原文 | 人工确认 | 没有真实付款方就先用 owner 自己当买方 |
| P5 | 索引器在线（能读 `mrc721_item_info`） | 对 P2 的 pinId 调一次 `mrc721_item_info` | 读不到就等索引 |
| P6 | 本机数据库可写（`escrow_orders` 表由代码自动建） | `escrow_order_list` 返回空列表即可 | 报错则先查库 |

### 3.2 主路径（创建 → 释放）

| 步 | 动作与输入 | 判据（什么算通过） | 失败处理 |
|---|---|---|---|
| S0 基线 | `escrow_order_list`；`mrc721_item_info(itemPinId)` | 记录：订单条数（预期 0）、item 当前 owner = 卖方、transferCount 数值。三项读数留存 | — |
| S1 创建 | `escrow_order_create`：`kind=mrc721`、`title=S3 实弹演练 #1`、`amount_cents=100`、`seller=<卖方>`、`buyer=<买方>`、`agent=<担保人>`、`item_pin_id=<P2 的 pinId>`、`terms=演练单，仅 ¥1.00` | 返回 escrow 卡片；`escrow_order_info` 显示 `state=CREATED`、角色三方正确、T1 截止 ≈ 创建时间 +24h、时间线 1 条；`escrow_order_list` 条数 +1 | 角色解析失败改用 MVC 地址传参 |
| S2 卖方托管货 | ① `mrc721_transfer(pin_id=<pinId>, to=<担保人 MVC 地址>)`；② 记下 txid（64 hex）；③ `mrc721_item_info` 复核 owner；④ `escrow_order_act(order_id, action=escrow_goods, proof=<txid>, note=…)` | ② txid 为 64 位小写 hex；③ owner = 担保人地址（索引滞后时以链上 txid 为准，不阻塞 ④）；④ `state=ITEM_ESCROWED`、时间线新增一条带 txid、T2 截止 ≈ +24h | txid 格式不对会被状态机拒；索引未更新时先等索引再复核，不要改单 |
| S3 买方付款 + 凭证 | ① 支付宝真实转 ¥1.00 给卖方，备注 = `orderId` 原文；② `escrow_order_act(action=upload_payment_evidence, proof=<凭证引用：截图 pinId 或文件哈希>, basis_memo=<备注原文>)` | ① 转账成功页留存；② `state=PAID_EVIDENCE_UPLOADED`、时间线记录 proof；`basis_memo` 不含订单号必须被拒（见 3.3 负例 N4） | 被拒读 error 原文，按提示补备注；不要伪造凭证 |
| S4 卖方确认到账 | `escrow_order_act(action=confirm_received, basis_amount_cents=100, basis_memo=<备注原文>, proof=<核对记录引用>)` | `state=SELLER_CONFIRMED`；时间线记录金额与备注；金额 100 与订单完全一致 | 实收不是 100 分就停单，不进 S5；不要改单迁就 |
| S5 担保人放货 | ① 担保人 `mrc721_transfer(pin_id=<pinId>, to=<买方 MVC 地址>)` 得 txid；② `escrow_order_act(action=release_goods, proof=<txid>)` | ① txid 64 hex；② `state=RELEASED`（终态）；`mrc721_item_info` owner = 买方；`escrow_order_list(state=terminal)` 可见 | 非担保人调用必须被拒（N1/N2） |
| S6 收尾取证 | `escrow_order_info`；开发者侧 `SELECT state FROM escrow_orders WHERE id=…` | 时间线完整（创建/托管/凭证/确认/放行，各带 proof）；DB 行 `state=RELEASED`；三方各自读数一致 | 任一不一致即视为未通过，保留原始 JSON |

### 3.3 负例（必须在同一轮里跑，否则「全过」不算数）

| # | 动作 | 判据 |
|---|---|---|
| N1 | 买方调用 `confirm_received` | 被拒（actor 非 seller），`state` 不变，时间线不增 |
| N2 | 卖方调用 `release_goods` | 被拒（actor 非 escrow_agent），`state` 不变 |
| N3 | 卖方 `confirm_received` 传 `basis_amount_cents=101` | 被拒（金额必须精确到分），`state` 不变 |
| N4 | `upload_payment_evidence` 的 `basis_memo` 不含订单号 | 被拒（memoOrderNumber 门），`state` 不变 |
| N5 | 在 `ITEM_ESCROWED` 直接 `release_goods` | 被拒（非法迁移），`state` 不变 |

每条负例前后各取一次 `escrow_order_info`，比对 `state` 与时间线长度即可判定。

### 3.4 争议路径（第二单，可选但建议同一轮做完）

`CREATED/ITEM_ESCROWED → dispute_open`（须附 `basis`）→ `DISPUTED` → 担保人 `ruling_release` 或 `ruling_rollback`（须附 `basis`）→ 若回退再 `refund_confirmed`。判据与主路径同构：每步 `state` 与时间线；`ruling_*` 缺 `basis` 必须被拒。

### 3.5 这一节没有做的事

`escrow_orders` 仍是 0 行；上述任何一步都没有执行。清单里的工具名、参数名、状态名取自 `src/main/libs/escrowAgentTools.ts` 与 `src/main/libs/escrowOrderStateMachine.ts` 的实际定义（状态/动作表见 `ESCROW_TRANSITIONS`），但没有跑过一遍，因此**不排除**参数组合在真实调用上还有需要现场微调的地方（例如凭证引用格式）。

---

## 4. 改动文件清单

全部位于工作树 `/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/.worktrees/s3-fiat-closure`：

| 文件 | 类型 | 说明 |
|---|---|---|
| `src/main/paymentLaunchUrl.ts` | 新增 | 精确放行 variant-C 拉起 URL（纯函数） |
| `src/main/main.ts` | 改 | import + `will-navigate` / `setWindowOpenHandler` 两处优先判断（20580 / 20603 行） |
| `src/renderer/components/chat/paymentPendingRecords.ts` | 改 | status 归一、确认动作、elapsed 分桶 |
| `src/renderer/components/settings/PendingPaymentRecordsPanel.tsx` | 新增 | 「待核验」列表 + 确认按钮 |
| `src/renderer/components/settings/PaymentReceivingSettings.tsx` | 改 | 新增 pending 页签与面板挂载 |
| `src/renderer/components/chat/PaymentCard.tsx` | 改（仅注释） | 桌面端行为说明更新为「交给系统打开、页面不隐藏、仍降级」 |
| `src/renderer/services/i18n.ts` | 改 | zh/en 各 13 个 key |
| `tests/paymentLaunchUrl.test.ts` | 新增 | 放行正反例 + 主进程接线静态钉 |
| `tests/pendingPaymentRecordsPanel.test.tsx` | 新增 | 面板服务端渲染 + 接线静态钉 |
| `tests/paymentPendingRecords.test.ts` | 改 | 旧记录归一、确认持久化、缺字段不丢行、elapsed |
| `package.json` | 改 | 新增 `test:s3-payment` 并挂进 `test` 聚合 |
| `.gitignore` | 改 | 新测试文件加入白名单 |

---

## 5. 测试清单与原始回执

### 5.1 命令与结果总览

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit`（renderer，含 `src/renderer` + `src/mobile`） | 无输出，`[tsc exit: 0]` |
| `pnpm run compile:electron`（`tsc -p electron-tsconfig.json`，含 `src/main`） | `[compile:electron exit: 0]` |
| `npx eslint <改动文件> --max-warnings 0` | `[eslint exit: 0]` |
| `pnpm run test:s3-payment` | 37 tests / 37 pass / 0 fail，退出码 0 |
| `pnpm run test:s3-escrow` | 28 + 8 = 36 tests，0 fail，退出码 0 |
| `pnpm test`（项目聚合套件） | **3116 tests / 3116 pass / 0 fail**，退出码 0 |

### 5.2 `pnpm run test:s3-payment` 原始回执（尾部）

```
✔ PendingPaymentRecordsPanel — 待核验收款列表 (34.858917ms)
ℹ tests 37
ℹ suites 8
ℹ pass 37
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 809.226625
[test:s3-payment exit: 0]
```

新增/变更用例（逐条名字即主张）：

- `isAllowedPaymentLaunchUrl — the one scheme the receiving card needs`
  - `allows the exact variant-C URL the PaymentCard itself builds`
  - `allows it regardless of clientVersion`
  - `blocks every other custom scheme`（testapp:/weixin:/bitcoin:/mailto:/file:/javascript:）
  - `blocks http(s) too — those stay governed by isAllowedExternalUrl`
  - `blocks alipays URLs that reach past the scan entry`（其它 host/path/port/userinfo、`saId=20000067`、缺/重/多参数、hash、`x/../startapp` 归一化绕过、非收款码 qrcode、`%0A` 注入）
  - `blocks whitespace / control-character smuggling in the raw string`
  - `rejects uppercase scheme and non-string input`
- `main-process wiring — the gate is actually on the navigation paths`
  - `imports the gate and keeps the generic allowlist unchanged`（`EXTERNAL_URL_PROTOCOL_ALLOWLIST` 行内不得出现 alipays）
  - `checks the payment gate in setWindowOpenHandler`
  - `checks the payment gate in will-navigate`（含 `event.preventDefault()` 仍在）
- `local pending-payment records (「我已支付」)`
  - `treats a record written before the status field existed as pending`
  - `confirms a record and persists the new status across a fresh read`
  - `confirm returns null for an unknown order and leaves storage byte-identical`
  - `keeps a record whose memo/recordedAt are missing instead of dropping it`
  - `buckets elapsed time for the「已过多久」column`
- `PendingPaymentRecordsPanel — 待核验收款列表`
  - `renders legacy (status-less) records as pending, with amount / memo / age`
  - `renders a confirmed record with its badge and no confirm button`
  - `shows the empty state when there is nothing to verify`
  - `is wired into the receiving-settings modal as a tab`
  - `the confirm button calls the persistence module and re-reads storage`

### 5.3 `pnpm test` 原始回执

命令：

```
cd /Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/.worktrees/s3-fiat-closure
export FORCE_COLOR=0
pnpm test > /tmp/s3-fiat-fulltest3.log 2>&1; echo "[pnpm test exit: $?]" >> /tmp/s3-fiat-fulltest3.log
```

聚合（从日志里逐块取 `tests/pass/fail` 再求和）：

```
$ grep "^ℹ tests " /tmp/s3-fiat-fulltest3.log | awk '{s+=$3} END {print s}'
3116
$ grep "^ℹ pass " /tmp/s3-fiat-fulltest3.log | awk '{s+=$3} END {print s}'
3116
$ grep "^ℹ fail " /tmp/s3-fiat-fulltest3.log | awk '{s+=$3} END {print s}'
0
$ tail -3 /tmp/s3-fiat-fulltest3.log
ℹ todo 0
ℹ duration_ms 474.622166
[pnpm test exit: 0]
```

31 个 runner 的逐块 `tests / pass / fail`（顺序即执行顺序）：

```
34/34/0   230/230/0  119/119/0  42/42/0    6/6/0     16/16/0   126/126/0  562/562/0
15/15/0   169/169/0  116/116/0  7/7/0      68/68/0   68/68/0   51/51/0    36/36/0
92/92/0   61/61/0    22/22/0    244/244/0  119/119/0 36/36/0   66/66/0    28/28/0
8/8/0     37/37/0    237/237/0  20/20/0    413/413/0 6/6/0     62/62/0
```

同一条命令在代码提交后复跑（`/tmp/s3-fiat-fulltest-head.log`；此后仅本报告文字有调整，代码零改动），结果一致：

```
$ tail -3 /tmp/s3-fiat-fulltest-head.log
ℹ todo 0
ℹ duration_ms 460.419125
[pnpm test exit: 0]
$ grep "^ℹ tests "  … | awk '{s+=$3} END {print s}'   → 3116
$ grep "^ℹ pass "   … | awk '{s+=$3} END {print s}'   → 3116
$ grep "^ℹ fail "   … | awk '{s+=$3} END {print s}'   → 0
$ grep -c "^✖"      …                                → 0
```

### 5.4 RED 基线（证明测试咬得住，不是空转）

把三处修复临时改坏后重跑（改坏文件有备份，跑完已还原）：

1. `isAllowedPaymentLaunchUrl` 前缀从精确形状放宽成 `alipays://` → `blocks alipays URLs that reach past the scan entry` 红，报错行正是
   `alipays://platformapi/x/../startapp?saId=10000007&qrcode=…`（说明「精确前缀」这条判定被独立钉住）。
2. `will-navigate` 里去掉 `isAllowedPaymentLaunchUrl(url)` → `checks the payment gate in will-navigate` 红（`The input did not match the regular expression /isAllowedPaymentLaunchUrl\(url\)/`）。
3. `normalizeRecord` 把所有行都当 `confirmed` → 4 条记录用例红（写入读回、旧记录归一、确认持久化、缺字段不丢行）。

第一次改坏后共 `5 fail`：

```
✖ main-process wiring — the gate is actually on the navigation paths
✖ checks the payment gate in will-navigate
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /isAllowedPaymentLaunchUrl\(url\)/
✖ local pending-payment records (「我已支付」)
✖ writes one record with orderId / amount / memo / time and reads it back
✖ treats a record written before the status field existed as pending
✖ confirms a record and persists the new status across a fresh read
✖ keeps a record whose memo/recordedAt are missing instead of dropping it
ℹ tests 19
ℹ pass 14
ℹ fail 5
```

### 5.5 环境说明（复跑前必读）

工作树不共享主仓的 `node_modules`（被 gitignore，不在版本控制里）。在本工作树首次跑 `pnpm test` 时因此失败：

- 第一次：`dsh-runtime/test/desktop-ax-plugin.test.mjs` → `ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-tools`；
- 第二次：3 条 ABC 静态用例 → `ENOENT …/node_modules/@openagentinternet/agent-browser-core/package.json`。

两者都是**环境缺失**，不是本次改动引入；补齐（符号链接到主仓已安装依赖，均被 gitignore，不进提交）后全绿：

```bash
cd /Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/.worktrees/s3-fiat-closure
ln -sfn /Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/node_modules node_modules
ln -sfn /Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/dsh-runtime/node_modules dsh-runtime/node_modules
ln -sfn /Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/SKILLs/web-search/node_modules SKILLs/web-search/node_modules
```

另：本机 shell 带 `FORCE_COLOR`，按既有经验用 `FORCE_COLOR=0` 跑，避免 ANSI 色码污染字符串比较造成假红。

---

## 6. 已做的验证 / 没做的验证

### 6.1 已做（可复算）

- 纯函数层：`isAllowedPaymentLaunchUrl` 正例（卡片真实产物）与 20+ 反例。
- 主进程接线：源码静态钉（import、两处 handler、通用白名单未被污染、`preventDefault` 仍在）。
- Electron 41 导航事件：一次性探针确认 `alipays:` 的 `location.href` 赋值会触发 `will-navigate`。
- 数据层：旧记录归一、确认持久化（读原始 storage 字节 + 新读者复读）、未知订单不写盘、缺字段不丢行、elapsed 分桶。
- 视图层：服务端渲染断言（金额/订单号/备注/时长/状态/按钮/空态）、页签挂载与按钮接线静态钉。
- 全仓：`tsc`、`compile:electron`、`eslint`（改动文件）、`pnpm test`（3116 项）。

### 6.2 未验证（不要当成已验证）

1. **真机拉起支付宝未验**：没有在装有支付宝的桌面上真实点击「前往支付宝付款」，没有观察到 App 被唤起；也没有验证未安装支付宝时 `shell.openExternal` 的失败表现。本次只验证了 URL 放行逻辑与导航事件路径。
2. **2 秒降级仍在**：桌面端页面不会隐藏，看门狗仍会把卡片降级成二维码（见 1.5）。
3. **「确认已收到」的真实点击未验**：面板只在 Node 服务端渲染层面断言过；按钮点击没有在真实 DOM/Electron 里点过。持久化本身由模块级测试覆盖。
4. **跨设备未打通**：记录只在本机，买方机器上的记录卖方看不到；这是本次明确的范围外。
5. **旧数据的真实样本未验**：旧记录兼容是用人工构造的旧 JSON 测的，没有拿主人机器上已有的 localStorage 实测（属应用数据，权限外）。
6. **缺陷 3 未实弹**：`escrow_orders` 仍是 0 行，第 3 节清单一步都没执行；「45 项单测」这一说法我实测到的分布是状态机 + 卡片 28 项、agent tools 8 项（共 36 项，命令见 5.1），与简报数字不一致，按实测取证为准。
7. **main 分支状态**：main 仓库 `HEAD=c9a5c513` 未动；`git status` 只有一个我在开工前就已存在的未跟踪文件 `app.json`（不是我产生的）。
