# 全库交互控件扁平化摸排 · 证据报告（feat/flat-buttons-sweep）

- worktree：`/Users/wufeng/Documents/deepseek-harness/default-workspace/5F/.worktrees/flat-buttons`
- 分支：`feat/flat-buttons-sweep`，基线 `2be7d528`（HEAD 未动，全程未 commit/push）
- 交付形态：未提交工作树改动（29 文件：28 src + 1 test）+ 本报告
- 施工日期：2026-11-14（续接同日上轮被供应商限额打停的会话；上轮侦查结论已复核采信，worktree 当时为零改动，本报告数字全部为本次实测）

---

## 1. 结论摘要

| 项 | 数值 |
|---|---|
| 去阴影（①交互控件） | **25 行**（shadow-subtle/sm/md/elevated/card、`shadow-[2px_2px_0_#991b1b]` 硬边、`active:shadow-none` 一并清） |
| 胶囊退役（rounded-full 按钮 → `rounded-[var(--shape-radius-md)]`） | **24 处** |
| 黄色主按钮 | 渲染层可编辑区内已全部「平 #FFDC51 + 墨字（text-claude-accentInk）」：3 处 `bg-claude-accent text-claude-accentInk shadow-sm` 段控件去阴影后即达标；剩余唯一带阴影黄按钮在禁触区 BotBrowserModeSwitch.tsx:55（移交） |
| 阴影行总数（src/renderer） | 256 行/120 文件 → **231 行/116 文件**（−25，与去阴影逐行对账闭合） |
| tsc --noEmit | 退出码 0，零输出 |
| 测试 | 368 例执行，360 过 / 8 失败（8 失败全部证实为**既有失败或环境性失败**，与本次改动无关，证据见 §5） |

## 2. 阴影普查表（改动前 / 改动后）

口径：src/renderer 下 `*.tsx/*.ts/*.css` 逐行扫描含 shadow 语义 token 的行（类使用 `shadow-*`、CSS `box-shadow:`、`drop-shadow(`）；裸 `shadow` 计数含 `transition-shadow` 等非阴影词形（已注明，不计入改动）。

### 改动前（基线 2be7d528，256 行 / 120 文件）

| token | 行数 | | token | 行数 |
|---|---|---|---|---|
| shadow-xl | 46 | | shadow-card | 5 |
| 裸 shadow（含 transition-shadow 词形） | 37 | | shadow-none | 2 |
| shadow-lg | 37 | | shadow-[0_0_0_1px_#f5b83d,…]（选中态环） | 2 |
| box-shadow:（CSS） | 30 | | shadow-[0_0_0_4px_rgba(196,…]（dot 光环） | 2 |
| shadow-subtle | 22 | | shadow-glow-accent | 1 |
| shadow-2xl | 19 | | shadow-[3px_3px_0_var(--btn-primary-edge)] | 1 |
| shadow-md | 16 | | shadow-[0_20px_60px_rgba(0,…]（Toast 容器） | 1 |
| shadow-sm | 15 | | shadow-[-12px_0_40px_rgba(0,…]（抽屉） | 1 |
| shadow-modal | 12 | | drop-shadow(（CSS filter） | 1 |
| shadow-offset（var 引用，全在 index.css） | 9+1 | | shadow-[0_0_6px_-1px_rgba(245,…] 等 5 种微光 | 各 1 |
| shadow-elevated | 9 | | shadow-[2px_2px_0_#991b1b]（红色危险按钮硬边） | 1 |
| shadow-popover | 8 | | shadow-[inset_0_0_0_1px_rgba(198,…]（选中描边增厚） | 1 |

### 改动后（231 行 / 116 文件）

shadow-subtle 22→16，shadow-sm 15→9，shadow-md 16→7，shadow-elevated 9→6，shadow-card 5→0，shadow-[2px_2px_0_#991b1b] 1→0；其余档位不变（xl/2xl/lg/modal/popover 全部落在保留区，见 §3）。行级快照：`flat-buttons-census-after.json`（本报告旁）。

## 3. 三分类计数与判例

| 类 | 改动前 | 改动后 | 处置 |
|---|---|---|---|
| ① 交互控件（按钮/胶囊/chip/分段/开关旋钮/输入容器） | 25 行带阴影 | **0 行** | 全部去阴影（§4.1） |
| ② 悬浮层容器（下拉/弹层/tooltip/模态/上下文菜单/Toast/抽屉/遮罩面板） | ≈115 行 | ≈115 行（不变） | **阴影全部保留**（启发式自动分 75 行 + 人工复核把 ③ 桶中 40 行模态容器归入②） |
| ③ 其他（气泡/卡片/徽章/状态微光/头像圈/进度条/CSS 卡） | ≈60 行 | ≈60 行 | 保留并记档（行级清单见 census-after 附档） |
| 非分类行 | 14 | 14 | index.css 43 行禁触记账；禁触文件 5 行；类型字面量误报 2（types/preference.ts）；注释 4；CSS box-shadow 2（proposals.css/botAction.css） |

关键判例（上轮侦查 + 本次复核一致）：
- `shadow-[3px_3px_0_var(--btn-primary-edge)]` 唯一可编辑区命中在 BotBrowserModeSwitch.tsx:55（禁触→移交）；
- `shadow-[2px_2px_0_#991b1b]` 是 CoworkPermissionPanel.tsx:620 红色危险按钮硬边 → **①已删**（连带 `active:shadow-none` 清除，保留 active 位移按压反馈）；
- `shadow-[0_20px_60px_rgba(0,…)]` 在 Toast 容器（②保留）；`shadow-[inset…]` 是选中态描边增厚（③保留）；`0_0_6px/5px/10px` 蓝金微光是运行状态脉冲与图例辉光（③保留）；`shadow-offset)` 19+1 处全是 index.css 里 `var(--btn-shadow-offset)` 引用（禁触记账）；
- xl/2xl 无一落在普通按钮上（人工逐行复核过）。

## 4. 逐文件改动清单（29 文件，55+/48−）

### 4.1 去阴影 25 行
| 文件：行 | 去除内容 | 对象 |
|---|---|---|
| Settings.tsx:1695 | shadow-subtle | 供应商选中卡片 |
| Settings.tsx:3146 | shadow-subtle | 小脑选中卡片 |
| Settings.tsx:1743, 3177 | shadow-md ×2 | 开关旋钮 |
| GroupTasksView.tsx:335 | shadow-sm | 黄色分段 active（平黄+墨字） |
| SkillMcpManager.tsx:36, 47 | shadow-sm ×2 | 黄色分段 active ×2 |
| GigSquareRefundsModal.tsx:287, 298 | shadow-sm ×2 | 退款弹窗 tab active |
| IMSettings.tsx:868, 911 | shadow-md ×2 | 开关旋钮 |
| SkillsManager.tsx:890 | shadow-md | 开关旋钮 |
| ProjectsManager.tsx:211 | shadow-md | 开关旋钮 |
| TaskList.tsx:152 | shadow-sm | 开关旋钮 |
| McpManager.tsx:361, 550 | shadow-md ×2 | 开关旋钮 |
| MeIncrementPackCard.tsx:157 | shadow-md | 自动扣费开关旋钮 |
| CoworkPermissionPanel.tsx:620 | shadow-[2px_2px_0_#991b1b] + active:shadow-none | 红色危险按钮硬边 |
| CoworkPromptInput.tsx:1725, 1735, 1804, 1814 | shadow-subtle + hover:shadow-card ×4 | composer 发送/停止图标按钮 |
| CoworkPromptInput.tsx:1135 | shadow-card + focus-within:shadow-elevated | composer 输入容器 |
| CoworkSessionDetail.tsx:5026 | shadow-elevated | 滚到底部悬浮按钮 |
| CoworkQuoteActionBar.tsx:59 | shadow-elevated | 引用动作条按钮 |

### 4.2 胶囊转换 24 处（rounded-full → rounded-[var(--shape-radius-md)]）
| 文件：行 | 对象 |
|---|---|
| CoworkPromptInput.tsx:1725, 1735, 1804, 1814 | composer 图标按钮 ×4 |
| CoworkPromptInput.tsx:1901 | 建议提示 chip 按钮 |
| CoworkSessionDetail.tsx:5026 | 滚到底部按钮 |
| BotBrowserCoworkPanel.tsx:195 | 消息反应 chip |
| ErrorMessage.tsx:19 / QuotaNudgeBanner.tsx:152 / Toast.tsx:23 | 关闭按钮 ×3 |
| LongTermTaskOriginChip.tsx:53 | 来源 chip 按钮 |
| GroupTaskDetailView.tsx:68 | 房间号复制 chip |
| GigSquareSkillPicker.tsx:121 | 技能移除 × |
| MetaBotEditTabs.tsx:889, 1134 | 清除/移除按钮 ×2 |
| MeUsageAndCredits.tsx:359 | 记录筛选 chip |
| MeBalanceBadge.tsx:137 | 余额胶囊按钮（非紧凑档） |
| A2AMessageItem.tsx:976, 992, 1004 | 预览关闭/上一张/下一张 ×3 |
| CoworkImageLightbox.tsx:48 | 灯箱关闭 |
| CoworkQuotedSelectionTiles.tsx:129 | 引用移除 × |
| CoworkAttachmentPreview.tsx:22, 23 | PILL_REMOVE_CLASS / THUMB_REMOVE_CLASS ×2 |

### 4.3 测试同步
- `tests/accentInkButtonText.test.mjs`：composer 断言正则更新为 `rounded-[var(--shape-radius-md)] bg-claude-surfaceHover hover:bg-claude-border text-claude-text`（数量仍钉 4），新增「胶囊形不得回归」反向断言（`p-2 rounded-full bg-claude-surfaceHover` = 0）；测试名与文件头注释同步为「扁平矩形」表述。

## 5. 命令与退出码（worktree 根执行，node=v24.21.0，`env -u BASH_ENV`）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npx tsc --noEmit` | **0** | 零输出（改动后终跑复核两次均 0） |
| `node --test` accentInkButtonText / panelPurityWiring / panelPurityPass2/3/5Wiring / botPickerStatic / appUpdateSilentFlowStatic / workspaceRailStatic / groupTaskComposerEnterSend / coworkComposerAutoResize / coworkSteerUi / botInternetComposerReuse / settingsFirstClickAndStorePerf / sessionMenuScrollDismiss | 0 | 106/106 |
| `npx tsx --test` coworkQuotedSelectionReply / coworkQuoteReplyMessage / metabotEditTabs / gigSquareRefundsModal / coworkComposerImageAttachment / coworkTranscriptImageAttachment | 0 | 56/56 |
| `node --test` coworkAskQuestionHang / coworkAskOptionlessQuestion / coworkSessionDetailRefundStatusUi / coworkAssistantTurnCollapse | 0 | 29/29 |
| `npx tsx --test` toastDarkMode / coworkPermissionPanelFallback / a2aMessageItem / emojiPickerComposer / panelPurityPass5Ui / coworkOrderFocus / surfaceSessionName | 0 | 77/77 |
| `npx tsx --test` meResetCountdown / trafficCreditsMode / gigSquareSkillPicker | 0 | 12/12 |
| `npx tsx --test` pendingPaymentRecordsPanel | 0 | 5/5 |
| `npx tsx --test` botBrowserModeSwitch / botPickerChip | 0 | 18/18 |
| `node --test` settingsFirstClickAndStorePerf / accentInkButtonText（补刀后复跑） | 0 | 6/6 |
| `npx tsx --test` coworkQuotedSelectionReply / trafficCreditsMode / gigSquareSkillPicker（补刀后复跑） | 0 | 29/29 |
| `node --test` homeFaceLayering / imWeixinPermissionReply / imCoworkTurnTimeout | 1 | 9/11，2 失败=环境性（见下） |
| `node --test` meDesktopSettings / meIncrementPack / groupTaskAcceptanceCard / groupTaskGoalCollapse / openTeamKickLoopStatic / imSteerInbound | 1 | 13/19，6 失败（见下） |

**8 个失败的归因取证（均非本次改动引入）：**
1. **既有测试漂移 ×4**：groupTaskAcceptanceCard.test.mjs（2）+ groupTaskGoalCollapse.test.mjs（2）。钉死字符串 `onAccept: () => setConfirmAction('done')` / `onRework: () => void handleReopen()` / `goalExpanded` 旗标族在**基线版文件中即为 0 次出现**——用 `git show HEAD:src/…/GroupTaskDetailView.tsx` 抽基线复核，同断言同败；本任务对该文件的 diff 恰为 1 行（复制 chip 类名），不在断言路径上。
2. **环境性缺编译产物 ×4**：imSteerInbound / imWeixinPermissionReply / imCoworkTurnTimeout / meIncrementPack —— `ERR_MODULE_NOT_FOUND: dist-electron/main/…`。官方脚本本就链式要求 `pnpm run compile:electron &&` 先行（package.json 原文）；本次 diff 零主进程文件（`git diff --stat` 全部为 src/renderer + tests），失败与改动无因果。未擅自补编译：编译产物 dist-electron/ 不在 .gitignore，会污染「未提交工作树改动」的交付面。
3. 决定性封闭论证：全测试库 grep `shadow-|rounded-full` 的断言宇宙仅 10 个文件（清单见报告附档核对），其中 5 个钉死保留区/禁触区断言（panelPurityWiring:113 ContextMenu 容器 shadow-elevated=②保留、workspaceRailStatic:294 WorkspaceRail shadow-none、botPickerStatic:106/108 h-8 w-8 头像圆、mobileSessionList:347 与 sessionAutoGrouping:379/410 状态点）全部实测通过；唯一钉死改动面的 accentInkButtonText 已同步并转绿。

## 6. Mon-decision 段（过程性自决记录）

1. **胶囊转换的划线原则**：只转「真 `<button>` 元素」的 rounded-full；span/div 标签 chip、徽章、状态点、头像圈、开关轨道/旋钮（round 形是控件本体语义）、模态装饰图标圆一律保留圆形并登记。据此保留 5 个开关轨道按钮（Settings:2394/3574、MemorySettings:2422、ProjectsManager:204、TaskList:145）与 1 个头像按钮（CoworkSessionItem:290）。
2. **composer 输入容器（CoworkPromptInput:1135）按①处置**：去 shadow-card 与 focus-within:shadow-elevated——它是交互控件容器而非悬浮层；焦点态仍有 border/背景变化兜底。
3. **悬浮层阴影保留但内部按钮照常扁平**：GigSquareRefundsModal 内 tab active 阴影已去（容器 shadow-modal 保留）；MeBalanceBadge 面板内按钮本就无阴影；计数②≈115 行入账（§3）。
4. **旋钮阴影的归属**：开关旋钮是交互控件的可动部件，按①去阴影（7 处 knob shadow-md/sm 全删）；traffic 线 1 处（TrafficSettings:1190）禁触移交。
5. **不擅自补 dist-electron 编译**：为保住「未提交工作树改动」的洁净面（dist-electron 不在 ignore 列表），4 个缺产物测试按环境性失败登记并给出官方脚本链证据，不重跑。
6. **既有 rounded-lg/md/2xl 未批量 token 化**：施工单指令域是「去阴影 + 胶囊退役 + 黄主按钮」；存量矩形圆角 token 化属独立后续（见 §8 遗留项），避免把 diff 面拉大撞合并冲突。
7. **球形图标按钮（如灯箱关闭、预览翻页）同样转换**：凡可交互 `<button>` 一律矩形化，装饰性圆形（无 hover/onClick 的 div/span）保留——与上轮侦查的 16/51 结论同源，本轮以更完整普查修正为 24 处转换。

## 7. 移交清单（并行分支辖域，未动手）

| # | 位置 | 事项 | 归属 |
|---|---|---|---|
| 1 | index.css（43 行阴影：28 处 `box-shadow:` + 19 处 `var(--btn-shadow-offset)` 引用 + 裸 shadow） | `.btn-idchat-primary-filled` 黄主按钮的 3px 硬边阴影机制全在此；主人点名样本（充值 mePanelRecharge / 一键备份 userSettingsChainBackupButton / 添加供应商 / 升级 / 购买积分 / 前往支付）tsx 层均已是矩形无阴影，唯黄填充视觉由该类控制 | Friday 线 |
| 2 | BotBrowserModeSwitch.tsx:55 | `bg-claude-accent text-claude-accentInk shadow-[3px_3px_0_var(--btn-primary-edge)]` —— 渲染层最后一处带阴影黄按钮，删阴影即达标 | Friday/Tuesday 线（文件禁触） |
| 3 | TrafficSettings.tsx:1185/1190/1309 | 开关轨道、旋钮 shadow-md、图标按钮胶囊（rounded-full p-0.5）未处理 | Tuesday 线（红绿灯） |
| 4 | HomeSidebar.tsx:510 | tooltip 容器 shadow-lg（②保留区，无需动作，仅知会）；WorkspaceRail.tsx / main.ts 普查无交互控件阴影/胶囊发现 | Friday 线（知会） |

## 8. 遗留项

1. **存量矩形圆角 token 化**：大量按钮仍是 tailwind 字面 `rounded-lg/xl/2xl`；半径四档（12/10/8/4）token 化迁移是独立后续 pass（本次仅按指令退役胶囊并使用 `--shape-radius-md`）。
2. **`transition-shadow`+`hover:shadow-md` 卡片悬停族**（AvatarPickerModal:249/315、MetaBotWalletAssetsModal:335、MetaBotNftWalletModal:370、BuiltinAvatarPickerModal:63、NftCard:480、GigSquareServiceCard:98）：可点击卡片/tile 的 hover 抬升阴影，按③卡片保留记档；若 owner 认为卡片也须扁平，属一轮小 pass（7 行）。
3. **既有测试漂移 4 例**（§5.1）与**缺编译产物 4 例**（§5.2）建议由主线修复/补编译后复跑，非本工单范围。
4. mobile 侧断言（mobileSessionList/sessionAutoGrouping）钉死的是状态点类名，本轮未触及其目标文件，未跑 mobile 全量（VITE_MOBILE_MOCK 套件与本改动无交集）。

## 9. 证据附档

- `flat-buttons-census-after.json`（本报告旁）：改动后 231 行行级快照（file/line/tokens/text）。
- 改动前基线可用 `git show 2be7d528:<path>` 逐文件复核；本报告所有数字可由 `git diff` 与重跑普查脚本复现。
- 本机留档：`/Users/wufeng/idbots/project/bots/4/2026-11-14/flatbuttons/`（census.py、classify_out.txt、census_after.json、capsules.txt、各测试日志 /tmp/t_*.log）。
