# 02 — IPC Allowlist v1 (Mobile API v1)

Allowlist version: **1.0.0**, frozen by the owner on 2026-10-15 (M1); changes
follow the change-request process in `00`. This is the complete list
of IPC channels a gateway client may invoke and the main-process events it
receives. Everything not listed as allowed is denied
(`CHANNEL_NOT_ALLOWED`). WS-A implements it in `src/main/gateway/allowlist.ts`;
WS-E builds against it; acceptance tests it.

The channel inventory was taken from `src/main/preload.ts` on 2026-10-14
(about 340 invoke channels, 43 event channels, 8 send channels). WS-A's
contract generator (REQ-A-23) must report any channel added to the preload
after that date so it gets a tier here.

## Tiers

| Tier | Meaning |
|------|---------|
| **P1** | Allowed from Phase 1 (M2). |
| **P2** | Allowed from Phase 2 (M4). Denied before that. |
| **R** | Allowed with the server-side restriction named in the row (combined with P1 or P2, for example `P1-R`). A violating call returns `ARG_RESTRICTED`. |
| **H** | Sensitive: only through a C2 HTTP route after SMS re-verification. Never over the WebSocket. |
| **S** | The mobile shim answers locally without calling the server (see WS-E REQ-E-4). The gateway denies it. |
| **N** | Never in v1. |

## Restrictions Used Below

| ID | Rule |
|----|------|
| R-cwd | Any `cwd` or `workingDirectory` argument must resolve inside `/data/workspace`. Missing or empty means `/data/workspace`. |
| R-path | Any file path argument must resolve (`realpath`) inside `/data`. |
| R-upload | File path arguments must resolve inside `/data/workspace/uploads` (files the phone uploaded through C2). |
| R-exec | `executionMode` may only be `auto` or `local`; `sandbox` is rejected (no nested containers). |
| R-cfg | `cowork:config:set` accepts only `memoryEnabled`, `memoryImplicitUpdateEnabled`, `memoryLlmJudgeEnabled`, `memoryGuardLevel`, `memoryUserMemoriesMaxItems`, plus `workingDirectory` and `executionMode` under R-cwd and R-exec. Other fields are rejected. |
| R-store | `store:get`, `store:set`, `store:remove` accept only key `app_config`. On `get`, every `providers.*.apiKey` is replaced by `"__redacted__"`. On `set`, provider entries cannot be added or removed and their `apiKey`, `baseUrl`, and `apiFormat` are kept from the stored value; `remove` is rejected. |
| R-size | Base64 payloads are limited by the 1 MiB inbound frame; larger files go through the upload route. |

## Invoke Channels

### Cowork (69)

| Channel | Tier | Notes |
|---------|------|-------|
| `cowork:session:start` | P1-R | R-cwd. `permissionMode` allowed. |
| `cowork:session:continue`, `cowork:session:submitInput`, `cowork:session:stop`, `cowork:session:stopTask` | P1 | |
| `cowork:session:get`, `cowork:session:getMessagesPage`, `cowork:session:list`, `cowork:session:listArchived` | P1 | |
| `cowork:session:getSubagents`, `cowork:session:getSubagentMessages` | P1 | |
| `cowork:session:rename`, `cowork:session:pin`, `cowork:session:archive`, `cowork:session:unarchive`, `cowork:session:fork`, `cowork:session:rewind`, `cowork:session:compact`, `cowork:session:clearError` | P1 | |
| `cowork:session:setModel`, `cowork:session:setEffort`, `cowork:session:setGoal`, `cowork:session:setPermissionMode` | P1 | |
| `cowork:session:getAutoApproveTools`, `cowork:session:addAutoApproveTool`, `cowork:session:removeAutoApproveTool` | P1 | |
| `cowork:session:createGreeting`, `cowork:session:listMetabotAvatars`, `cowork:session:foldOverride`, `cowork:session:setFollowUp`, `cowork:session:backgroundTask` | P1 | |
| `cowork:session:listFeedback`, `cowork:message:setFeedback` | P1 | |
| `cowork:session:readLocalImage` | P1-R | R-path. |
| `cowork:stream:liveContent` | P1 | Used by reconnect resync. |
| `cowork:permission:respond` | P1 | |
| `cowork:permission:listPending` | P1 | Pending-permission resync after a reconnect or renderer reload; read-only. |
| `cowork:plan-mode:get`, `cowork:plan-mode:set` | P1 | |
| `cowork:config:get` | P1 | |
| `cowork:config:set` | P1-R | R-cfg. |
| `cowork:getDelegationInfo`, `cowork:isDelegationBlocking` | P1 | |
| `cowork:session:ensureA2A`, `cowork:session:sendOwnerA2AMessage`, `cowork:session:queueA2AGuidance`, `cowork:session:endA2APrivateChat` | P2 | Private chat between Bots. |
| `cowork:session:getA2AEpisodes`, `cowork:session:getA2AHistoryPage`, `cowork:session:resendA2ADeliveryArtifact`, `cowork:session:refreshPeerProfile` | P2 | |
| `cowork:session:processServiceRefund` | P2 | Gig Square refunds. |
| `cowork:memory:listEntries`, `cowork:memory:createEntry`, `cowork:memory:updateEntry`, `cowork:memory:deleteEntry`, `cowork:memory:unarchiveEntry` | P2 | |
| `cowork:memory:listScopes`, `cowork:memory:getSessionScope`, `cowork:memory:getStats`, `cowork:memory:getPolicy`, `cowork:memory:setPolicy`, `cowork:memory:deletePolicy` | P2 | |
| `cowork:session:exportTranscript` | N | Opens a save dialog. A mobile export can be added later as a facade that writes a file and returns a signed URL. |
| `cowork:session:exportResultImage`, `cowork:session:captureImageChunk` | N | Capture the desktop window. |
| `cowork:session:saveResultImage` | N | Desktop save flow. |
| `cowork:metafile:download` | N | Opens a save dialog; the phone opens the public metafile URL instead. |
| `cowork:sandbox:install`, `cowork:sandbox:status` | N | |

### MetaBots and Identity

| Channel | Tier | Notes |
|---------|------|-------|
| `metabot:list`, `metabot:get`, `metabot:checkNameExists`, `metabot:create`, `metabot:update`, `metabot:setEnabled`, `metabot:getSetting`, `metabot:setSetting` | P1 | |
| `idbots:getMetaBots`, `idbots:addMetaBot`, `idbots:deleteMetaBot`, `idbots:syncMetaBot`, `idbots:syncMetaBotEditChanges`, `idbots:resumeMetabotSetup` | P1 | |
| `idbots:createMetaBotOnChain` | P1 | Timeout 300 s. |
| `idbots:getAddressBalance`, `idbots:getMetabotWalletAssets`, `idbots:getMetabotNfts` | P1 | |
| `idbots:healNftCard` | P1 | Re-resolves one NFT card artwork URL (read + local cache update, no funds). |
| `idbots:getOfficialSkillsStatus`, `idbots:getCommunitySkillsStatus`, `idbots:installOfficialSkill`, `idbots:syncAllOfficialSkills` | P1 | |
| `idbots:uploadMetabotHomepageFile` | P2-R | R-size. |
| `idbots:getListenerConfig`, `idbots:getListenerStatus`, `idbots:startMetaWebListener`, `idbots:toggleListener` | P2 | Server mode keeps the listener running by default (REQ-A-8). |
| `idbots:assignGroupChatTask` | P2 | |
| `idbots:buildTransferPreview`, `idbots:buildTokenTransferPreview`, `idbots:getTransferFeeSummary`, `idbots:getTokenTransferFeeSummary` | P2 | Read-only previews. |
| `idbots:executeTransfer`, `idbots:executeTokenTransfer` | N | Moving funds out of custodial wallets needs SMS re-verification; later release. |
| `idbots:getMetaBotMnemonic` | H | C2 sensitive route. |
| `idbots:restoreMetaBotFromMnemonic` | N | Mnemonic input over the socket; later release. |
| `userIdentity:get`, `userIdentity:updateName`, `userIdentity:retryChainSync`, `userIdentity:retrySubsidy` | P1 | |
| `userIdentity:revealMnemonic` | H | C2 sensitive route. |
| `userIdentity:create` | N | Server bootstrap creates the identity. |
| `userIdentity:import`, `userIdentity:logout` | N | Account changes go through the control plane. |
| `metaid:getUserInfo`, `metaid:resolveAvatarSource` | P1 | |
| `metaid:contacts:list`, `metaid:contacts:detail` | P2 | |
| `metaid:knowledge:list`, `metaid:knowledge:update`, `metaid:knowledge:archive`, `metaid:knowledge:delete` | P2 | |

### Skills

| Channel | Tier | Notes |
|---------|------|-------|
| `skills:list`, `skills:getConfig`, `skills:setConfig`, `skills:setEnabled`, `skills:setScope`, `skills:getAssignmentInfo`, `skills:autoRoutingPrompt`, `skills:getRoot`, `skills:listMissing`, `skills:forgetMissing` | P1 | |
| `skills:delete`, `skills:testEmailConnectivity` | P2 | |
| `skills:download` | N | Installs code from an arbitrary URL; official skills use `idbots:installOfficialSkill`. |

### Tasks

| Channel | Tier | Notes |
|---------|------|-------|
| `scheduledTask:list`, `scheduledTask:get`, `scheduledTask:delete`, `scheduledTask:toggle`, `scheduledTask:runManually`, `scheduledTask:stop`, `scheduledTask:listRuns`, `scheduledTask:countRuns`, `scheduledTask:listAllRuns` | P1 | |
| `scheduledTask:create`, `scheduledTask:update` | P1-R | R-cwd on `workingDirectory`; R-exec. |
| All 15 `longtermTask:*` channels (`accept`, `begin`, `board`, `complete`, `forSession`, `get`, `moveSubtask`, `note`, `reject`, `setStage`, `subtaskAdd`, `subtaskSkip`, `subtaskUpdate`, `unblock`, `update`) | P1 | |
| All 16 `groupTask:*` channels (`archive`, `close`, `create`, `get`, `getTurnActivity`, `kickMember`, `list`, `listArchived`, `listMessages`, `pin`, `rename`, `reopen`, `resume`, `rework`, `sendUserMessage`, `unarchive`) | P2 | |
| `metatask:board`, `metatask:get`, `metatask:refresh` | P2 | |

### Billing

| Channel | Tier | Notes |
|---------|------|-------|
| `traffic:ensureAccount`, `traffic:getAccount`, `traffic:bindAllBots`, `traffic:getBalance`, `traffic:getLedger`, `traffic:getLocalJournal`, `traffic:getDailyUsage`, `traffic:getUsageSummary`, `traffic:getPricing`, `traffic:getRechargeGateway`, `traffic:createRechargeOrder`, `traffic:getRechargeOrder`, `traffic:getFreeGrantCampaignStatus`, `traffic:claimFreeGrant`, `traffic:redeemCode`, `traffic:getSettings` | P1 | |
| `traffic:mockConfirmRechargeOrder` | P1 (staging only) | Denied when the tenant points at production Metaso. |
| `traffic:setSettings` | N | The server sets traffic sponsorship at bootstrap. |
| `llmRelay:getQuota` | P1 | |
| `llmRelay:bootstrap`, `llmRelay:setApiBase` | N | Server bootstrap owns the relay key and base URL. |
| `llmRelay:getQuotaNudgeState`, `llmRelay:dismissQuotaNudge` | P1 | Pure UI state for the free-quota nudge banner. |
| `llmRelay:quotaNudgeChanged` (event) | P1 | Banner refresh broadcast. |
| `brainSwitch:switchFreeBrainsTo` | N | Server-side quota rescue owns brain routing; the channel rebinds the global default route and bot brains. |
| `feeRates:getTiers`, `feeRates:getSelected`, `feeRates:select`, `feeRates:refresh` | P1 | |
| `deepseek:getBalance` | N | Bring-your-own-key feature, later release. |

### Gig Square and Discovery

| Channel | Tier | Notes |
|---------|------|-------|
| All 14 `gigSquare:*` channels (`fetchServices`, `fetchProviderInfo`, `pingProvider`, `preflightOrder`, `createServiceOrderPin`, `sendOrder`, `fetchMyServiceOrders`, `fetchRefunds`, `processRefundOrder`, `fetchMyServices`, `publishService`, `modifyService`, `revokeService`, `syncFromRemote`) | P2 | `gigSquare:sendOrder` timeout 300 s. |
| `providerDiscovery:getOnlineBots`, `providerDiscovery:getOnlineServices`, `providerDiscovery:getSnapshot` | P2 | |
| `openTeamCollab:list`, `openTeamCollab:listGuestInvites`, `openTeamCollab:listMessages` | P2 | |
| `openTeamCollab:getMembers` | P2 | Read-only member roster for one collab (renderer sidebar). |
| `metawebStudy:list` | P2 | |

### Background Features, Knowledge, IM, Backup

| Channel | Tier | Notes |
|---------|------|-------|
| `dream:getStatus`, `dream:listRuns`, `dream:listDailySummaries`, `dream:listCapabilityDrafts`, `dream:listTelemetryDaily`, `dream:runNow` | P2 | |
| `surf:listRuns`, `surf:runNow` | P2 | |
| `memoryHygiene:get`, `memoryHygiene:setConfig`, `memoryHygiene:runNow` | P2 | |
| `knowledgeBase:list`, `knowledgeBase:create`, `knowledgeBase:update`, `knowledgeBase:remove`, `knowledgeBase:learn` | P2 | |
| `knowledgeBase:importFiles` | P2-R | R-upload. |
| `knowledgeBase:openDir` | N | Opens a desktop folder. |
| `im:config:get`, `im:config:set`, `im:status:get`, `im:gateway:start`, `im:gateway:stop`, `im:gateway:test` | P2 | Lets the user answer permission requests through Feishu or DingTalk while the phone is closed. |
| `im:weixin:login:start`, `im:weixin:login:cancel`, `im:weixin:credentials:check` | P2 | Starts/cancels the Weixin QR authorization and reports whether a token is stored. P2 because the channel exists for the same "answer while the phone is closed" flow; the QR payload itself carries no credential. |
| `im:qq:login:start`, `im:qq:login:cancel`, `im:qq:credentials:check` | P2 | Starts/cancels the QQ QR authorization and reports whether credentials are stored. The AppID and QR payload are identifiers, not credentials. |
| `im:qq:credentials:set` | P2 | Write-only: accepts the AppSecret on the write path, stored 0600; no read-back channel exists. |
| `im:qq:groups:candidates:list`, `im:qq:groups:candidates:dismiss`, `im:qq:groups:candidates:restore`, `im:qq:groups:candidates:name` | P2 | Read-only channel state (group ids that messaged the bot while not allowlisted, plus counters and an optional name lookup). None of these can add a group to the allowlist — that still goes through `im:config:set`. |
| `chainBackup:getState`, `chainBackup:backup` | P2 | `backup` timeout 900 s. |
| `chainBackup:restore` | N | Needs mnemonic import; later release. |

### App, Config, and Utilities

| Channel | Tier | Notes |
|---------|------|-------|
| `app:getVersion`, `app:getSystemLocale` | P1 | |
| `store:get`, `store:set`, `store:remove` | P1-R | R-store. |
| `get-api-config`, `check-api-config` | P1 | Read and connection test only. |
| `save-api-config` | N | Provider management is not on the phone in v1. |
| `generate-session-title` | P1 | |
| `fs:readTextFile` | P1-R | R-path. |
| `startup:rendererInitialized` | S | Shim resolves `{ success: true }`. Server mode must not wait for it (REQ-A-2). |
| `get-recent-cwds` | S | Shim returns `[]`. |
| `window:isMaximized` | S | Shim returns `false`. |
| `dialog:selectFile` | S | Shim opens the phone's file or photo picker, uploads through C2, and returns the server paths. |
| `dialog:selectDirectory`, `dialog:saveInlineFile` | S | Shim returns a cancelled result. |
| `shell:openExternal` | S | Shim opens `http(s)` URLs in the phone browser; other schemes are ignored. |
| `shell:openPath`, `shell:showItemInFolder`, `shell:openWith`, `shell:getOpenWithApps`, `shell:chooseOpenWithApp` | S | Shim converts a `/data` path to a signed URL and opens it; otherwise no-op. |
| `api:fetch`, `api:stream`, `api:stream:cancel` | N | Generic outbound HTTP proxy. The one mobile-relevant user, the Gig Square order text, already falls back when the call fails. |
| `app:getAutoLaunch`, `app:setAutoLaunch`, `app:getExperimentalAutomation`, `app:setExperimentalAutomation` | N | |
| `dailyReport:runNow` | N | Desktop-only — spawns a local Twin report session; no mobile surface in v1. |
| All `appUpdate:*`, `botBrowser:*`, `metaapps:*`, `metaappOwner:*`, `mcp:*`, `projects:*`, `agentGame:*`, `teamCulture:*`, `powerGuard:*`, `permissions:*`, `log:*`, `git:*` channels | N | Desktop-only or out of scope for v1. |

### New Channels Added by WS-A

| Channel | Tier | Arguments → result |
|---------|------|--------------------|
| `gateway:file:sign` | P1 | `[{ path, disposition? }]` → `{ url, expiresAt, size, mime }` (C2 File Download; R-path) |
| `mobile:permission:listPending` | P1 | `[]` → `Array<{ sessionId, request, createdAt }>` |
| `mobile:bootstrap:status` | P1 | `[]` → the `onboarding` object from `/readyz` |
| `bundle:getPlans` | P1 | `[]` → C4 plan list |
| `bundle:createOrder` | P1 | `[{ planId }]` → C4 order (the main process signs with the user identity) |
| `bundle:getOrder` | P1 | `[{ orderId }]` → C4 order status |
| `bundle:getMeters` | P1 | `[]` → `{ traffic: <traffic:getBalance value>, llm: <C4 quota object> }` without exposing any API key |

## Events

| Event channel | Tier |
|---------------|------|
| `cowork:stream:message`, `cowork:stream:messageUpdate`, `cowork:stream:complete`, `cowork:stream:error`, `cowork:stream:permission`, `cowork:stream:permissionResolved`, `cowork:stream:sessionTitle` | P1 |
| `cowork:session:profileRefreshed`, `cowork:delegation:stateChange` | P1 |
| `scheduledTask:runUpdate`, `scheduledTask:statusUpdate`, `longtermTask:update` | P1 |
| `skills:changed`, `metabot:dreamStatusChanged`, `metabot:surfStatusChanged` | P1 |
| `store:changed` | P1-R (only key `app_config`, redacted like R-store) |
| `groupTask:statusChanged`, `groupTask:checkpointChanged`, `groupTask:turnActivityChanged`, `groupTask:ownerReportDelivery` | P2 |
| `metatask:update`, `knowledgeBase:learnStatus`, `chainBackup:progress`, `providerDiscovery:changed`, `memoryHygiene:statusChanged`, `im:status:change`, `im:message:received` | P2 |
| `chainBackup:restoreProgress` | N (restore is not allowed) |
| `agentGame:*`, `app:newTask`, `app:openSettings`, `appUpdate:downloadProgress`, `botBrowser:*`, `cowork:sandbox:downloadProgress`, `idbots:listener-log`, `metaapps:changed`, `powerGuard:changed`, `window:state-changed` | N |

Renderer-to-main `send` channels (`window-close`, `window-maximize`,
`window-minimize`, `window:move-by`, `window:showSystemMenu`,
`network:status-change`, `botBrowser:capture-request:response`,
`botBrowser:tab-command:response`) are all **N**; the shim drops them.

## Tests Required (WS-A)

1. Every P1 and P2 channel exists in the IPC registry.
2. Every channel in the preload contract has a tier in `allowlist.ts`; an
   untiered channel fails the test.
3. Each R rule has a positive and a negative test (for example
   `cowork:session:start` with `cwd: '/etc'` returns `ARG_RESTRICTED`).
4. `store:get('app_config')` over the gateway never contains a real API key.
5. P2 channels return `CHANNEL_NOT_ALLOWED` while the tenant runs with
   `IDBOTS_GATEWAY_TIER=P1`, and work with `IDBOTS_GATEWAY_TIER=P2`.
