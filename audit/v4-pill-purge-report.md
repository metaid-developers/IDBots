# v4 胶囊按钮全量清退报告（feat/flat-v4-pill-purge）

日期：2026-11-14 深夜 · 施工：Wednesday/Mercury（Worker）· 委派：Twin
分支：`feat/flat-v4-pill-purge`（本地基于 `feat/flat-v3-pair-harmony` 新开，无网络操作）
判据（owner 2026-11-14 23:18 裁定，取代上轮「文字按钮归为标签」判法）：
**文字 + 可点击（button/a/onClick/role=button）= 按钮 = 硬朗矩形**；开关轨道、头像圈、纯状态点、纯展示徽章（无文字不可点）维持圆形。紧凑小按钮 → `--shape-radius-sm`(8px)；标准按钮 → `--shape-radius-md`(10px)。

## 0. 一句话结论

全库（src/renderer 即全库 rounded-full 聚居地，范围外计数=0）按新判据逐条重判 census 保留的 288 处发生点（291 − v2 已改 3）：**唯一漏网的「文字+可点击」胶囊 = MetaAppsManager.tsx:357（bot 作者行按钮），已改为 `rounded-[var(--shape-radius-sm)]`**；其余 287 处全部维持圆形并逐条登记（288 行对照表零错位）。owner 点名七样本全部**早已是矩形**（v2/v3 已修，附 git 与行级证据）。

## 1. 重判方法与对位精度

- 扫描器 `audit/v4-scan.cjs`：TypeScript 5.9.3 AST 解析 src/renderer 全部 .tsx/.ts/.js，逐 JSX 元素抽取 className 初始化器、onClick/role/href、可见文字（JsxText + 字符串型表达式）与后代可点击性。
- 对位：每条记录按**发生点绝对偏移**（occOffsets）与 census v2 文本序逐条对齐；单 className 双发生（IMSettings:955/960 ternary 双分支）展开成两行对位。游离位（className 初始化器外：frameClassName 透传 ×10、字符串常量 ×4）按偏移并入同一序列。
- 对账：对位前 112 文件计数零错位；对位后 288/288 全映射、0 条未映射。工具链缺陷两处（occCount 槽位、纯游离位文件漏键）当场修正并留痕于脚本历史。
- 覆盖闭合：grep 全库 288 处 = 初始化器内 274 + 游离位 14（改后 287 = 271 记录 + 14 游离位 −记录内双发生修正），脚本计数与 grep 逐位一致。

## 2. 重判总账（census → v4 判定精确矩阵，Σ=288）

```
 1 ①禁触-移交            → ①禁触-移交维持          （MacWindowLights:96，owner 禁触清单）
 1 ②chip徽章(标签形态-MonM3) → ①改矩形             ★唯一改判 = MetaAppsManager:357，已实施
57 ②chip徽章             → ②维持-展示徽章（带文字不可点）
23 ②chip徽章             → ③维持-装饰
14 ②头像圈               → ②维持-头像圈
 2 ②头像圈(可点击)        → ②维持-头像圈            （头像包按钮：aria-label 非可见文字）
 2 ②头像圈(可点击)        → ②维持-可点击无文字
 3 ②头像圈               → ②维持-展示徽章
10 ②头像圈               → ②维持-状态点
18 ②头像圈               → ③维持-装饰
17 ②开关轨道             → ②维持-开关轨道           （16 JSX + 1 常量 metaBotCardPresentation.js）
15 ②开关滑块             → ②维持-开关滑块           （14 JSX + 1 常量）
 1 ②开关轨道             → ③维持-装饰
47 ②状态点               → ②维持-状态点
 3 ③其他装饰             → ②维持-头像圈
11 ③其他装饰             → ②维持-展示徽章
 3 ③其他装饰             → ②维持-开关滑块
24 ③其他装饰             → ②维持-状态点
23 ③其他装饰             → ③维持-装饰
 1 ③其他装饰             → ③维持-装饰条            （McpManager tab 指示条常量）
 1 ③禁触-装饰条          → ②维持-状态点
 6 ③进度/装饰            → ②维持-状态点
 5 ③进度/装饰            → ③维持-进度/装饰条
```

逐条 288 行全表：**`audit/v4-rejudge-table.md`**（机读：`audit/v4-rejudge-prechange.json`）。
按最终 verdict 汇总：装饰 65 / 状态点 88 / 开关轨道 17 / 开关滑块 18 / 展示徽章 71 / 头像圈 19 / 可点击无文字 2 / 进度条 5 / 装饰条 1 / **改矩形 1** / 禁触移交 1 = **288**。

### 2.1 唯一改判项（owner 裁令的「误判②类文字按钮」本体）

- `src/renderer/components/metaapps/MetaAppsManager.tsx:357`（v2 census 行 369，元素逐字节同一）
- census 判 = **②chip徽章(标签形态-MonM3)**——正是 v2 MonM3「回退圆形并登记」的那枚；owner 23:18 裁令明确取代该判法。
- 元素事实：`<button type=button onClick={onOpenBotInBrowser…}>`，子节点 = 头像 img(28px 圆，保留) + **作者名文字**（text-xs `{author.name}`）→ 文字+可点击=按钮。
- 实施：`rounded-full` → **`rounded-[var(--shape-radius-sm)]`**（8px 紧凑档；同模块既有小矩形 = 分页钮 `rounded-lg`=8px、prompt chip `rounded-md`）。填充逻辑不变（透明底），ring 聚焦描边保留，无阴影无位移。非按钮分支（无 browserTarget 时渲染的 div）不动。内层头像 img 的 `rounded-full` 属头像圈，保留。

### 2.2 「可点击但无文字」22 处全落 owner 保留类（零漏网图标钮）

- 开关轨道 ×16（Settings×6 / IMSettings×2 / McpManager×2 / SkillsManager / MemorySettings / ProjectsManager / TaskList / MeIncrementPackCard / TrafficSettings —— button/div 轨道，可点击但零文字）
- 头像圈(可点击) ×5（A2AMessageItem:684、GroupTaskListMeta:105、MetaAppsManager 旧pill的姊妹钮 GroupTaskMessageItem:215、CoworkSessionItem:284、NftCard 等 img/框钮——子节点均为纯头像元素，aria-label/title 是无障碍标签非可见文字）
- 禁触 ×1（MacWindowLights:96 红绿灯装饰点）

## 3. owner 点名七样本逐一核对（全部已是矩形）

| 样本 | 现位置 | 现圆角 | 状态 |
|---|---|---|---|
| 备份助记词 | UserSettings.tsx:1041 | `rounded-[var(--rounded)]`(12px) | ✓ 矩形 |
| 切换账号 | UserSettings.tsx:1049 | `rounded-[var(--rounded)]` | ✓ 矩形 |
| 退出登录 | UserSettings.tsx:1057 | `rounded-[var(--rounded)]` + border-red-600 | ✓ 矩形 |
| 一键备份 | UserSettings.tsx:1273 | `btn-idchat-primary-filled`(12px 类族) | ✓ 矩形 |
| 从链上恢复 | UserSettings.tsx:1289 | `rounded-[var(--rounded)]` | ✓ 矩形 |
| 保存（名字行） | UserSettings.tsx:1136 | `btn-idchat-primary-filled` | ✓ 矩形 |
| 新建任务 | LongTermTasksBoard.tsx:62 + ScheduledTasksView.tsx:228 | `btn-idchat-primary-filled` ×2 | ✓ 矩形 |

历史证据：`git show eb3c579f`（v2 census 基线）中三联已是 `rounded-xl`（v2 报告 §3A 六按钮核销「**0 处** rounded-full」，v3 又把白名单统一为 `var(--rounded)`）。owner 裁令针对的 v1「文字按钮归为标签」判法叙事，其代码后果已在 v2/v3 清偿；v4 逐条重判证明无残留。

## 4. 成对同构（v3 规则沿用）

- 唯一改动钮为作者行**单实体**（非共排组：无 browserTarget 时同位置渲染 div 而非第二枚按钮），无四同构配对义务；8px 与同模块小矩形族（分页钮/prompt chip）一致。
- v3 修复的 36 组未触碰；`audit/v3-pair-harmony-audit.md` 全部结论不受影响（本批 diff 仅 1 行类名 token）。

## 5. 命令与退出码

```
npx tsc --noEmit                                                    → 退出码 0
node --test tests/botBrowserHomeEntryStatic.test.mjs tests/accentInkButtonText.test.mjs
        tests/appUpdateSilentFlowStatic.test.mjs tests/meDesktopSettings.test.mjs
        tests/panelPurityPass2Wiring.test.mjs tests/panelPurityPass3Wiring.test.mjs
        tests/panelPurityPass5Wiring.test.mjs tests/coworkSteerUi.test.mjs
        tests/memoryContactsObserverIdentity.test.mjs               → 66 tests / 66 pass / 0 fail，退出码 0
npx tsx --test tests/coworkComposerImageAttachment.test.tsx tests/emojiPickerComposer.test.tsx
        tests/nftAvatarUi.test.tsx tests/metabotsChanged.test.ts
        tests/a2aMessageItem.test.tsx tests/groupTaskAvatarOpenBotPage.test.tsx
                                                                    → 75 tests / 75 pass / 0 fail，退出码 0
npx tsx --test tests/trafficPointsStrict.test.mjs tests/trafficAccountService.test.mjs
                                                                    → 63 tests / 63 pass / 0 fail，退出码 0
npx eslint src/renderer/components/metaapps/MetaAppsManager.tsx     → 退出码 0
node --test tests/meIncrementPack.test.mjs（基线对照：stash 改动后于干净 v3 HEAD 复跑）
                                                                    → 两次同样失败，退出码 1 ×2 —— 既有失败，非本批引入
```

- 既有失败说明：`meIncrementPack.test.mjs` 的「credits & traffic tab hosts two sub-pages」断言期望 Settings.tsx 存在 `import TrafficSettings from './traffic/TrafficSettings'` 静态导入，现实代码为 `React.lazy(() => import(...))`。与 v3 报告登记的「70 tests / 69 pass / **1 fail**」为同一枚；基线对照（stash 后复跑）证明与 v4 改动无关。属测试期望漂移，修复超出本批授权（改测试 = 另一轮施工），登记移交。
- 受影响测试同步：唯一读取改动文件的测试 `botBrowserHomeEntryStatic.test.mjs` 只断言逻辑接线（chain community/tab 序/onOpenBotInBrowser），不钉作者钮圆角类 → 66/66 通过，无需同步修改。

## 6. 范围与禁触核验

- `git diff --stat` = 仅 `MetaAppsManager.tsx` 1 file / +1 −1；**index.css 零改动**；**BotBrowserModeSwitch / HomeSidebar / WorkspaceRail / main.ts / MacWindowLights 零触碰**（MacWindowLights:96 仅登记，未修改）。
- 全库范围外计数：mobile-shell 0 / METAAPPs 0 / public 0 / e2e 0 / sandbox 0 / scripts 0 / dsh-runtime 0 / index.css 0 / tailwind.config 0；src/main、src/agentpedia-core 0。src/mobile/app 11 处（状态点×4、头像×4、语音条×1、图标钮×1、未读徽章×1）按同判据逐条目验全部属维持类，登记不改（不在 census 宇宙）。

## 7. Mon-decision（存疑项移交）

1. **12px 档 vs 8/10px 档菜单**：七样本现处 `var(--rounded)`=12px（v3 白名单档、owner 已验收）。v4 判据只强制「胶囊→矩形」，未要求全局重档；若 owner 意图是「标准按钮一律 10px」，需对 v3 修复的 36 组及全部 btn-idchat 类族另行一轮重档施工（估 25+ 文件），本批未动。
2. **「可点击但无文字」的边界**：22 处（16 开关轨道+5 头像钮+1 禁触）按判据维持圆形。若 owner 要「一切可点击元素都带棱角」（含 iOS 式开关轨道），是新裁定，请明示。
3. **展示徽章 71 处（带文字但不可点）**：判据两半只成立文字半 → 维持圆形。若连静态文字 chip 也要棱角化，同样需新裁定（数量大，建议单独批次）。
4. **MetaBot Twin 开关滑块 shadow-md**（metaBotCardPresentation.js:29）：v3 存续的物理滑块拟物阴影，v3 未列为违规；仅登记，不动。
5. **meIncrementPack 测试期望漂移**（§5）：建议后续把断言更新为接受 lazy 导入，或恢复静态导入——归属 Settings 加载策略决策，非按钮议题。

## 8. 交付物（均未提交，不 commit 不 push）

- 代码：`src/renderer/components/metaapps/MetaAppsManager.tsx`（+1 −1，rounded-full → rounded-[var(--shape-radius-sm)]）
- 对照表：`audit/v4-rejudge-table.md`（288 行逐条）；机读 `audit/v4-rejudge-prechange.json`（改判前全量）/ `audit/v4-rejudge.json`（改后树）
- 工具链：`audit/v4-scan.cjs` / `audit/v4-triage.cjs` + `audit/v4-triage.json` / `audit/v4-rejudge.cjs`
- 本报告：`audit/v4-pill-purge-report.md`

## 9. 追加工单（owner 23:21 实测样本：积分增量包「购买积分」×「查看获得详情」一胖一瘦）

### 9.1 命名对子修复（MeIncrementPackCard.tsx:118/125）

- 根因 = v3 审计 §0 已记录的机制死角：`.btn-idchat-primary-filled` 类族规则位于 `@tailwind utilities` 之后，`购买积分` 上书写的 `px-3 py-1.5 rounded-xl` 是**死工具类**，实际渲染 = 家族的 py-2 px-4 / 12px（高胖）；`查看获得详情` 走字面工具类（矮瘦）。v3 配对审计比对**类名字符串**（两者字面同几何），看不见家族覆写——加上 v3 扫描器在该文件解析失败（scan-report-after 记为「1 钮 no-cls」），此组从未进入审计。
- 修法（v3「黄主自绘降档」先例，LongTermTaskDetail L534 同档串）：购买积分 → 摘除类族、自绘黄主（`rounded-[var(--shape-radius-md)] border border-[var(--btn-primary-edge)] bg-claude-accent text-claude-accentInk px-3 py-1.5 text-xs font-medium hover:brightness-[0.96] active:brightness-[0.9] transition-[filter]`）；查看获得详情 → `rounded-xl→md` 对档 + 清 `active:scale-[0.98]`。四同：10px/px-3/py-1.5/1px 描边全同，唯一差异=填充与文字色。

### 9.2 顺手发现并修复：v3 遗留死类 `bg-claude-primary`（5 处）

tailwind 编译探针实证：`.bg-claude-accent`/`.bg-primary` 均编译为 `var(--color-primary)`（黄），**`.bg-claude-primary` 零输出**（claude 命名空间无 primary 键）——LongTermTaskDetail ×4、MemorySettings ×1 的 v3 自绘黄主实际**无填充**。已全部换 `bg-claude-accent`。index.css 无手写兜底（grep=0）。

### 9.3 同容器并排按钮组全量复扫（v4 有效几何审计）

新工具 `audit/v4-pair-audit.cjs`：TypeScript AST 抽全库 **961 个 `<button`**（v3 扫描器只抓到 361——其引号敏感的开标签截取对模板字符串类名失效），对每钮解**有效几何**（家族覆写叠加模型）+ 父容器同容器判定（同一父 JsxElement 直接相邻），四同（圆角/内边距/描边/高度）+ 位移禁令逐对核对。

- 原始候选 86 对 → **确定性修复 56 处改动、32 文件**（+73/−73，纯类名改写）：
  - 家族死工具类胖瘦对自绘降档 ×19（Settings/AgentGameConsentCard/A2AApprovalBar/GigSquare×5/McpServerFormModal/KnowledgeBasePanel×2/MetaBotCreateForm/MetaBotEditTabs/PreferenceSealConfirmModal/TaskForm/MemorySettings×2/SkillsManager×2）
  - 填充钮补 1px 描边 ×23（红→border-red-600、emerald→border-emerald-600、黄→border-[var(--btn-primary-edge)]；含 MetaBotNftWalletModal 九组、SkillsManager×2 二次过）
  - **红底灰字→红底白字 ×3**（McpManager:622、ProjectsManager:269、SkillsManager:1031/1073 两处为 v3 #23 同款漏网）
  - 位移残留清除 ×15（Settings/CoworkConversationSearch/CoworkSessionDetail/IMSettings×8/UserBackupMnemonicModal/Settings 红钮）
  - 字号/内边距对齐 ×4（KnowledgeBasePanel 取消×删除 text-xs→text-sm、UserBackupMnemonicModal 复制钮升 px-4 py-2 text-sm、PaymentReceivingSettings 黄钮 px-4→px-3、SkillScopeEditor 双分支模板重写）
- 复扫残差 **31 对，全部登记为合规**：图标钮 vs 文字钮跨域（A2A 消息浮层/GigSquare/LongTermTaskDetail 图标）、行点击 wrapper vs 动作钮（MetaTask/GigSquareServiceCard/CoworkSessionList）、链接态文字钮 vs 实体钮（PaymentCard/NewGroupTaskModal/UserSettings 等）、变量类串假阳性（ProjectFormModal ghostButtonClass、MetaBotEditTabs clearActionClass、MetaAppDetailModal btnBase——逐一读源核实同几何）、WelcomeFlow hero 双钮（`btn-welcome-primary` 2px 描边+4px 偏移影为 v2 已核准设计，index.css 注释明示）、双分支双态孪生（CoworkPermissionOverlay/LongTermTaskDetail 确认态分支，逐分支 token 相同）。

### 9.4 追加工单验证（命令与退出码）

```
npx tsc --noEmit                → 0（中途曾 2：两个脚本编辑在同 span/跨行残尾处打坏 JSX——
                                   PaymentReceivingSettings 尾巴、UserBackupMnemonicModal 吞行，
                                   手工精修后归零，diff 可复核）
npx eslint（触及 32 文件全量）    → 退出码 0
node --test ×9 文件              → 66 pass / 0 fail，退出码 0
npx tsx --test ×6 文件           → 75 pass / 0 fail，退出码 0
npx tsx --test（traffic ×2）     → 63 pass / 0 fail，退出码 0
tailwind 编译探针（bg-claude-primary 死类证实）→ .bg-claude-primary 零输出
配对复扫：86 → 31（31 全登记合规，零未裁决）
rounded-full 全库计数：287（追加工单零触碰胶囊面）
```

### 9.5 追加 Mon-decision

6. **WelcomeFlow hero 例外**：`btn-welcome-primary`（2px 描边+4px 偏移影）与同屏 text-button 不同构——系 v2 已核准的 hero 设计（index.css 注释背书）。若 owner 现在要 hero 也扁平化，请明示（会改 index.css，需解禁）。
7. **红底灰字是 v3 漏网模式**：v3 #23 只修了 MetaBotDeleteConfirmModal 一处；v4 复扫在同款写法上又抓到 3 处（已修）。建议后续审计把「填充钮文字色=gray-900」列入机扫规则。
8. **审计工具升级**：v4 有效几何扫描器（AST+家族覆写+同容器判定）已可全量复跑，建议取代 v3 的字符串比对扫描器作为后续按钮审计基线（v3 扫描器漏抓 600 钮、且看不见家族覆写）。
