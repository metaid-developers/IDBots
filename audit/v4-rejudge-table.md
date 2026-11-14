# v4 胶囊清退重判对照表（census 288 处发生点 → v4 判定，逐条）

- 对位：TypeScript AST 按发生点绝对偏移（occOffsets）↔ census v2 文本序逐条对位，288/288 零错位（对账脚本 audit/v4-scan.cjs + audit/v4-rejudge.cjs）。
- 行号 = feat/flat-v4-pill-purge 当前树；〔游离位〕= className 初始化器外的发生点（frameClassName 透传 / 字符串常量）。
- 唯一改判：MetaAppsManager.tsx:357（census ②chip徽章(标签形态-MonM3)，即 v2 MonM3 回退登记的那枚）→ ①改矩形，已实施 rounded-[var(--shape-radius-sm)]。

| # | 文件:行 | census判(v2) | v4重判 | 依据 |
|---|---|---|---|---|
| 1 | App.tsx:143 | ②头像圈 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 2 | App.tsx:146 | ③进度/装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 3 | App.tsx:147 | ③进度/装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 4 | App.tsx:1879 | ②头像圈 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 5 | components/HomeSidebar.tsx:510 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 6 | components/Settings.tsx:1727 | ②开关轨道 | ②维持-开关轨道 | 可点击但无文字：w/h 对+transition-colors 开关轨道(owner 保留类) |
| 7 | components/Settings.tsx:1742 | ③其他装饰 | ②维持-开关滑块 | 无文字不可点：bg-white/translate-x 滑块 |
| 8 | components/Settings.tsx:2350 | ②开关轨道 | ②维持-开关轨道 | 可点击但无文字：w/h 对+transition-colors 开关轨道(owner 保留类) |
| 9 | components/Settings.tsx:2381 | ②开关滑块 | ②维持-开关滑块 | 无文字不可点：bg-white/translate-x 滑块 |
| 10 | components/Settings.tsx:2394 | ②开关轨道 | ②维持-开关轨道 | 可点击但无文字：w/h 对+transition-colors 开关轨道(owner 保留类) |
| 11 | components/Settings.tsx:2395 | ②开关滑块 | ②维持-开关滑块 | 无文字不可点：bg-white/translate-x 滑块 |
| 12 | components/Settings.tsx:2417 | ②开关轨道 | ②维持-开关轨道 | 可点击但无文字：w/h 对+transition-colors 开关轨道(owner 保留类) |
| 13 | components/Settings.tsx:2448 | ②开关滑块 | ②维持-开关滑块 | 无文字不可点：bg-white/translate-x 滑块 |
| 14 | components/Settings.tsx:2466 | ②开关轨道 | ②维持-开关轨道 | 可点击但无文字：w/h 对+transition-colors 开关轨道(owner 保留类) |
| 15 | components/Settings.tsx:2497 | ②开关滑块 | ②维持-开关滑块 | 无文字不可点：bg-white/translate-x 滑块 |
| 16 | components/Settings.tsx:2732 | ③其他装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 17 | components/Settings.tsx:2877 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 18 | components/Settings.tsx:2954 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 19 | components/Settings.tsx:3034 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 20 | components/Settings.tsx:3173 | ②开关轨道 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 21 | components/Settings.tsx:3177 | ②开关滑块 | ②维持-开关滑块 | 无文字不可点：bg-white/translate-x 滑块 |
| 22 | components/Settings.tsx:3480 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 23 | components/Settings.tsx:3568 | ②开关轨道 | ②维持-开关轨道 | 可点击但无文字：w/h 对+transition-colors 开关轨道(owner 保留类) |
| 24 | components/Settings.tsx:3580 | ②开关滑块 | ②维持-开关滑块 | 无文字不可点：bg-white/translate-x 滑块 |
| 25 | components/Settings.tsx:3769 | ②头像圈 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 26 | components/Sidebar.tsx:794 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 27 | components/Sidebar.tsx:893 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 28 | components/SleepGuardBadge.tsx:63 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 29 | components/Toast.tsx:14 | ③其他装饰 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 30 | components/UpdateNotificationModal.tsx:46 | ③其他装饰 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 31 | components/agentGame/AgentGameConsentCard.tsx:51 | ③其他装饰 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 32 | components/avatar/AvatarPickerModal.tsx:258 | ③其他装饰 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 33 | components/chat/NftCard.tsx:270 | ②头像圈 | ②维持-头像圈(可点击) | 可点击头像，无可见文字 |
| 34 | components/chat/NftCard.tsx:280 | ③其他装饰 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 35 | components/cowork/A2AApprovalBar.tsx:48 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 36 | components/cowork/A2AMessageItem.tsx:669〔游离位〕 | ②头像圈 | ②维持-头像圈(常量/透传) | frameClassName/avatarClass 头像框透传或常量，非元素本体样式 |
| 37 | components/cowork/A2AMessageItem.tsx:671 | ②头像圈 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 38 | components/cowork/A2AMessageItem.tsx:684 | ②头像圈(可点击) | ②维持-头像圈(可点击) | 子节点=NftAvatarFrame头像元素({image})，无可见文字；aria-label只是无障碍标签 |
| 39 | components/cowork/A2AMessageItem.tsx:967 | ③其他装饰 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 40 | components/cowork/AssistantActivityIndicator.tsx:385〔游离位〕 | ②头像圈 | ②维持-头像圈(常量/透传) | frameClassName/avatarClass 头像框透传或常量，非元素本体样式 |
| 41 | components/cowork/AssistantActivityIndicator.tsx:386 | ②头像圈 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 42 | components/cowork/BackgroundTasksBadge.tsx:65 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 43 | components/cowork/CoworkAttachmentPreview.tsx:75 | ③其他装饰 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 44 | components/cowork/CoworkPermissionOverlay.tsx:180 | ②头像圈 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 45 | components/cowork/CoworkPermissionPanel.tsx:452 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 46 | components/cowork/CoworkPermissionPanel.tsx:490 | ③其他装饰 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 47 | components/cowork/CoworkPermissionPanel.tsx:491 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 48 | components/cowork/CoworkPermissionPanel.tsx:570 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 49 | components/cowork/CoworkSessionDetail.tsx:559 | ③其他装饰 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 50 | components/cowork/CoworkSessionDetail.tsx:1096 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 51 | components/cowork/CoworkSessionDetail.tsx:1133 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 52 | components/cowork/CoworkSessionDetail.tsx:1134 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 53 | components/cowork/CoworkSessionDetail.tsx:1135 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 54 | components/cowork/CoworkSessionDetail.tsx:2112 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 55 | components/cowork/CoworkSessionDetail.tsx:2113 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 56 | components/cowork/CoworkSessionDetail.tsx:2114 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 57 | components/cowork/CoworkSessionDetail.tsx:2339 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 58 | components/cowork/CoworkSessionDetail.tsx:4661〔游离位〕 | ②头像圈 | ②维持-头像圈(常量/透传) | frameClassName/avatarClass 头像框透传或常量，非元素本体样式 |
| 59 | components/cowork/CoworkSessionDetail.tsx:4665 | ③其他装饰 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 60 | components/cowork/CoworkSessionDetail.tsx:4705 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 61 | components/cowork/CoworkSessionDetail.tsx:4710 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 62 | components/cowork/CoworkSessionDetail.tsx:4715 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 63 | components/cowork/CoworkSessionDetail.tsx:4725 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 64 | components/cowork/CoworkSessionDetail.tsx:4897 | ③其他装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 65 | components/cowork/CoworkSessionItem.tsx:216 | ③其他装饰 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 66 | components/cowork/CoworkSessionItem.tsx:219〔游离位〕 | ②头像圈 | ②维持-头像圈(常量/透传) | frameClassName/avatarClass 头像框透传或常量，非元素本体样式 |
| 67 | components/cowork/CoworkSessionItem.tsx:227 | ③其他装饰 | ②维持-头像圈 | 无文字不可点：object-cover/overflow-hidden 头像 |
| 68 | components/cowork/CoworkSessionItem.tsx:284 | ②头像圈(可点击) | ②维持-可点击无文字(图标/装饰) | 可点击无文字，按判据不强制矩形 |
| 69 | components/cowork/CoworkSessionItem.tsx:702 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 70 | components/cowork/CoworkSessionItem.tsx:718 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 71 | components/cowork/CoworkSessionList.tsx:714 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 72 | components/cowork/CoworkSessionList.tsx:767 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 73 | components/cowork/FriendBadge.tsx:12 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 74 | components/cowork/InlineMetaAppBlock.tsx:542 | ③其他装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 75 | components/cowork/InlineMetaAppBlock.tsx:563 | ③其他装饰 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 76 | components/cowork/MetaBotSelector.tsx:251 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 77 | components/cowork/MetaBotSelector.tsx:275 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 78 | components/cowork/SubagentPanel.tsx:122 | ②chip徽章 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 79 | components/cowork/SubagentPanel.tsx:127 | ②chip徽章 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 80 | components/cowork/ThinkingBlock.tsx:65 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 81 | components/cowork/ThinkingBlock.tsx:69 | ③其他装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 82 | components/cowork/TodoPanel.tsx:145 | ③进度/装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 83 | components/cowork/TodoPanel.tsx:146 | ③其他装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 84 | components/gigSquare/GigSquareHeaderActions.tsx:32 | ②头像圈 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 85 | components/gigSquare/GigSquareMyServicesModal.tsx:909 | ②chip徽章 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 86 | components/gigSquare/GigSquareMyServicesModal.tsx:916 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 87 | components/gigSquare/GigSquareMyServicesModal.tsx:1106 | ②头像圈 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 88 | components/gigSquare/GigSquareMyServicesModal.tsx:1112 | ②头像圈 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 89 | components/gigSquare/GigSquareMyServicesModal.tsx:1118 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 90 | components/gigSquare/GigSquareOrderModal.tsx:896 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 91 | components/gigSquare/GigSquarePublishModal.tsx:619 | ③其他装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 92 | components/gigSquare/GigSquarePublishModal.tsx:621 | ②头像圈 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 93 | components/gigSquare/GigSquareRefundsModal.tsx:107 | ②头像圈 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 94 | components/gigSquare/GigSquareRefundsModal.tsx:113 | ③其他装饰 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 95 | components/gigSquare/GigSquareRefundsModal.tsx:134 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 96 | components/gigSquare/GigSquareRefundsModal.tsx:391 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 97 | components/gigSquare/GigSquareServiceCard.tsx:153 | ②chip徽章 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 98 | components/gigSquare/GigSquareServiceCard.tsx:161 | ②chip徽章 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 99 | components/gigSquare/GigSquareServiceCard.tsx:186 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 100 | components/gigSquare/GigSquareServiceCard.tsx:188 | ②头像圈 | ②维持-头像圈(可点击) | 可点击头像，无可见文字 |
| 101 | components/gigSquare/GigSquareSkillPicker.tsx:105 | ③其他装饰 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 102 | components/gigSquare/GigSquareSkillPicker.tsx:113 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 103 | components/gigSquare/GigSquareView.tsx:327 | ③其他装饰 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 104 | components/groupTasks/AcceptanceSummaryCard.tsx:64 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 105 | components/groupTasks/AcceptanceSummaryCard.tsx:68 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 106 | components/groupTasks/AcceptanceSummaryCard.tsx:73 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 107 | components/groupTasks/GroupTaskCloseConfirmModal.tsx:55 | ②头像圈 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 108 | components/groupTasks/GroupTaskDetailView.tsx:676 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 109 | components/groupTasks/GroupTaskDetailView.tsx:680 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 110 | components/groupTasks/GroupTaskItemMenu.tsx:315 | ③其他装饰 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 111 | components/groupTasks/GroupTaskKickConfirmModal.tsx:39 | ②头像圈 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 112 | components/groupTasks/GroupTaskListMeta.tsx:79〔游离位〕 | ②头像圈 | ②维持-头像圈(常量/透传) | frameClassName/avatarClass 头像框透传或常量，非元素本体样式 |
| 113 | components/groupTasks/GroupTaskListMeta.tsx:84 | ③其他装饰 | ②维持-头像圈 | 无文字不可点：object-cover/overflow-hidden 头像 |
| 114 | components/groupTasks/GroupTaskListMeta.tsx:105 | ②头像圈(可点击) | ②维持-头像圈(可点击) | 子节点={body}=纯头像(NftAvatarFrame/头像span)，圆内首字母是头像fallback非按钮文字 |
| 115 | components/groupTasks/GroupTaskListMeta.tsx:220 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 116 | components/groupTasks/GroupTaskListMeta.tsx:224 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 117 | components/groupTasks/GroupTaskMessageItem.tsx:215 | ②头像圈(可点击) | ②维持-可点击无文字(图标/装饰) | 可点击无文字，按判据不强制矩形 |
| 118 | components/groupTasks/GroupTaskMessageItem.tsx:229〔游离位〕 | ②头像圈 | ②维持-头像圈(常量/透传) | frameClassName/avatarClass 头像框透传或常量，非元素本体样式 |
| 119 | components/groupTasks/GroupTaskMessageItem.tsx:230 | ②头像圈 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 120 | components/groupTasks/GroupTaskMessageItem.tsx:237〔游离位〕 | ②头像圈 | ②维持-头像圈(常量/透传) | frameClassName/avatarClass 头像框透传或常量，非元素本体样式 |
| 121 | components/groupTasks/GroupTaskMessageItem.tsx:238 | ②头像圈 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 122 | components/groupTasks/GroupTaskSidebarList.tsx:216 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 123 | components/groupTasks/GroupTaskSidebarList.tsx:223 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 124 | components/groupTasks/GroupTasksView.tsx:147 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 125 | components/groupTasks/OpenTeamCollabDetailView.tsx:215 | ②chip徽章 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 126 | components/groupTasks/OpenTeamCollabSidebarRow.tsx:62 | ②chip徽章 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 127 | components/groupTasks/OpenTeamCollabsSection.tsx:105 | ②chip徽章 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 128 | components/groupTasks/OpenTeamCollabsSection.tsx:166 | ②chip徽章 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 129 | components/im/IMSettings.tsx:856 | ②开关轨道 | ②维持-开关轨道 | 可点击但无文字：w/h 对+transition-colors 开关轨道(owner 保留类) |
| 130 | components/im/IMSettings.tsx:867 | ②开关滑块 | ②维持-开关滑块 | 无文字不可点：bg-white/translate-x 滑块 |
| 131 | components/im/IMSettings.tsx:898 | ②开关轨道 | ②维持-开关轨道 | 可点击但无文字：w/h 对+transition-colors 开关轨道(owner 保留类) |
| 132 | components/im/IMSettings.tsx:910 | ②开关滑块 | ②维持-开关滑块 | 无文字不可点：bg-white/translate-x 滑块 |
| 133 | components/im/IMSettings.tsx:943 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 134 | components/im/IMSettings.tsx:955 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 135 | components/im/IMSettings.tsx:955 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 136 | components/im/IMSettings.tsx:960 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 137 | components/im/IMSettings.tsx:960 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 138 | components/im/IMSettings.tsx:1782 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 139 | components/layout/WorkspaceRail.tsx:111 | ③禁触-装饰条 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 140 | components/listenerHub/ListenerHubView.tsx:132 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 141 | components/listenerHub/ListenerHubView.tsx:135 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 142 | components/longTermTasks/LongTermTaskCard.tsx:121 | ③进度/装饰 | ③维持-进度/装饰条 | 无文字不可点：进度/指示条 |
| 143 | components/longTermTasks/LongTermTaskCard.tsx:122 | ③进度/装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 144 | components/longTermTasks/LongTermTaskDetail.tsx:164 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 145 | components/longTermTasks/LongTermTaskDetail.tsx:296 | ③进度/装饰 | ③维持-进度/装饰条 | 无文字不可点：进度/指示条 |
| 146 | components/longTermTasks/LongTermTaskDetail.tsx:297 | ③进度/装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 147 | components/longTermTasks/LongTermTaskDetail.tsx:393 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 148 | components/longTermTasks/LongTermTaskDetail.tsx:397 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 149 | components/longTermTasks/LongTermTaskDetail.tsx:435 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 150 | components/longTermTasks/LongTermTasksBoard.tsx:105 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 151 | components/longTermTasks/ParticipantAvatars.tsx:23〔游离位〕 | ②头像圈 | ②维持-头像圈(常量/透传) | frameClassName/avatarClass 头像框透传或常量，非元素本体样式 |
| 152 | components/longTermTasks/ParticipantAvatars.tsx:25 | ③其他装饰 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 153 | components/longTermTasks/ParticipantAvatars.tsx:34 | ③其他装饰 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 154 | components/mcp/McpManager.tsx:238〔游离位〕 | ③其他装饰 | ③维持-装饰条 | McpManager tab 指示条(h-0.5 底部下划线) |
| 155 | components/mcp/McpManager.tsx:263 | ②chip徽章 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 156 | components/mcp/McpManager.tsx:272 | ②chip徽章 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 157 | components/mcp/McpManager.tsx:281 | ②chip徽章 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 158 | components/mcp/McpManager.tsx:354 | ②开关轨道 | ②维持-开关轨道 | 可点击但无文字：w/h 对+transition-colors 开关轨道(owner 保留类) |
| 159 | components/mcp/McpManager.tsx:360 | ③其他装饰 | ②维持-开关滑块 | 无文字不可点：bg-white/translate-x 滑块 |
| 160 | components/mcp/McpManager.tsx:543 | ②开关轨道 | ②维持-开关轨道 | 可点击但无文字：w/h 对+transition-colors 开关轨道(owner 保留类) |
| 161 | components/mcp/McpManager.tsx:549 | ③其他装饰 | ②维持-开关滑块 | 无文字不可点：bg-white/translate-x 滑块 |
| 162 | components/me/IdbotsPlanCard.tsx:162 | ③进度/装饰 | ③维持-进度/装饰条 | 无文字不可点：进度/指示条 |
| 163 | components/me/IdbotsPlanCard.tsx:163 | ③其他装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 164 | components/me/MeBalanceBadge.tsx:201 | ③进度/装饰 | ③维持-进度/装饰条 | 无文字不可点：进度/指示条 |
| 165 | components/me/MeBalanceBadge.tsx:202 | ③其他装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 166 | components/me/MeBalanceOverviewCard.tsx:61 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 167 | components/me/MeIncrementPackCard.tsx:145 | ②开关轨道 | ②维持-开关轨道 | 可点击但无文字：w/h 对+transition-colors 开关轨道(owner 保留类) |
| 168 | components/me/MeIncrementPackCard.tsx:156 | ②开关滑块 | ②维持-开关滑块 | 无文字不可点：bg-white/translate-x 滑块 |
| 169 | components/me/MePurchaseFlow.tsx:605 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 170 | components/me/MePurchaseFlow.tsx:609 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 171 | components/me/MePurchaseFlow.tsx:883 | ③其他装饰 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 172 | components/me/MeUsageAndCredits.tsx:330 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 173 | components/metaapps/MetaAppsManager.tsx:338 | ②头像圈 | ②维持-头像圈(可点击) | 可点击头像，无可见文字 |
| 174 | components/metaapps/MetaAppsManager.tsx:357 | ②chip徽章(标签形态-MonM3) | ①改矩形 | 承载作者名文字+onClick(BotBrowser跳转)→按钮；改 rounded-[var(--shape-radius-sm)](8px) |
| 175 | components/metaapps/myApps/ChainStatusModal.tsx:30 | ③其他装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 176 | components/metabots/BuiltinAvatarPickerModal.tsx:72 | ③其他装饰 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 177 | components/metabots/DailyReportSection.tsx:234 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 178 | components/metabots/KnowledgeBasePanel.tsx:491 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 179 | components/metabots/MetaBotBackupMnemonicModal.tsx:68 | ②头像圈 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 180 | components/metabots/MetaBotDeleteConfirmModal.tsx:86 | ②头像圈 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 181 | components/metabots/MetaBotEditTabs.tsx:1124 | ③其他装饰 | ②维持-展示徽章(容器不可点) | 文字在容器，点击来自内嵌钮(MetaBotEditTabs 技能chip，×钮已矩形) |
| 182 | components/metabots/MetaBotEditTabs.tsx:1175 | ③其他装饰 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 183 | components/metabots/MetaBotListCard.tsx:180 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 184 | components/metabots/MetaBotNftWalletModal.tsx:570 | ③其他装饰 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 185 | components/metabots/MetaBotNftWalletModal.tsx:806 | ③其他装饰 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 186 | components/metabots/MetaBotNftWalletModal.tsx:1057 | ③其他装饰 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 187 | components/metabots/MetaBotRestoreMnemonicModal.tsx:122 | ②头像圈 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 188 | components/metabots/MetaBotTokenTransferModal.tsx:265 | ③其他装饰 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 189 | components/metabots/MetaBotTokenTransferModal.tsx:316 | ③其他装饰 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 190 | components/metabots/MetaBotTransferModal.tsx:262 | ③其他装饰 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 191 | components/metabots/MetaBotTransferModal.tsx:327 | ③其他装饰 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 192 | components/metabots/MetabotsManager.tsx:713 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 193 | components/metabots/MetawebStudyJobsPanel.tsx:84 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 194 | components/metabots/NftAvatarFrame.tsx:149 | ②chip徽章 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 195 | components/metabots/SurfReportsPanel.tsx:151 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 196 | components/metabots/SurfReportsPanel.tsx:155 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 197 | components/metabots/SurfReportsPanel.tsx:208 | ②chip徽章 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 198 | components/metabots/TwinBadge.tsx:16 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 199 | components/metatask/MetaIdBadge.tsx:22 | ②头像圈 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 200 | components/metatask/MetaIdBadge.tsx:24 | ③其他装饰 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 201 | components/metatask/MetaTaskBoard.tsx:302 | ③进度/装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 202 | components/metatask/MetaTaskBoard.tsx:303 | ③其他装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 203 | components/metatask/MetaTaskChainView.tsx:400 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 204 | components/metatask/MetaTaskChainView.tsx:408 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 205 | components/metatask/MetaTaskChainView.tsx:473 | ③其他装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 206 | components/metatask/MetaTaskChainView.tsx:532 | ③其他装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 207 | components/metatask/MetaTaskChainView.tsx:542 | ③其他装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 208 | components/metatask/MetaTaskChainView.tsx:606 | ③其他装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 209 | components/metatask/MetaTaskChainView.tsx:607 | ③其他装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 210 | components/metatask/MetaTaskDetail.tsx:430 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 211 | components/metatask/MetaTaskNodeSections.tsx:227 | ③其他装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 212 | components/metatask/MetaTaskNodeSections.tsx:237 | ③其他装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 213 | components/onboarding/WelcomeFlow.tsx:71 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 214 | components/onboarding/WelcomeFlow.tsx:297 | ③其他装饰 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 215 | components/onboarding/WelcomeFlow.tsx:319 | ③其他装饰 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 216 | components/onboarding/WelcomeFlow.tsx:340 | ③其他装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 217 | components/preference/PreferenceSealConfirmModal.tsx:35 | ②头像圈 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 218 | components/projects/ProjectsManager.tsx:198 | ②开关轨道 | ②维持-开关轨道 | 可点击但无文字：w/h 对+transition-colors 开关轨道(owner 保留类) |
| 219 | components/projects/ProjectsManager.tsx:210 | ②开关滑块 | ②维持-开关滑块 | 无文字不可点：bg-white/translate-x 滑块 |
| 220 | components/scheduledTasks/DeleteConfirmModal.tsx:30 | ②头像圈 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 221 | components/scheduledTasks/TaskList.tsx:142 | ②开关轨道 | ②维持-开关轨道 | 可点击但无文字：w/h 对+transition-colors 开关轨道(owner 保留类) |
| 222 | components/scheduledTasks/TaskList.tsx:151 | ②开关滑块 | ②维持-开关滑块 | 无文字不可点：bg-white/translate-x 滑块 |
| 223 | components/settings/CapabilityDraftsPanel.tsx:59 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 224 | components/settings/CapabilityDraftsPanel.tsx:63 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 225 | components/settings/DreamTelemetryPanel.tsx:133 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 226 | components/settings/MemorySettings.tsx:1076 | ②chip徽章 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 227 | components/settings/MemorySettings.tsx:1176 | ②chip徽章 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 228 | components/settings/MemorySettings.tsx:1179 | ②chip徽章 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 229 | components/settings/MemorySettings.tsx:1183 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 230 | components/settings/MemorySettings.tsx:1342 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 231 | components/settings/MemorySettings.tsx:1347 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 232 | components/settings/MemorySettings.tsx:1352 | ②chip徽章 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 233 | components/settings/MemorySettings.tsx:1471 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 234 | components/settings/MemorySettings.tsx:1524 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 235 | components/settings/MemorySettings.tsx:1575 | ②chip徽章 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 236 | components/settings/MemorySettings.tsx:1750 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 237 | components/settings/MemorySettings.tsx:1910 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 238 | components/settings/MemorySettings.tsx:1912 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 239 | components/settings/MemorySettings.tsx:1914 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 240 | components/settings/MemorySettings.tsx:2135 | ②chip徽章 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 241 | components/settings/MemorySettings.tsx:2138 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 242 | components/settings/MemorySettings.tsx:2142 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 243 | components/settings/MemorySettings.tsx:2416 | ②开关轨道 | ②维持-开关轨道 | 可点击但无文字：w/h 对+transition-colors 开关轨道(owner 保留类) |
| 244 | components/settings/MemorySettings.tsx:2426 | ②开关滑块 | ②维持-开关滑块 | 无文字不可点：bg-white/translate-x 滑块 |
| 245 | components/settings/MetaIDContactPanel.tsx:109 | ②chip徽章 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 246 | components/settings/MetaIDContactPanel.tsx:112 | ②chip徽章 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 247 | components/settings/MetaIDContactPanel.tsx:269 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 248 | components/settings/MetaIDContactPanel.tsx:287 | ②chip徽章 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 249 | components/skills/SkillScopeEditor.tsx:178 | ③其他装饰 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 250 | components/skills/SkillScopeEditor.tsx:183 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 251 | components/skills/SkillsManager.tsx:883 | ②开关轨道 | ②维持-开关轨道 | 可点击但无文字：w/h 对+transition-colors 开关轨道(owner 保留类) |
| 252 | components/skills/SkillsManager.tsx:889 | ②开关滑块 | ②维持-开关滑块 | 无文字不可点：bg-white/translate-x 滑块 |
| 253 | components/traffic/TrafficSettings.tsx:1178 | ②开关轨道 | ②维持-开关轨道 | 可点击但无文字：w/h 对+transition-colors 开关轨道(owner 保留类) |
| 254 | components/traffic/TrafficSettings.tsx:1189 | ②开关滑块 | ②维持-开关滑块 | 无文字不可点：bg-white/translate-x 滑块 |
| 255 | components/traffic/TrafficSettings.tsx:1731 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 256 | components/traffic/TrafficSettings.tsx:1876 | ②chip徽章 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 257 | components/update/AppUpdateBadge.tsx:101 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 258 | components/update/AppUpdateModal.tsx:97 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 259 | components/update/AppUpdateModal.tsx:170 | ③其他装饰 | ②维持-头像圈 | 无文字不可点：object-cover/overflow-hidden 头像 |
| 260 | components/update/AppUpdateModal.tsx:172 | ③其他装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 261 | components/update/AppUpdateModal.tsx:177 | ③其他装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 262 | components/update/UpdateChangeLogPanel.tsx:39 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 263 | components/user/ChainBackupMnemonicReminderModal.tsx:36 | ②头像圈 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 264 | components/user/ChainBackupRestorePrompt.tsx:34 | ②头像圈 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 265 | components/user/UserBackupMnemonicModal.tsx:88 | ②头像圈 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 266 | components/user/UserSettings.tsx:700 | ③其他装饰 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 267 | components/user/UserSettings.tsx:1080〔游离位〕 | ②头像圈 | ②维持-头像圈(常量/透传) | frameClassName/avatarClass 头像框透传或常量，非元素本体样式 |
| 268 | components/user/UserSettings.tsx:1083 | ②头像圈 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 269 | components/user/UserSettings.tsx:1328 | ②头像圈 | ③维持-装饰 | 无文字不可点：装饰图形 |
| 270 | features/botBrowser/BotBrowserCoworkPanel.tsx:1198 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 271 | features/botBrowser/BotBrowserCoworkPanel.tsx:1199 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 272 | features/botBrowser/BotBrowserCoworkPanel.tsx:1200 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 273 | features/botBrowser/BotPickerChip.tsx:50 | ②头像圈 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 274 | features/botBrowser/BotPickerChip.tsx:56 | ②头像圈 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 275 | features/botBrowser/CoworkHistoryPanel.tsx:200 | ②状态点 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 276 | features/botBrowser/CoworkSurfaceIdentityBadge.tsx:26 | ②头像圈 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 277 | features/botBrowser/CoworkSurfaceIdentityBadge.tsx:32 | ②头像圈 | ②维持-展示徽章(带文字不可点) | 判据两半仅成立文字半：不可点击→非按钮→维持圆形 |
| 278 | features/botBrowser/MacWindowLights.tsx:96 | ①禁触-移交 | ①禁触-移交维持 | macOS 红绿灯装饰点，owner 禁触清单；census 同类①禁触-移交 |
| 279 | features/botBrowser/PanelDelegationStatusRow.tsx:52〔游离位〕 | ②头像圈 | ②维持-头像圈(常量/透传) | frameClassName/avatarClass 头像框透传或常量，非元素本体样式 |
| 280 | features/botBrowser/PanelDelegationStatusRow.tsx:53 | ②头像圈 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 281 | features/botBrowser/PanelMessageLocatorRail.tsx:288 | ③其他装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 282 | features/botBrowser/PanelMessageLocatorRail.tsx:302 | ③其他装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 283 | features/botBrowser/PanelMessageLocatorRail.tsx:319 | ③其他装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 284 | features/userProfile/MeCreditsPanel.tsx:134 | ③进度/装饰 | ③维持-进度/装饰条 | 无文字不可点：进度/指示条 |
| 285 | features/userProfile/MeCreditsPanel.tsx:135 | ③其他装饰 | ②维持-状态点 | 无文字不可点：小尺寸纯状态点 |
| 286 | components/cowork/UserMessageOriginBadge.tsx:189〔游离位〕 | ②头像圈 | ②维持-头像圈(常量/透传) | frameClassName/avatarClass 头像框透传或常量，非元素本体样式 |
| 287 | components/metabots/metaBotCardPresentation.js:20〔游离位〕 | ②开关轨道 | ②维持-开关轨道(常量) | buildMetaBotToggleViewModel trackClass：w-9 h-5 开关轨道 |
| 288 | components/metabots/metaBotCardPresentation.js:29〔游离位〕 | ②开关滑块 | ②维持-开关滑块(常量) | buildMetaBotToggleViewModel knobClass：w-3.5 h-3.5 滑块 |
