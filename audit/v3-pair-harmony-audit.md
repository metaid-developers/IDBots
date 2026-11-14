# v3 成对同构审计报告（feat/flat-v3-pair-harmony）

日期：2026-11-14 深夜 · 施工：Wednesday/Mercury（Worker）· 委派：Twin
分支：`feat/flat-v3-pair-harmony` · 基于 Mon 的 v3 CSS 源头改动（index.css 未提交改动，本批零触碰）

## 0. 规格依据（index.css 头注释，Mon 已写入，本批只引用）

- 描边上限 1px（`--btn-border-width: 1px`）
- hover = brightness(0.96)；按压 = brightness(0.9) + 描边加深；一律无位移无阴影
- 禁用 = 透明度 0.6；暗色模式同规则
- 同模块成对按钮几何四同（高度/圆角/内边距/描边宽度），差异只允许填充色与文字色
  （黄=主动作 / 白=次动作 / 红=危险动作，红底白字同几何）
- 高度档：40/36/32/28；圆角白名单：var(--shape-radius-md) 或 var(--rounded)

**关键机制事实（影响全部判定）**：`.btn-idchat-*` 类族规则位于 `@tailwind utilities`
展开之后（index.css 注释明示「padding utilities cannot override it」），因此组件里写在
`btn-idchat-primary-filled` 之后的 `px-*/py-*/rounded-*/font-medium` **不生效**；类族实际
渲染 = padding 0.5rem 1rem、border-radius var(--rounded)=12px、font-weight 500、border
1px、禁用 opacity 0.6。`text-*` 类族未声明，组件里的字号类生效。修复方向：次按钮的
utility 对齐类族实际渲染值（py-2 px-4 = 0.5/1rem 等价；圆角写 rounded-[var(--rounded)]）。

## 1. 审计表（全库扫描 → 组判定）

扫描方法：脚本 `audit/scan-buttons.mjs`（361 个 `<button`、184 文件）抽取全部按钮类名 →
45 行内相邻不同类对（66 对候选）→ 逐对读源码判定是否「同模块共排真组」→ 四同构核对。
复扫（修复后）：`audit/scan-report-after.json`，真组不同构清零。

### 1.1 owner 点名三组（必修必查，全部发现不同构并已修复）

| 组 | 位置 | 修复前（次按钮 vs 主按钮实际渲染） | 修复 |
|---|---|---|---|
| 开通/升级套餐×充值 | `MeUsageAndCredits.tsx` 头部（充值主按钮×刷新） | 高 32 vs 28；圆角 12 vs 7.5；内边距 15/7.5 vs 11.25/5.6；字号 12 vs 11 | 刷新按钮 → `rounded-[var(--rounded)] px-4 py-2 text-xs border`（32 档）；主按钮清无效覆写类 |
| 一键备份×从链上恢复 | `UserSettings.tsx` 链备份区（纵向共排） | 高 32 vs 26；圆角 12 vs 11.25；内边距 15/7.5 vs 11.25/5.6；恢复按钮带 `active:scale-[0.98]` 位移违规 | 恢复按钮 → `rounded-[var(--rounded)] px-4 py-2`，清 scale |
| 备份助记词×切换账号×退出登录 | `UserSettings.tsx` 资料卡头部三联 | 退出登录红按钮无描边（0 vs 1px）+ 三枚 `active:scale-[0.98]`；圆角 rounded-xl 不在白名单 | 红按钮加 `border border-red-600`（红底红描边同几何）；三枚清 scale；圆角统一 var(--rounded) |

（「开通/升级套餐×充值」的另一实体 `MePurchaseFlow.tsx` 底部三按钮组 reopen/check/back
组内已同构；其主 CTA 与三按钮组不同 phase 不同容器，不构成共排组——审计表登记为合规。）

### 1.2 其余修复组（同模块共排不同构 → 已修）

| # | 文件 | 组 | 不同构点 → 修复 |
|---|---|---|---|
| 1 | UserSettings（备份助记词确认区） | 复制×备份确认 | 字号 12 vs 14、圆角 xl→白名单、清 scale；复制按钮升 36 档对齐 |
| 2 | UserSettings（登出确认弹窗） | 取消×红确认 | 红确认无描边 → 加 border-red-600；圆角白名单化 |
| 3 | UserSettings（创建/导入入口卡） | 两枚入口卡 | border-2 超上限 → border 1px；清 scale |
| 4 | UserSettings（ID 复制图标钮） | 单枚 | 清 active:scale（v3 违规） |
| 5 | UserSettings（S3 入口卡） | 单枚 | 清 active:scale-[0.995] |
| 6 | UserSettings（amber 重试×2） | 单枚各处 | 清 active:scale ×2 |
| 7 | Settings（模型页导入×导出） | 导入×导出 | 清 active:scale ×2（组内已同构） |
| 8 | Settings（数据目录钮） | 单枚 | 清 active:scale |
| 9 | Settings（模型页取消×保存） | 取消×主 | 取消圆角白名单化、清 scale |
| 10 | UpdateNotificationModal | 关闭×主 CTA | 两枚 hover:scale/active:scale 位移违规全清；主按钮清无效覆写 |
| 11 | AppUpdateModal（info/restart/downloading/error 四态） | 取消×主 ×4 | 次按钮 32 档→36 档（px-4 py-2）+ 圆角白名单 + 补 1px 描边；主按钮清无效覆写 ×4 |
| 12 | MyAppsTab（头部） | 刷新×发布 | 次按钮升 32 档 + 圆角白名单；主按钮清无效覆写 |
| 13 | MyAppsTab（行内 Run×Edit×Share） | 三联 | Edit/Share 22.5px→30px 对齐 Run 实际渲染；圆角 6px→var(--rounded) |
| 14 | CoworkPermissionPanel（问题向导） | 拒绝×批准 | 拒绝升 32 档 + 圆角白名单；主按钮清无效覆写 |
| 15 | CoworkPermissionPanel（工具批准，破坏分支） | 拒绝×红允许 | **border-2 违规 → 1px**；**active:translate 位移违规 → 清**；红按钮升 32 档 + 圆角白名单；非破坏分支清无效覆写 |
| 16 | MetaAppPublishForm（底部） | 取消×提交 | 取消升 36 档 + 圆角白名单；主按钮清无效覆写 |
| 17 | ProjectFormModal | ghost 取消×保存 | ghostButtonClass 常量升 32 档 + 圆角白名单；主按钮清无效覆写 |
| 18 | TrafficSettings（primary/ghost 常量对，全页十余处共排） | 主×次 | **primary 无描边 → 加 border-[var(--btn-primary-edge)]**；两常量圆角白名单化；primary hover:bg-accent/90 → brightness(0.96)+active 0.9 |
| 19 | MetaAppDetailModal（Run×Share×Edit×Delete 四联） | 四联 | Run 无描边 → 补 border-[var(--btn-primary-edge)]；hover:opacity-90 → brightness；四联圆角 → var(--shape-radius-md) |
| 20 | MetaBotTransferModal（step1/2/3 三组） | 取消×黄确认 ×3 | 三枚黄主按钮无描边 → 补 border-[var(--btn-primary-edge)]；hover:opacity-90 → brightness+active |
| 21 | MetaBotTokenTransferModal（三组） | 关闭/取消×黄确认 | 同上 + 次按钮补 hover 面色 |
| 22 | MetaBotRestoreMnemonicModal | 关闭×主（×3 态）×amber 重试 | 主按钮清无效覆写 ×3；关闭/amber 圆角白名单；hover:opacity → 面色 |
| 23 | MetaBotDeleteConfirmModal | 取消×红确认 | **红底灰字（text-gray-900）→ 红底白字**；补 border-red-600；圆角白名单；取消 hover 面色化 |
| 24 | MetaBotBackupMnemonicModal | 关闭（单枚） | 圆角白名单；hover:opacity → 面色 |
| 25 | GroupTaskItemMenu（归档确认弹窗） | 取消×归档 | 两枚补 1px 描边；圆角白名单；归档 hover:opacity → brightness |
| 26 | GigSquarePublishModal | 取消×btn-idchat-primary ×2 | 取消升 36 档 + 补描边 + 圆角白名单；主按钮清无效覆写 ×2 |
| 27 | GigSquareOrderModal（支付确认弹窗） | 关闭×btn-idchat-primary | 同上 |
| 28 | MemorySettings（知识条目行内 编辑×删除） | 两枚 | 圆角 rounded(3.75px) → var(--shape-radius-md)（组内已同构，白名单执法） |
| 29 | MemorySettings（知识编辑表单 取消×保存） | 取消×保存 | 保存类族 30px vs 取消 22.5px → 保存自绘降档（黄填充小主按钮），三枚统一 22.5px 档 |
| 30 | MemorySettings（事实编辑器 取消×保存） | 取消×保存 | 取消升 36 档 + 圆角白名单；主按钮清无效覆写 |
| 31 | LongTermTaskDetail（头部 pause/resume/complete/cancelTask） | 四联 | resume 类族 30px vs 其余 22.5px → resume/complete 自绘黄主降档（complete 同步由 emerald 换 v3 黄语义）；四联圆角 → var(--shape-radius-md)；描边全 1px |
| 32 | LongTermTaskDetail（Owner actions 组 openSession/editViaChat/begin/unblock/accept/reject/skip） | 七联 | openSession 类族 32px vs 其余 24.5px → 自绘黄主降档；accept 由 emerald 换黄主 + 补描边；七联圆角 → var(--shape-radius-md) |
| 33 | NewGroupTaskModal | 取消×提交 | 取消圆角 rounded-lg → var(--rounded) |
| 34 | CoworkConversationSearch（搜索关闭钮） | 单枚 | 清 active:scale-[0.96] |
| 35 | CoworkPromptInput（composer 图标钮 ×4） | 各处 | 清 active:scale-95 ×4 |
| 36 | ProviderTemplatePicker（返回钮） | 单枚 | 清 active:scale |

### 1.3 判定为合规（不改）的共排对（审计留痕）

- `MePurchaseFlow` 底部 reopen/check/back 三联：类名逐字相同，组内四同构 ✓（owner 2026-11-09 常显常可点 ruling 保留）
- 各 fee 下拉触发器+菜单项（MetaBotNftWalletModal / MetaBotTokenTransferModal / MetaBotTransferModal）：表单控件与菜单项，非操作按钮组
- 各模态右上角关闭图标钮 vs 底部 CTA：不同功能域（header 图标 vs footer 动作），非成对组
- SkillsManager 官方/社区安装钮、FolderSelectorPopover / InlineHtmlReportBlock 菜单项循环、MyAppsTab 列表行内 copy 图标钮、AvatarPickerModal 头部图标钮：map 循环或图标工具钮，天然同构
- TrafficSettings 的 ghost/primary 常量在使用处（L1162-1994）十余对共排：随常量修复自动同构
- Settings.tsx 其余单枚主 CTA（L2746/3963/4091）、App.tsx L1885、GroupTaskComposer 发送钮、LongTermTasksBoard 创建钮、PaymentReceivingSettings 保存钮：单枚无组

## 2. 修复统计

- 改动文件：25 个组件文件（+本报告与 audit/ 过程产物；index.css 零改动）
- 修复组：36 组（含 owner 点名 3 组）；其中红按钮描边/文字色修正 4 处、border-2→1px 1 处、
  emerald→v3 黄语义 3 枚、位移/缩放违规清除 17 处、hover:opacity→面色/brightness 9 处
- 类族按钮上的无效 utility 覆写清理：21 处（声明与实际渲染对齐，防未来 @layer 迁移回归）

## 3. 命令与退出码

```
npx tsc --noEmit                                    → 退出码 0（改动前基线亦 0）
node --test tests/accentInkButtonText.test.mjs
        tests/appUpdateSilentFlowStatic.test.mjs
        tests/meDesktopSettings.test.mjs
        tests/meIncrementPack.test.mjs
        tests/panelPurityPass2Wiring.test.mjs
        tests/panelPurityPass3Wiring.test.mjs
        tests/panelPurityPass5Wiring.test.mjs
        tests/coworkSteerUi.test.mjs
        tests/memoryContactsObserverIdentity.test.mjs
                                                    → 70 tests / 69 pass / 1 fail
npx tsx --test tests/coworkComposerImageAttachment.test.tsx
        tests/emojiPickerComposer.test.tsx
        tests/emojiPickerComposer.test.tsx（同文件去重不计）
        tests/nftAvatarUi.test.tsx
        tests/metabotsChanged.test.ts
        tests/trafficPointsStrict.test.mjs
        tests/trafficAccountService.test.mjs
                                                    → 102 tests / 102 pass / 0 fail
node --test tests/accentInkButtonText.test.mjs（改动前基线） → 0 fail
```

**唯一 fail 为既有失败（与本批无关，git stash 双向取证）**：
`tests/meIncrementPack.test.mjs` 的「credits & traffic tab hosts two sub-pages」断言
期望 `import TrafficSettings from './traffic/TrafficSettings';`（静态导入），但
Settings.tsx 现状是 `React.lazy(() => import('./traffic/TrafficSettings'))`。stash 本批
改动后基线同样 12 pass / 1 fail；`tests/providerTemplateCatalog.test.ts` 同一断言基线
亦红。断言与现状的偏差早于本批（TrafficSettings 改 lazy 的时间点在本批之前），未修——
修它需要把 Settings.tsx 导入结构改回静态，超出本批 UI 几何范围，登记 Mon-decision。

注：批跑时 `providerTemplateCatalog.test.ts` 的失败与上同一断言，两文件共享同一过期
断言模式；本批未触碰两文件的断言对象导入结构。

## 4. 存疑项（Mon-decision 段，交 owner 裁决，不挂 owner）

1. **绿按钮的色语义替换**：LongTermTaskDetail 的 complete/accept 由 emerald-600 白字改为
   v3 黄主（bg-claude-primary + ink 文字 + 1px 描边）。理由：验收标准三色语义无绿；
   且该组几何与黄主完全对齐。若 owner 想保留「绿色=完成」的独立语义，需在三色语义外
   补一条绿的定义，我再把填充色改回 emerald（几何不动）。
2. **行内紧凑组的降档方向**：MemorySettings 知识编辑、LongTermTaskDetail 头部/Owner
   actions 两组采用「主按钮自绘降档对齐紧凑行（24.5px/22.5px）」而非「次按钮升档到类族
   30/32px」。理由是信息密集列表保持紧凑；代价是这两处主动作不再走 btn-idchat 类族。
   若 owner 偏好「主动作必须走类族」，改为升档次按钮即可（我再调）。
3. **圆角白名单的组外残留**：规格白名单（var(--shape-radius-md)/var(--rounded)）只在
   「组内」执法；组外单枚按钮仍有大量 rounded-lg/rounded-xl（≈11.25px/7.5px）未动。
   全库统一收敛属下一轮 sweep 范畴。
4. **两处按钮域 shadow 残留**：`chat/NftCard.tsx` L250（徽章 span 的阴影 token）、
   `cowork/A2AMessageItem.tsx` L684（bot 头像按钮的投影）。均非标准几何按钮（徽章/头像），
   未按「无阴影」清除；若 owner 认为应全域无阴影，我下一批清除。
5. **过期断言**：meIncrementPack/providerTemplateCatalog 两测试对 TrafficSettings 静态
   导入的断言已与代码现状脱节（既有失败）。建议 owner 裁定：更新断言匹配 React.lazy，
   或恢复静态导入。
6. **hover 反馈的基准面**：非类族黄主按钮本批统一为 brightness(0.96)/active 0.9（与类族
   数值一致）；白次按钮统一 hover:bg-surfaceHover 面色。若 owner 希望「描边加深」也进入
   非类族按压反馈（类族按压有 border-color 加深），我给自绘主按钮补 active:border 加深。

## 5. 交付态

- 未提交工作树改动（不 commit、不 push）；`git status --porcelain` 25 文件组件改动
  + index.css（Mon 原有，未触碰）+ audit/ 过程产物 + 本报告
- 禁触清单零触碰：BotBrowserModeSwitch / HomeSidebar / WorkspaceRail / main.ts /
  MacWindowLights（grep 复核：HomeSidebar.tsx 与 main.ts 无 diff）
