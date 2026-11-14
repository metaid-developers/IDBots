# 全库胶囊按钮全量清退第二轮 · 证据报告（feat/full-capsule-sweep）

- worktree：`/Users/wufeng/Documents/deepseek-harness/default-workspace/5F/.worktrees/capsule-sweep-r2`
- 分支：`feat/full-capsule-sweep`，基线 `eb3c579f`（主干最新：含三线合并 `7e2b9220` 与灯控热修；HEAD 未动）
- Mon 裁决（cross_session_message 2026-11-14 21:5x，三条均为 Twin 职权）：**M1=方案(a) 解禁直改 index.css**（.btn-idchat-primary-filled 414–438 段：删 3px 硬边阴影与 hover 位移，hover 改面色微变）；**M2=AppUpdateBadge 维持矩形**；**M3=MetaAppsManager 作者 chip 回退圆形、登记②**。三条均已执行（§3A/§7）
- 交付形态：**未提交工作树改动（3 文件：index.css 解禁段 + 2 个 src tsx / rounded-full 类名 3 处）+ 本报告 + 伴生普查 JSON**；全程未 commit、未 push
- 施工日期：2026-11-14 21:33–21:52（Asia/Shanghai）；所有数字为本次实测

---

## 1. 结论摘要

| 项 | 数值 |
|---|---|
| 基线总量（eb3c579f 实测） | **291 处 / 112 文件**（任务书口径 289 的对账见 §2） |
| ① 可点击控件退役胶囊 | **3 处 / 2 文件**（rounded-full → `rounded-[var(--shape-radius-md)]`；Mon M3 裁决后 MetaAppsManager:369 已回退圆形不计入） |
| ① 禁触-移交 | **1 处**（MacWindowLights.tsx:103 窗控灯点，未动） |
| ② 标签徽章类保留 | **210 处**（chip 徽章 80、chip 标签形态(MonM3) 1、状态点 47、头像圈 45、开关轨道 18、开关滑块 15、可点击头像圈 4）——逐文件登记见 §4 与伴生 JSON |
| ③ 其他类保留 | **77 处**（进度/装饰 11、其他装饰 65、禁触装饰条 1）——逐文件登记见 §4 |
| 合计对账 | 3 + 1 + 210 + 77 = **291** ✓ |
| index.css 解禁段（Mon M1） | `.btn-idchat-primary-filled` 删 3px 硬边阴影与 hover/press 位移，hover/press 改相对亮度面色微变（§3A） |
| 改动后总量 | **288 处**（291 − 3；M3 回退后与 diff 逐行对账闭合） |
| 黄底胶囊按钮 | **当前树已不存在几何黄胶囊**；62 处 rounded-full×黄底交叉命中全部为开关轨道/进度填充/状态点/chip（§5） |
| tsc --noEmit | 退出码 **0**，零输出 |
| 受影响测试（裁决后终态） | 四批共执行 **199 例**、198 过 / 1 失败；该 1 失败经主树同提交对照证实为**基线既有失败**，与本次改动零关联（§6.3） |

## 2. 基线对账：实测 291 与任务书 289 的差异来源

- 上轮（feat/flat-buttons-sweep）合并前总量 315 处（`git grep -c rounded-full ea60fd44` = 315）→ 合并后 291（`7e2b9220` = 291）：上轮清退 24 处 + 去阴影，与上轮报告对账闭合。
- 任务书基线 **289 = 291 − 2**：差值恰是 `src/renderer/components/metabots/metaBotCardPresentation.js`（**.js 文件，2 处**：开关轨道+滑块的 presentation helper）。基线口径按 .tsx 计数时漏计了 .js。本次按实况 **291 全量**普查（含该 2 处，归②开关轨道/滑块保留）。
- 按行计与按命中计同为 291（无同行多枚）。

## 3. ① 改动清单（Mon 裁决后全部 3 处，rounded-full → rounded-[var(--shape-radius-md)]）

| # | 文件:行 | 元素 | 判据 | 高度档 |
|---|---|---|---|---|
| 1 | `src/renderer/components/traffic/TrafficSettings.tsx:1309` | 流量页「资费说明」问号图标按钮（`<button type="button" onClick={setTariffOpen}>`） | button+onClick，字面①；此前 `rounded-full p-0.5` 是全库唯一残留的圆形图标按钮 | p-0.5+h-4 图标 ≈24px，图标微按钮非主/次按钮档，不适用 40/36/32/28，不动 |
| 2 | `src/renderer/components/update/AppUpdateBadge.tsx:86` | 更新徽章按钮 error 分支（`<button type="button" onClick={handleClick}>` 的 className 三元串） | button+onClick，字面①；徽章形态备注见 Mon-decision M2 | px-3 py-1 ≈26px，徽章按钮非主/次档，不动 |
| 3 | `src/renderer/components/update/AppUpdateBadge.tsx:87` | 同按钮 default 分支 | 同上；Mon M2 裁决确认维持矩形 | 同上 |

- **Mon M3 执行记录**：曾按字面①判据将 `MetaAppsManager.tsx:369`（作者 chip：头像+名字）改为矩形；Mon 裁决「它是标签不是按钮，保持圆形」→ **已回退为 `rounded-full`**（该文件回到与 HEAD 逐字节一致），登记为②chip 徽章（标签形态），见 §4。
- 黄底规则在①改动集内无适用对象：3 处均非 `bg-claude-accent` 系填充（问号按钮纯文本色、徽章为红/绿）。黄底主按钮的扁平化在 CSS 源头完成，见 §3A。
- 逐字 diff（3 行）：

```diff
--- a/src/renderer/components/traffic/TrafficSettings.tsx    (资费问号按钮)
-className="rounded-full p-0.5 …"
+className="rounded-[var(--shape-radius-md)] p-0.5 …"
--- a/src/renderer/components/update/AppUpdateBadge.tsx     (更新徽章按钮，三元两分支)
-…gap-1.5 rounded-full border border-red-500/30…
+…gap-1.5 rounded-[var(--shape-radius-md)] border border-red-500/30…
-…gap-1.5 rounded-full border border-emerald-500/30…
+…gap-1.5 rounded-[var(--shape-radius-md)] border border-emerald-500/30…
```

## 3A. index.css 解禁段改动（Mon M1，cross_session_message 裁决执行）

Mon 裁决 M1 = 方案 (a)：Friday 分支已并主干、无并行分支改 index.css，冲突风险不存在，授权直接修改 `.btn-idchat-primary-filled`（414–438 段）。**改动范围仅此一个类的三个规则块**，段外零触碰（`--btn-shadow-offset`/`--btn-move-range` 变量定义、`.btn-idchat`/`.btn-idchat-primary`、`.btn-welcome-primary` 等一概未动）。

| 项 | 改动前 | 改动后 |
|---|---|---|
| 静态阴影 | `box-shadow: var(--btn-shadow-offset) var(--btn-shadow-offset) 0 var(--btn-primary-edge)`（3px 硬边） | **删除** |
| hover（:not(.still):hover…） | 阴影加码 + `translateX/Y` 位移 | `filter: brightness(0.96)` 面色微变，**无位移无阴影** |
| active（:not(.still):active…） | 阴影回缩 + 反向位移 | `filter: brightness(0.9)` 按压面色变深，**无位移无阴影** |
| transition | `box-shadow .2s, transform .2s` | `filter 0.2s ease` |
| 保留 | 平黄 `var(--color-primary)=#FFDC51`、墨字 `#303133`、描边 `var(--btn-primary-edge)`、圆角/内距/字重 | 全部原样保留 |

- hover 方案说明：`claude-accentHover` 在 tailwind.config.js:44 即 `var(--color-primary)`（同色，无独立 hover token），故按 Mon 给出的「面色微变」采用**主题无关的相对亮度**（filter brightness），明暗两套主题下行为一致，不引入新 token、不动变量区。
- 影响面：owner 点名的六按钮（充值/保存/一键备份/备份助记词/切换账号/退出登录）及全部 `btn-idchat-primary-filled` 调用点（含 botBrowserHomeEntryStatic 所测 provider 卡主按钮）——「厚黄」观感源头消除，墨字钉死断言（accentInkButtonText.test.mjs:55 `color: #303133`）保持通过。
- 测试钉死点核查：`tests/` 对该类的钉死仅两处——类名存在性（botBrowserHomeEntryStatic:59）与墨色 `#303133`（accentInkButtonText:55），均不受本改动影响；无任何测试钉 `btn-shadow-offset`/`btn-move-range`。
- 段外登记：`.btn-welcome-primary`（首跑欢迎页主按钮）沿用同族「offset-shadow identity」，**不在 Mon 裁决范围**，未动，登记移交 T6。

## 4. 全量普查表（基线 291 处逐文件三分类）

分类口径（任务书原文执行）：①=可点击控件（button/a/role=button/onClick）；②=状态标签与徽章（chip/tag/badge/开关轨道/头像圈/状态点，非可点击）；③=其他。判读方法：291 处逐条提取所在 JSX 元素块（含完整开标签属性），逐桶人工复核（未判桶 76 条全部逐条看过源码上下文）。

| 文件 | 基线 | 分类明细 |
|---|---|---|
| src/renderer/components/update/AppUpdateBadge.tsx | 3 | ①改动×2, ②状态点×1 |
| src/renderer/components/metaapps/MetaAppsManager.tsx | 2 | ②chip徽章(标签形态-MonM3)×1, ②头像圈×1 |
| src/renderer/components/traffic/TrafficSettings.tsx | 5 | ①改动×1, ②开关轨道×1, ②开关滑块×1, ②chip徽章×2 |
| src/renderer/features/botBrowser/MacWindowLights.tsx | 1 | ①禁触-移交×1 |
| src/renderer/App.tsx | 4 | ②头像圈×2, ③进度/装饰×2 |
| src/renderer/components/HomeSidebar.tsx | 1 | ②状态点×1 |
| src/renderer/components/Settings.tsx | 20 | ②开关轨道×7, ②开关滑块×6, ②chip徽章×3, ②状态点×1, ②头像圈×1, ③其他装饰×2 |
| src/renderer/components/Sidebar.tsx | 2 | ②状态点×2 |
| src/renderer/components/SleepGuardBadge.tsx | 1 | ②状态点×1 |
| src/renderer/components/Toast.tsx | 1 | ③其他装饰×1 |
| src/renderer/components/UpdateNotificationModal.tsx | 1 | ③其他装饰×1 |
| src/renderer/components/agentGame/AgentGameConsentCard.tsx | 1 | ③其他装饰×1 |
| src/renderer/components/avatar/AvatarPickerModal.tsx | 1 | ③其他装饰×1 |
| src/renderer/components/chat/NftCard.tsx | 2 | ②头像圈×1, ③其他装饰×1 |
| src/renderer/components/cowork/A2AApprovalBar.tsx | 1 | ②状态点×1 |
| src/renderer/components/cowork/A2AMessageItem.tsx | 4 | ②头像圈×2, ②头像圈(可点击)×1, ③其他装饰×1 |
| src/renderer/components/cowork/AssistantActivityIndicator.tsx | 2 | ②头像圈×2 |
| src/renderer/components/cowork/BackgroundTasksBadge.tsx | 1 | ②状态点×1 |
| src/renderer/components/cowork/CoworkAttachmentPreview.tsx | 1 | ③其他装饰×1 |
| src/renderer/components/cowork/CoworkPermissionOverlay.tsx | 1 | ②头像圈×1 |
| src/renderer/components/cowork/CoworkPermissionPanel.tsx | 4 | ②状态点×3, ③其他装饰×1 |
| src/renderer/components/cowork/CoworkSessionDetail.tsx | 16 | ②状态点×8, ②头像圈×1, ②chip徽章×4, ③其他装饰×3 |
| src/renderer/components/cowork/CoworkSessionItem.tsx | 6 | ②头像圈×1, ②头像圈(可点击)×1, ②状态点×2, ③其他装饰×2 |
| src/renderer/components/cowork/CoworkSessionList.tsx | 2 | ②状态点×2 |
| src/renderer/components/cowork/FriendBadge.tsx | 1 | ②chip徽章×1 |
| src/renderer/components/cowork/InlineMetaAppBlock.tsx | 2 | ③其他装饰×2 |
| src/renderer/components/cowork/MetaBotSelector.tsx | 2 | ②状态点×2 |
| src/renderer/components/cowork/SubagentPanel.tsx | 2 | ②chip徽章×2 |
| src/renderer/components/cowork/ThinkingBlock.tsx | 2 | ②状态点×1, ③其他装饰×1 |
| src/renderer/components/cowork/TodoPanel.tsx | 2 | ③进度/装饰×1, ③其他装饰×1 |
| src/renderer/components/cowork/UserMessageOriginBadge.tsx | 1 | ②头像圈×1 |
| src/renderer/components/gigSquare/GigSquareHeaderActions.tsx | 1 | ②头像圈×1 |
| src/renderer/components/gigSquare/GigSquareMyServicesModal.tsx | 5 | ②chip徽章×3, ②头像圈×2 |
| src/renderer/components/gigSquare/GigSquareOrderModal.tsx | 1 | ②状态点×1 |
| src/renderer/components/gigSquare/GigSquarePublishModal.tsx | 2 | ②头像圈×1, ③其他装饰×1 |
| src/renderer/components/gigSquare/GigSquareRefundsModal.tsx | 4 | ②头像圈×1, ②chip徽章×2, ③其他装饰×1 |
| src/renderer/components/gigSquare/GigSquareServiceCard.tsx | 4 | ②chip徽章×2, ②状态点×1, ②头像圈×1 |
| src/renderer/components/gigSquare/GigSquareSkillPicker.tsx | 2 | ②chip徽章×1, ③其他装饰×1 |
| src/renderer/components/gigSquare/GigSquareView.tsx | 1 | ③其他装饰×1 |
| src/renderer/components/groupTasks/AcceptanceSummaryCard.tsx | 3 | ②chip徽章×3 |
| src/renderer/components/groupTasks/GroupTaskCloseConfirmModal.tsx | 1 | ②头像圈×1 |
| src/renderer/components/groupTasks/GroupTaskDetailView.tsx | 2 | ②chip徽章×2 |
| src/renderer/components/groupTasks/GroupTaskItemMenu.tsx | 1 | ③其他装饰×1 |
| src/renderer/components/groupTasks/GroupTaskKickConfirmModal.tsx | 1 | ②头像圈×1 |
| src/renderer/components/groupTasks/GroupTaskListMeta.tsx | 5 | ②头像圈×1, ②头像圈(可点击)×1, ②chip徽章×2, ③其他装饰×1 |
| src/renderer/components/groupTasks/GroupTaskMessageItem.tsx | 5 | ②头像圈(可点击)×1, ②头像圈×4 |
| src/renderer/components/groupTasks/GroupTaskSidebarList.tsx | 2 | ②chip徽章×2 |
| src/renderer/components/groupTasks/GroupTasksView.tsx | 1 | ②chip徽章×1 |
| src/renderer/components/groupTasks/OpenTeamCollabDetailView.tsx | 1 | ②chip徽章×1 |
| src/renderer/components/groupTasks/OpenTeamCollabSidebarRow.tsx | 1 | ②chip徽章×1 |
| src/renderer/components/groupTasks/OpenTeamCollabsSection.tsx | 2 | ②chip徽章×2 |
| src/renderer/components/im/IMSettings.tsx | 10 | ②开关轨道×2, ②开关滑块×2, ②chip徽章×4, ②状态点×2 |
| src/renderer/components/layout/WorkspaceRail.tsx | 1 | ③禁触-装饰条×1 |
| src/renderer/components/listenerHub/ListenerHubView.tsx | 2 | ②chip徽章×1, ②状态点×1 |
| src/renderer/components/longTermTasks/LongTermTaskCard.tsx | 2 | ③进度/装饰×2 |
| src/renderer/components/longTermTasks/LongTermTaskDetail.tsx | 6 | ②chip徽章×4, ③进度/装饰×2 |
| src/renderer/components/longTermTasks/LongTermTasksBoard.tsx | 1 | ②状态点×1 |
| src/renderer/components/longTermTasks/ParticipantAvatars.tsx | 3 | ②头像圈×1, ③其他装饰×2 |
| src/renderer/components/mcp/McpManager.tsx | 8 | ②chip徽章×3, ②开关轨道×2, ③其他装饰×3 |
| src/renderer/components/me/IdbotsPlanCard.tsx | 2 | ③进度/装饰×1, ③其他装饰×1 |
| src/renderer/components/me/MeBalanceBadge.tsx | 2 | ③进度/装饰×1, ③其他装饰×1 |
| src/renderer/components/me/MeBalanceOverviewCard.tsx | 1 | ②chip徽章×1 |
| src/renderer/components/me/MeIncrementPackCard.tsx | 2 | ②开关轨道×1, ②开关滑块×1 |
| src/renderer/components/me/MePurchaseFlow.tsx | 3 | ②chip徽章×2, ③其他装饰×1 |
| src/renderer/components/me/MeUsageAndCredits.tsx | 1 | ②chip徽章×1 |
| src/renderer/components/metaapps/myApps/ChainStatusModal.tsx | 1 | ③其他装饰×1 |
| src/renderer/components/metabots/BuiltinAvatarPickerModal.tsx | 1 | ③其他装饰×1 |
| src/renderer/components/metabots/DailyReportSection.tsx | 1 | ②chip徽章×1 |
| src/renderer/components/metabots/KnowledgeBasePanel.tsx | 1 | ②chip徽章×1 |
| src/renderer/components/metabots/MetaBotBackupMnemonicModal.tsx | 1 | ②头像圈×1 |
| src/renderer/components/metabots/MetaBotDeleteConfirmModal.tsx | 1 | ②头像圈×1 |
| src/renderer/components/metabots/MetaBotEditTabs.tsx | 2 | ③其他装饰×2 |
| src/renderer/components/metabots/MetaBotListCard.tsx | 1 | ②状态点×1 |
| src/renderer/components/metabots/MetaBotNftWalletModal.tsx | 3 | ③其他装饰×3 |
| src/renderer/components/metabots/MetaBotRestoreMnemonicModal.tsx | 1 | ②头像圈×1 |
| src/renderer/components/metabots/MetaBotTokenTransferModal.tsx | 2 | ③其他装饰×2 |
| src/renderer/components/metabots/MetaBotTransferModal.tsx | 2 | ③其他装饰×2 |
| src/renderer/components/metabots/MetabotsManager.tsx | 1 | ②状态点×1 |
| src/renderer/components/metabots/MetawebStudyJobsPanel.tsx | 1 | ②chip徽章×1 |
| src/renderer/components/metabots/NftAvatarFrame.tsx | 1 | ②chip徽章×1 |
| src/renderer/components/metabots/SurfReportsPanel.tsx | 3 | ②chip徽章×2, ②状态点×1 |
| src/renderer/components/metabots/TwinBadge.tsx | 1 | ②chip徽章×1 |
| src/renderer/components/metabots/metaBotCardPresentation.js | 2 | ②开关轨道×1, ②开关滑块×1 |
| src/renderer/components/metatask/MetaIdBadge.tsx | 2 | ②头像圈×1, ③其他装饰×1 |
| src/renderer/components/metatask/MetaTaskBoard.tsx | 2 | ③进度/装饰×1, ③其他装饰×1 |
| src/renderer/components/metatask/MetaTaskChainView.tsx | 7 | ②状态点×2, ③其他装饰×5 |
| src/renderer/components/metatask/MetaTaskDetail.tsx | 1 | ②状态点×1 |
| src/renderer/components/metatask/MetaTaskNodeSections.tsx | 2 | ③其他装饰×2 |
| src/renderer/components/onboarding/WelcomeFlow.tsx | 4 | ②状态点×1, ③其他装饰×3 |
| src/renderer/components/preference/PreferenceSealConfirmModal.tsx | 1 | ②头像圈×1 |
| src/renderer/components/projects/ProjectsManager.tsx | 2 | ②开关轨道×1, ②开关滑块×1 |
| src/renderer/components/scheduledTasks/DeleteConfirmModal.tsx | 1 | ②头像圈×1 |
| src/renderer/components/scheduledTasks/TaskList.tsx | 2 | ②开关轨道×1, ②开关滑块×1 |
| src/renderer/components/settings/CapabilityDraftsPanel.tsx | 2 | ②chip徽章×2 |
| src/renderer/components/settings/DreamTelemetryPanel.tsx | 1 | ②状态点×1 |
| src/renderer/components/settings/MemorySettings.tsx | 19 | ②chip徽章×17, ②开关轨道×1, ②开关滑块×1 |
| src/renderer/components/settings/MetaIDContactPanel.tsx | 4 | ②chip徽章×4 |
| src/renderer/components/skills/SkillScopeEditor.tsx | 2 | ②状态点×1, ③其他装饰×1 |
| src/renderer/components/skills/SkillsManager.tsx | 2 | ②开关轨道×1, ②开关滑块×1 |
| src/renderer/components/update/AppUpdateModal.tsx | 4 | ②状态点×1, ③其他装饰×3 |
| src/renderer/components/update/UpdateChangeLogPanel.tsx | 1 | ②状态点×1 |
| src/renderer/components/user/ChainBackupMnemonicReminderModal.tsx | 1 | ②头像圈×1 |
| src/renderer/components/user/ChainBackupRestorePrompt.tsx | 1 | ②头像圈×1 |
| src/renderer/components/user/UserBackupMnemonicModal.tsx | 1 | ②头像圈×1 |
| src/renderer/components/user/UserSettings.tsx | 4 | ②头像圈×3, ③其他装饰×1 |
| src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx | 3 | ②状态点×3 |
| src/renderer/features/botBrowser/BotPickerChip.tsx | 2 | ②头像圈×2 |
| src/renderer/features/botBrowser/CoworkHistoryPanel.tsx | 1 | ②状态点×1 |
| src/renderer/features/botBrowser/CoworkSurfaceIdentityBadge.tsx | 2 | ②头像圈×2 |
| src/renderer/features/botBrowser/PanelDelegationStatusRow.tsx | 2 | ②头像圈×2 |
| src/renderer/features/botBrowser/PanelMessageLocatorRail.tsx | 3 | ③其他装饰×3 |
| src/renderer/features/userProfile/MeCreditsPanel.tsx | 2 | ③进度/装饰×1, ③其他装饰×1 |
注：`①改动`=本次已改；`①禁触-移交`=MacWindowLights.tsx:103 窗控灯点（禁触区，未动）；`②头像圈(可点击)`=按钮语义是头像本身（点击打开 Bot 页），按任务书「头像圈」明文保留圆形；`③禁触-装饰条`=WorkspaceRail.tsx:111 当前位置指示条（禁触区，未动）；`②chip徽章(标签形态-MonM3)`=MetaAppsManager.tsx:369 作者 chip，Mon 裁决其为标签保持圆形（本报告施工中曾改矩形、已回退）。每处的行级明细见伴生文件 `capsule-sweep-r2-census.json`（291 条：file/line/category）。

## 5. owner 点名样本逐一面核

| 样本 | 落点 | rounded-full 现状 | 判定 |
|---|---|---|---|
| 我的页·充值 | `features/userProfile/MeCreditsPanel.tsx:170`（`data-slot="user-profile-me-recharge"`） | **0 处**；类为 `btn-idchat-primary-filled flex-1 rounded-lg` | 已矩形；黄底+墨字达标；阴影真源已按 Mon M1 于 §3A 修复 |
| 我的页·保存 | `components/user/UserSettings.tsx:781` | **0 处**；`btn-idchat-primary-filled px-4 py-2` | 同上（§3A 已修） |
| 我的页·一键备份 | `UserSettings.tsx:1134`（`userSettingsChainBackupButton`） | **0 处**；`btn-idchat-primary-filled shrink-0 px-4` | 同上（§3A 已修） |
| 我的页·备份助记词 | `UserSettings.tsx:856/928`（`userSettingsBackupMnemonic`） | **0 处**；`btn-idchat-primary-filled` | 同上（§3A 已修） |
| 我的页·切换账号 | `UserSettings.tsx:1273`（`userSettingsSwitchAccount`） | **0 处**；`btn-idchat-primary-filled px-3 py-1.5` | 同上（§3A 已修） |
| 我的页·退出登录 | `UserSettings.tsx`（`userSettingsLogout` 区段） | **0 处**；同族样式 | 同上（§3A 已修） |
| 流量设置 `TrafficSettings.tsx`（5 处） | 1185 开关轨道② / 1190 开关滑块② / 1309 **①已改** / 1731 amber chip② / 另一进度② | 见 §4 | |
| 记忆设置 `MemorySettings.tsx`（19 处） | 17×chip②、1×开关轨道②、1×开关滑块② | 无①（面板内无残留可点击胶囊） | |
| 群任务族 `groupTasks/*`（26 处） | 状态点/进度/chip/头像圈②③为主；`GroupTaskListMeta.tsx:117`、`GroupTaskMessageItem.tsx:225` 为可点击头像圈②保留 | 无其他① | |
| Settings 主面板 `Settings.tsx`（20 处） | 开关轨道×6+滑块×5②、进度②③、chip②、状态点②、初始字母圆② | 无① | |
| `PaymentReceivingSettings.tsx` | **0 处 rounded-full**（普查未命中） | 无可改对象 | |
| `UserProfilePage.tsx` / `MeUsageAndCredits.tsx` | `MeUsageAndCredits` 1 处=chip②；`UserProfilePage` 0 处 | 无① | |

**owner「我的页看到黄胶囊」的实测解释与处置**：六按钮全部走 `btn-idchat-primary-filled`（index.css:414–438）——填充 `var(--color-primary)=#FFDC51` ✓、墨字 `#303133` ✓、圆角 `var(--rounded)=12px`（**非几何胶囊**），类原自带 `3px 3px 0 var(--btn-primary-edge)` 硬边偏移阴影与 hover/active 位移，视觉上即 owner 所见的「厚黄按钮」。**Mon M1 裁决解禁后，本轮已在 CSS 源头删除该阴影与位移（§3A），六按钮观感问题闭环**——重启 dev 后即可目验。

**黄底×rounded-full 交叉全扫**（62 处命中，逐条过目）：全部为开关轨道/进度条填充/状态点/chip/装饰圆，**零黄底胶囊按钮**——owner 二次裁定中「全库还有 289 处 rounded-full」的存量里已无任何一处是「黄色胶囊形按钮」。

## 6. 验证证据（命令原文 + 退出码）

### 6.1 计数对账
```
grep -rno 'rounded-full' src/renderer --include='*.tsx' --include='*.ts' --include='*.jsx' --include='*.js' --include='*.css' --include='*.html' | wc -l
# 改动前: 291   改动后: 288   （rounded-full 类名 diff = 2 文件 3 行；index.css 解禁段不含 rounded-full；逐行对账闭合）
```

### 6.2 类型检查
```
export PATH=/Users/wufeng/devtools/node-v24.21.0-darwin-arm64/bin:$PATH
env -u BASH_ENV npx tsc --noEmit
# 裁决前（4 处施工态）: 退出码 0，零输出
# 裁决后（M1 CSS + M3 回退终态）: 再次运行，退出码 0，零输出
```

### 6.3 受影响测试（环境 PATH 同上，`env -u BASH_ENV` 前缀）
| 命令 | 退出码 | 结果 |
|---|---|---|
| `node --test tests/appUpdateSilentFlowStatic.test.mjs tests/trafficPointsStrict.test.mjs tests/trafficAccountService.test.mjs tests/accentInkButtonText.test.mjs tests/botPickerStatic.test.mjs tests/homeFaceLayering.test.mjs tests/workspaceRailStatic.test.mjs tests/panelPurityWiring.test.mjs tests/workspaceRailDestinations.test.mjs tests/metaAppSidebar.test.mjs tests/botBrowserHomeEntryStatic.test.mjs tests/metaAppBundleEntry.test.mjs` | **0** | 150 pass / 0 fail |
| `node --test tests/trafficPointsStrict.test.mjs tests/trafficAccountService.test.mjs`（worktree 首跑，取证留档） | 1 | 2 文件级失败：`ERR_MODULE_NOT_FOUND dist-electron/.../mvcSponsorCreatePin.js` —— worktree 从未编译 dist-electron 的**环境性失败**（非回归）；在 worktree 内补跑 `npx -p typescript@5 tsc --project electron-tsconfig.json`（退出码 0）+ `node scripts/copy-electron-js.cjs`（退出码 0）后复跑 → **63 pass / 0 fail，退出码 0**（含 trafficPointsStrict:419 对 TrafficSettings.tsx 源码的静态断言，直接覆盖我的改动） |
| `npx tsx --test tests/trafficCreditsMode.test.ts tests/botBrowserModeSwitch.test.tsx tests/sessionAutoGrouping.test.ts tests/botPickerChip.test.tsx`（裁决前首批，取证留档） | 1 | 49 例：48 pass / 1 fail；唯一失败 `botBrowserModeSwitch.test.tsx:344` 断言 **main.ts（禁触区）** 的 `setWindowButtonVisibility` 旧代码形态——**主树同提交 pristine eb3c579f 对照复跑同样 15 pass / 1 fail（退出码 1）**，证实为基线既有失败（热修 eb3c579f 改了 main.ts，测试正则未跟上），与本次改动零关联 |
| **裁决后终态复跑** 同 12 件 .mjs 批次 | **0** | 150 pass / 0 fail（含钉死 index.css 墨色 #303133 的 accentInkButtonText、读取 btn-idchat 用法的 botBrowserHomeEntryStatic） |
| **裁决后终态复跑** `npx tsx --test tests/trafficCreditsMode.test.ts tests/sessionAutoGrouping.test.ts tests/botPickerChip.test.tsx` | **0** | 33 pass / 0 fail |
| **裁决后终态复跑** `npx tsx --test tests/botBrowserModeSwitch.test.tsx` | 1 | 16 例：15 pass / 1 fail（同一基线既有失败；main.ts 本轮零触碰，与裁决改动无关） |
| **终态合计** | — | **199 例执行 / 198 pass / 1 fail（基线既有）** |

**断言宇宙全量重查**：`tests/` 中含 `rounded-full`/`shadow-` 的全部 11 个测试文件逐一过目——所有钉死点或为**反向断言**（旧胶囊模式计数=0，如 accentInkButtonText.test.mjs:71、homeFaceLayering.test.mjs:176），或钉在本次未触碰的②保留元素上（botPickerStatic:106/108 头像圈、botBrowserModeSwitch:422 禁触灯点、sessionAutoGrouping:379/410 未读红点、mobileSessionList:347 mobile 侧）。**零测试需要同步更新**（没有断言钉死我改掉的 3 处类名串与 index.css 解禁段；`btn-shadow-offset`/`btn-move-range` 在 tests/ 零钉死）。

读取被改文件的测试全集已闭环：`tests/` 引用 `TrafficSettings.tsx`/`AppUpdateBadge.tsx` 的 4 件（trafficPointsStrict、appUpdateSilentFlowStatic、botBrowserHomeEntryStatic、trafficCreditsMode）全部通过；MetaAppsManager.tsx 经 M3 回退后与 HEAD 逐字节一致，其读取方（metaAppSidebar 等）在批次内通过。

**残留扫描（防漏改，M3 回退后口径）**：改后对每一处剩余 rounded-full 重提取元素块扫描 button/onClick/role=button/a/cursor-pointer 信号（排除禁触 MacWindowLights）——命中 21 处，逐条比对全部为刻意保留：任务书明文②类开关轨道 16、可点击头像圈 4，外加 Mon M3 裁决保留的作者标签 chip 1（MetaAppsManager:369）。**①集合无遗漏**。

## 7. Mon 裁决与执行记录（原 Mon-decision 段；2026-11-14 21:5x cross_session_message 三条裁决，全部执行完毕）

| 项 | Mon 裁决 | 执行 |
|---|---|---|
| M1 | 方案 (a)：解禁直改 index.css `.btn-idchat-primary-filled`（414–438 段），删 3px 硬边 box-shadow 与 hover 位移，保留平黄填充与墨字，hover 改面色微变、不做位移 | **已执行**：§3A——静态阴影删除、hover=`brightness(0.96)`、active=`brightness(0.9)`、transition 改 filter；段外零触碰；报告单列「index.css 解禁段改动」段 ✓ |
| M2 | AppUpdateBadge 徽章按钮是可点击控件，按按钮规则改矩形（10px 圆角、无阴影） | **确认维持**：§3 #2/#3 两处矩形改动原样保留 ✓ |
| M3 | MetaAppsManager 作者 chip 是标签不是按钮，保持圆形，登记入保留清单 | **已执行**：`:369` 回退 `rounded-full`（文件与 HEAD 逐字节一致），登记②chip 徽章（标签形态-MonM3），见 §4 ✓ |

## 8. 移交清单（禁触区发现，零触碰）

| # | 位置 | 发现 | 建议 |
|---|---|---|---|
| T1 | `src/renderer/index.css:414–438` | `.btn-idchat-primary-filled` 硬边阴影+位移 | **已处置**：Mon M1 解禁，本轮 §3A 修复 |
| T2 | `src/renderer/features/botBrowser/MacWindowLights.tsx:103` | 窗控灯点 `<button>` 带 `rounded-full`（可点击但语义=macOS 红黄绿灯圆点，改造会破坏隐喻）；禁触未动 | 保持现状即可 |
| T3 | `src/renderer/index.css:571,700,717` | 3 处 `border-radius: 9999`（Tailwind 类名口径之外的同义胶囊，禁触未动） | 下轮若扩口径可复查 |
| T4 | `src/renderer/features/proposals/proposals.css:1` | `border-radius:50%`（圆形装饰，非控件） | 无需动作 |
| T5 | `src/renderer/features/botBrowser/BotBrowserModeSwitch.tsx` | 上轮遗留胶囊+硬边阴影已在合并主干时清退（当前仅存注释，**零命中**） | 无需动作 |
| T6 | `src/renderer/index.css:443+`（`.btn-welcome-primary`） | 首跑欢迎页主按钮沿用同族「offset-shadow identity」（4px 档，注释自述 per the approved design）——**不在 Mon M1 裁决范围**，未动 | 需 Twin/owner 表态是否同轮扁平化 |

## 9. 纪律声明

- 禁触区 6 文件中 5 个（BotBrowserModeSwitch.tsx、HomeSidebar.tsx、WorkspaceRail.tsx、main.ts、MacWindowLights.tsx）**零改动**；index.css **仅 Mon M1 明示授权的解禁段**（`.btn-idchat-primary-filled` 三个规则块）被改，该文件段外（含 `--btn-shadow-offset`/`--btn-move-range` 变量区、`.btn-welcome-primary`、571/700/717 的 border-radius:9999）零触碰——git diff 可逐行复核。
- 未 commit、未 push；主树与其他 worktree 只读（对照取证只在主树跑测试，未写任何文件；主树 `?? package-lock.json` mtime=今晨 10:47，早于本会话 11 小时，非本会话产物）。
- worktree 内新增编译产物 `dist-electron/`（gitignore 覆盖，不进 diff；为使 traffic 静态断言可执行而补建）。
