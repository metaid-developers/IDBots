# WS-A 开发任务书：旧版 MetaContract 全自动兑换与官方蓝标验真

- **负责范围**：`IDBots` 客户端兑换链路 + 官方蓝标 CA 验真 + `SKILLs/nft-swap` v0.5 多专辑与 1 确认升级
- **建议分支与工作树**：分支 `feat/nft-swap-auto-ca`，工作树 `.worktrees/nft-swap-auto-ca`（从 `main` 创建）
- **上游契约依赖**：[`01-protocols-and-contracts.md`](01-protocols-and-contracts.md) 中的 **契约 C1** 与 **契约 C5.1**
- **文件边界约束（避免与 WS-D 冲突）**：
  - 本工作流主改：`src/main/services/nftCaService.ts`、新增 `src/main/services/officialBotVerifyService.ts`、新增 `src/main/services/swapOrderTrackerService.ts`、新增 `src/main/libs/nftSwapAgentTools.ts`、`src/renderer/services/nftCaRegistryService.ts`、新增 `src/renderer/components/metabots/LegacyNftDepositGuideModal.tsx`、`SKILLs/nft-swap/**`。
  - 如需在 `src/main/main.ts` 或 `src/main/libs/coworkRunner.ts` 挂载新工具，保持最小胶水注入（不超过 30 行），方便合流。

---

## 一、用户故事与目标体验

1. **老资产转入引导**：老用户打开 IDBots，在钱包或对话提示中点击「转入旧版藏品」，清晰看到当前 Twin Bot 的 MVC 接收地址与二维码，从自己的老钱包（如 Metalet）把旧版 MetaContract 格式的藏品转到 Twin 钱包。
2. **一句话全自动兑换**：用户对 Twin（无论在 Studio 模式还是 BotWorks 模式）说：“把我钱包里的 MetaBot Avatar 兑换成新版”。
3. **AI 寻源 + 官方防钓鱼硬拦截**：
   - Twin 调 `wallet_nft_balance` 发现持有的旧藏品列表；
   - Twin 调 `search_metaweb` 搜索链上兑换教程，提取目标兑换站 `globalMetaId` 与金库地址 `vaultAddress`；
   - **宿主硬门禁**：在调用转出动作前，内置的 `officialBotVerifyService` 自动读取官方根身份 `"Bob"` 签发的 `/protocols/idbots-nft-ca` 注册表，校验该兑换站 `globalMetaId`、`vaultAddress`、`(codehash, genesis)` 是否全部匹配官方蓝标记录且 `active === true`。若教程被伪造指向骗子地址，**宿主直接拒绝签名转账并向用户展示防诈骗拦截警告**！
4. **单次合并授权，后台无感完成**：
   - 宿主弹出 **1 张合并确认卡**（展示官方蓝标徽章、待升级件数与缩略图、0 手续费说明）；用户点一次「确认免费兑换」后即可去忙别的事；
   - Twin 批量将旧藏品转入金库，并通过受控协议私聊通道向兑换站发送 `SWAP_CLAIM_V1`；
   - 兑换站（`nft-swap` v0.5）在 **1 个区块确认**（配合 mempool 无双花检查）后立即快照封面、铸造对应编号 MRC-721 并转回给用户 Twin，回传 `SWAP_COMPLETED_V1`；
   - 客户端 `SwapOrderTracker` 监听到回执或链上新商品到账，主动在当前会话推送「🎉 兑换完成（含一键挂牌开店入口）」通知与卡片。

---

## 二、详细需求清单（REQ-A）

### REQ-A-01：扩展 `nftCaService` 支持官方服务 Bot 蓝标注册表（契约 C1）
- **修改文件**：
  - `src/main/services/nftCaService.ts`
  - `src/renderer/services/nftCaRegistryService.ts`
- **实现细节**：
  1. 在 `NftCaCollectionEntry` 中补充可选字段 `displayTitle?: string` 与 `legacySeries?: { codehash: string; genesis: string; swapStationGlobalMetaId?: string }`。
  2. 新增 `NftCaOfficialBotEntry` 类型解析 `payload.officialBots[]`（完整对齐契约 C1.2 的 `globalMetaId`, `metaId`, `mvcAddress`, `role`, `badgeType`, `badgeLabel`, `swapConfig`, `escrowConfig`, `active`, `certifiedAt`）。
  3. **修正“最新 Pin 生效”读取逻辑**：当前 `nftCaService.ts` 仅读取固定创世 `DEFAULT_NFT_CA_PINID` 的内容，若官方通过 `modify` 更新注册表，需优先通过 MetaSo `GET /api/mrc721/ca/registry` 或 `metaweb_pin_versions` / `manapi` 获取该路径上由 `OFFICIAL_IDBOTS_METAID` 签发的最新修正版内容，并保留创世 Pin 回退逻辑，且**强制本地复核 `creatorMetaId === OFFICIAL_IDBOTS_METAID`**。
  4. 保持失败安全（Fail-closed）：任何网络失败、签名创建者不匹配或 `active === false` 一律视为 `verified: false`。

### REQ-A-02：内置官方兑换站/担保席硬验真服务与 Agent 工具
- **新增文件**：`src/main/services/officialBotVerifyService.ts`
- **暴露核心方法**：
  - `verifyOfficialSwapStation(params: { stationGlobalMetaId: string; vaultAddress: string; codehash: string; genesis: string }): Promise<{ verified: boolean; reason?: string; stationEntry?: NftCaOfficialBotEntry; seriesConfig?: ... }>`
  - `verifyOfficialEscrowGuarantor(params: { guarantorGlobalMetaId: string; custodyAddress?: string }): Promise<{ verified: boolean; reason?: string; guarantorEntry?: NftCaOfficialBotEntry }>`
- **暴露 Agent 工具（`src/main/libs/nftSwapAgentTools.ts`）**：
  - `nft_swap_verify_official_station`：供 Twin 在搜到链上兑换教程后第一时间核验兑换站真伪，返回清晰的官方蓝标认证详情。

### REQ-A-03：一键批量兑换执行工具与单次宿主确认闸（打通 Studio 模式）
- **新增工具**：`nft_swap_submit_batch`（在 `src/main/libs/nftSwapAgentTools.ts` 中定义，Studio 与 BotWorks 模式下的 Twin 均默认挂载！）
- **为什么用专用受控工具而非裸调 `wallet_nft_transfer` + `send_private_chat`**：
  1. 彻底解决 **Studio 模式下 Twin 未挂载通用 `send_private_chat`** 的架构冲突——该工具内部仅在 `verifyOfficialSwapStation` 100% 验真通过后，使用**当前会话 Twin 自身的钱包与 `globalMetaId`** 完成转入官方金库 + 发送标准 `SWAP_CLAIM_V1` 私聊报文，不允许向任意第三方乱发私聊；
  2. 彻底解决 **多枚藏品逐枚弹窗骚扰与裸转无验真风险**：
     - 入参：`station_global_metaid`, `vault_address`, `codehash`, `genesis`, `token_indices?: string[]`（不传则默认兑换当前钱包内该专辑全部旧藏品，单批上限 20 枚）。
     - 执行步骤：
       1. 硬调用 `verifyOfficialSwapStation` —— **若未通过官方蓝标 CA 核验，直接报错拦截，绝不触碰私钥**！
       2. 调用 `wallet_nft_balance` 核实要兑换的 `tokenIndex` 列表真实在当前 Twin 钱包内。
       3. 触发 **单次宿主确认闸**（`requestSafetyApproval('nft_swap_batch')`，`timeoutDefault: 'deny'`，`ownerOnly: true`）：卡片清晰展示「官方蓝标已核验：`Avatar 兑换站` · 准备免费升级 N 件藏品（编号 #...）」。
       4. 用户点击确认后，按序调用 `mvcNftService` 将每枚旧 NFT 转入 `vaultAddress`，收集 `depositTxId`（支持部分成功断点记录，写入本地 SQLite 表 `nft_swap_client_orders`）。
       5. 自动构造契约 C5.1 的 `SWAP_CLAIM_V1` 报文，通过 `privateChatService` 以当前 Twin 身份发送给 `station_global_metaid`。
       6. 注册到后台 `SwapOrderTracker` 并立即向对话返回结构化受理回执（告知用户：“已成功提交 N 件藏品至官方兑换站，预计约 5~10 分钟（1 个区块确认后）自动入账，入账后我会主动通知你”）。

### REQ-A-04：客户端后台自动追单守护（`SwapOrderTrackerService`）
- **新增文件**：`src/main/services/swapOrderTrackerService.ts`
- **幂等建表（遵守 SQLite 升级安全规范）**：
  - 在本地数据库幂等创建 `nft_swap_client_orders` 表：`request_id PRIMARY KEY`, `metabot_id`, `station_global_metaid`, `collection_slug`, `target_collection_pinid`, `items_json`, `status` (`submitted` | `partially_completed` | `completed` | `failed`), `completed_items_json`, `notified_at`, `created_at`, `updated_at`。
- **双通道完成感知**：
  1. **私聊回执驱动**：监听 `privateChatDaemon` 收到的来自官方兑换站 `station_global_metaid` 的消息，解析 ```` ```idbots-swap-v1 ```` 中的 `SWAP_COMPLETED_V1`；
  2. **链上轮询兜底**：对处于 `submitted` 状态的订单每 45 秒查询一次 MetaSo `/api/mrc721/address/item?address=<twinAddress>&pinId=<targetCollectionPinId>`，即使私聊偶发延迟，只要检测到对应编号的新版 MRC-721 已到账且 `creatorMinted === true`，同样立即标记完成！
- **完成动作**：
  - 向前端广播 IPC 事件 `nftSwap:orderCompleted`（携带新到账的 `itemPinId` 列表、封面、名称与 `collectionPinId`），驱动 UI 弹出「兑换完成 → 一键挂牌开店」引导卡片（与 WS-D 对接）。

### REQ-A-05：升级 `SKILLs/nft-swap` 至 v0.5.0（多专辑表驱动 + 1 确认提速）
- **修改路径**：`SKILLs/nft-swap/`（同步确保打包脚本与本地运行时一致）
- **核心改造**：
  1. **多专辑配置化（解耦 `issuer-config.mjs` 单专辑硬编码）**：
     - 将单一常量重构为 `SERIES_REGISTRY` 配置映射（支持从 `nft_swap_pilot_config.series[]` 动态加载，默认内置 `metabot-avatar`）。
     - 每个专辑配置包含：`collectionSlug`, `collectionPinId`, `codeHash`, `genesis`, `tokenSupply`, `issuerAddress`, `vaultAddress`, `burnAddress`, `itemPathPattern`, `titleTemplate`, `minConfirmations`（默认 **`1`**）。
  2. **账本主键升级（`cli/lib/swap-ledger.mjs`）**：
     - 兼容迁移旧版 `swap_ledger` 表（旧表以 `token_index` 为单列主键），幂等升级为以 `(collection_slug, token_index)` 为唯一键（旧数据默认补 `collection_slug = 'metabot-avatar'`，严禁丢失已兑换历史记录！）。
  3. **确认门槛提速（`MVP_CONFIRMATIONS = 6 -> 1`）与风控预检**：
     - `vault-poll.mjs` 与 `verify-claim.mjs` 读取专辑配置的 `minConfirmations`（默认 `1` 确认，约数分钟即可放行；若检测到 `0` 确认入账则立即回复 `SWAP_STATUS_V1: pending_1_conf`，提示正在等待 1 个区块确认）。
     - 保留全部 v0.4.0 封面硬门禁（`COVER_UNAVAILABLE` 缺图拒铸、`COVER_MISSING_BEFORE_BURN` 销毁前验图）。
  4. **标准结构化私聊响应**：
     - 新增 `cli/handle-claim-message.mjs`：解析用户 Twin 发来的 `SWAP_CLAIM_V1` JSON 围栏，支持单条申领单包含多枚 `items[]`，逐枚验真铸造发送后，统一回传标准 `SWAP_COMPLETED_V1` 报文（契约 C5.1）。

### REQ-A-06：旧版藏品转入引导弹窗 + 蓝标 UI 标识
- 在钱包资产弹窗 / 数字商品页补充 **「从老钱包转入旧藏品升级」** 入口（`LegacyNftDepositGuideModal.tsx`）：展示当前 Twin Bot 的 MVC 地址、二维码、支持的认证兑换专辑清单（从 CA 注册表动态读取），以及一键填入对话指令按钮「帮我把刚转入的旧藏品免费升级为新版数字商品」。

---

## 三、测试与验收要求

1. **单元测试（必交）**：
   - `tests/nftCaOfficialBots.test.ts`：覆盖契约 C1 `officialBots` 解析、非官方 `creatorMetaId` 伪造拦截、`active: false` 吊销拦截、旧版仅含 `collections` 的向后兼容。
   - `tests/officialSwapStationVerify.test.ts`：覆盖正例验真通过、假冒 `globalMetaId` 拦截、篡改 `vaultAddress` 拦截、不支持的 `(codehash, genesis)` 拦截。
   - `tests/swapOrderTracker.test.ts`：覆盖 SQLite 建表与释放句柄清理（Windows 兼容 `disposeStore` 模式）、`SWAP_COMPLETED_V1` 私聊回执解析、链上到账轮询兜底去重。
   - `SKILLs/nft-swap` 自检套件：保留原有 20 项封面自检全绿，新增旧账本平滑迁移至 `(collection_slug, token_index)` 单测与 `minConfirmations = 1` 核验测试。
2. **安全门禁自检**：确认没有任何路径可以绕过 `verifyOfficialSwapStation` 通过 `nft_swap_submit_batch` 将旧 NFT 转给非 CA 认证地址。
