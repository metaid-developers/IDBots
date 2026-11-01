// IPC allowlist data — encodes docs/cloud-mobile/02-ipc-allowlist-v1.md
// (allowlist version 1.0.0, frozen 2026-10-15) as data, per REQ-A-17.
//
// Every tier/restriction/timeout assignment in the FROZEN sections of this
// file traces to a row of `02`. `02`'s header is itself a rule: "Everything
// not listed as allowed is denied (CHANNEL_NOT_ALLOWED)" — so the channels in
// the final section (added to src/main/preload.ts on/after the 2026-10-14
// inventory that produced `02`) are explicitly denied at tier N pending a
// change request that gives them a real tier in `02`. Denying them
// explicitly instead of letting them fall through to the implicit default
// makes the generator's coverage report exact; it changes no gateway
// behavior, because explicit N and the default deny are the same decision.
//
// Pure data + pure functions only: this module must stay importable from any
// process (gateway, tests, tooling) with no electron or service imports.

export type AllowlistTier = 'P1' | 'P2' | 'N' | 'S' | 'H';

export type RestrictionId =
  | 'R-cwd'
  | 'R-path'
  | 'R-upload'
  | 'R-exec'
  | 'R-cfg'
  | 'R-store'
  | 'R-size';

export interface AllowlistEntry {
  tier: AllowlistTier;
  restrictions?: RestrictionId[];
  timeoutMs?: number;
  note?: string;
}

/** Allowlist version from `02` (frozen 2026-10-15). */
export const ALLOWLIST_VERSION = '1.0.0';

/** C2 Limits: default invoke timeout. Channel-specific overrides live on entries. */
export const DEFAULT_INVOKE_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Invoke channels — section "Cowork (68)" of `02`.
// ---------------------------------------------------------------------------

const COWORK_INVOKE: Record<string, AllowlistEntry> = {
  'cowork:session:start': { tier: 'P1', restrictions: ['R-cwd'], note: '`02`: R-cwd. `permissionMode` allowed.' },
  'cowork:session:continue': { tier: 'P1' },
  'cowork:session:submitInput': { tier: 'P1' },
  'cowork:session:stop': { tier: 'P1' },
  'cowork:session:stopTask': { tier: 'P1' },
  'cowork:session:get': { tier: 'P1' },
  'cowork:session:getMessagesPage': { tier: 'P1' },
  'cowork:session:list': { tier: 'P1' },
  'cowork:session:listArchived': { tier: 'P1' },
  'cowork:session:getSubagents': { tier: 'P1' },
  'cowork:session:getSubagentMessages': { tier: 'P1' },
  'cowork:session:rename': { tier: 'P1' },
  'cowork:session:pin': { tier: 'P1' },
  'cowork:session:archive': { tier: 'P1' },
  'cowork:session:unarchive': { tier: 'P1' },
  'cowork:session:fork': { tier: 'P1' },
  'cowork:session:rewind': { tier: 'P1' },
  'cowork:session:compact': { tier: 'P1' },
  'cowork:session:clearError': { tier: 'P1' },
  'cowork:session:setModel': { tier: 'P1' },
  'cowork:session:setEffort': { tier: 'P1' },
  'cowork:session:setGoal': { tier: 'P1' },
  'cowork:session:setPermissionMode': { tier: 'P1' },
  'cowork:session:getAutoApproveTools': { tier: 'P1' },
  'cowork:session:addAutoApproveTool': { tier: 'P1' },
  'cowork:session:removeAutoApproveTool': { tier: 'P1' },
  'cowork:session:createGreeting': { tier: 'P1' },
  'cowork:session:listMetabotAvatars': { tier: 'P1' },
  'cowork:session:foldOverride': { tier: 'P1' },
  'cowork:session:setFollowUp': { tier: 'P1' },
  'cowork:session:backgroundTask': { tier: 'P1' },
  'cowork:session:listFeedback': { tier: 'P1' },
  'cowork:message:setFeedback': { tier: 'P1' },
  'cowork:session:readLocalImage': { tier: 'P1', restrictions: ['R-path'], note: '`02`: R-path.' },
  'cowork:stream:liveContent': { tier: 'P1', note: '`02`: used by reconnect resync.' },
  'cowork:permission:respond': { tier: 'P1' },
  'cowork:permission:listPending': { tier: 'P1', note: '`02`: pending-permission resync after a reconnect or renderer reload; read-only.' },
  'cowork:plan-mode:get': { tier: 'P1' },
  'cowork:plan-mode:set': { tier: 'P1' },
  'cowork:config:get': { tier: 'P1' },
  'cowork:config:set': { tier: 'P1', restrictions: ['R-cfg'], note: '`02`: R-cfg.' },
  'cowork:getDelegationInfo': { tier: 'P1' },
  'cowork:isDelegationBlocking': { tier: 'P1' },
  'cowork:session:ensureA2A': { tier: 'P2', note: '`02`: private chat between Bots.' },
  'cowork:session:sendOwnerA2AMessage': { tier: 'P2', note: '`02`: private chat between Bots.' },
  'cowork:session:queueA2AGuidance': { tier: 'P2', note: '`02`: private chat between Bots.' },
  'cowork:session:endA2APrivateChat': { tier: 'P2', note: '`02`: private chat between Bots.' },
  'cowork:session:getA2AEpisodes': { tier: 'P2' },
  'cowork:session:getA2AHistoryPage': { tier: 'P2' },
  'cowork:session:resendA2ADeliveryArtifact': { tier: 'P2' },
  'cowork:session:refreshPeerProfile': { tier: 'P2' },
  'cowork:session:processServiceRefund': { tier: 'P2', note: '`02`: Gig Square refunds.' },
  'cowork:memory:listEntries': { tier: 'P2' },
  'cowork:memory:createEntry': { tier: 'P2' },
  'cowork:memory:updateEntry': { tier: 'P2' },
  'cowork:memory:deleteEntry': { tier: 'P2' },
  'cowork:memory:unarchiveEntry': { tier: 'P2' },
  'cowork:memory:listScopes': { tier: 'P2' },
  'cowork:memory:getSessionScope': { tier: 'P2' },
  'cowork:memory:getStats': { tier: 'P2' },
  'cowork:memory:getPolicy': { tier: 'P2' },
  'cowork:memory:setPolicy': { tier: 'P2' },
  'cowork:memory:deletePolicy': { tier: 'P2' },
  'cowork:session:exportTranscript': { tier: 'N', note: '`02`: opens a save dialog; a mobile export facade can come later.' },
  'cowork:session:exportResultImage': { tier: 'N', note: '`02`: captures the desktop window.' },
  'cowork:session:captureImageChunk': { tier: 'N', note: '`02`: captures the desktop window.' },
  'cowork:session:saveResultImage': { tier: 'N', note: '`02`: desktop save flow.' },
  'cowork:htmlReport:exportImage': { tier: 'N', note: '`02`: hidden-window capture plus a desktop save dialog.' },
  'cowork:metafile:download': { tier: 'N', note: '`02`: opens a save dialog; the phone opens the public metafile URL instead.' },
  'cowork:sandbox:install': { tier: 'N', note: '`02`: sandbox execution is disabled in server mode.' },
  'cowork:sandbox:status': { tier: 'N', note: '`02`: sandbox execution is disabled in server mode.' },
};

// ---------------------------------------------------------------------------
// Invoke channels — section "MetaBots and Identity" of `02`.
// ---------------------------------------------------------------------------

const IDENTITY_INVOKE: Record<string, AllowlistEntry> = {
  'metabot:list': { tier: 'P1' },
  'metabot:get': { tier: 'P1' },
  'metabot:checkNameExists': { tier: 'P1' },
  'metabot:create': { tier: 'P1' },
  'metabot:update': { tier: 'P1' },
  'metabot:setEnabled': { tier: 'P1' },
  'metabot:getSetting': { tier: 'P1' },
  'metabot:setSetting': { tier: 'P1' },
  'idbots:getMetaBots': { tier: 'P1' },
  'idbots:addMetaBot': { tier: 'P1' },
  'idbots:deleteMetaBot': { tier: 'P1' },
  'idbots:syncMetaBot': { tier: 'P1' },
  'idbots:syncMetaBotEditChanges': { tier: 'P1' },
  'idbots:resumeMetabotSetup': { tier: 'P1' },
  'idbots:createMetaBotOnChain': { tier: 'P1', timeoutMs: 300_000, note: '`02`/C2 Limits: timeout 300 s.' },
  'idbots:getAddressBalance': { tier: 'P1' },
  'idbots:getMetabotWalletAssets': { tier: 'P1' },
  'idbots:getMetabotNfts': { tier: 'P1' },
  'idbots:getOfficialSkillsStatus': { tier: 'P1' },
  'idbots:getCommunitySkillsStatus': { tier: 'P1' },
  'idbots:installOfficialSkill': { tier: 'P1' },
  'idbots:syncAllOfficialSkills': { tier: 'P1' },
  'idbots:uploadMetabotHomepageFile': { tier: 'P2', restrictions: ['R-size'], note: '`02`: P2-R, R-size.' },
  'idbots:getListenerConfig': { tier: 'P2', note: '`02`: server mode keeps the listener running by default (REQ-A-8).' },
  'idbots:getListenerStatus': { tier: 'P2', note: '`02`: server mode keeps the listener running by default (REQ-A-8).' },
  'idbots:startMetaWebListener': { tier: 'P2', note: '`02`: server mode keeps the listener running by default (REQ-A-8).' },
  'idbots:toggleListener': { tier: 'P2', note: '`02`: server mode keeps the listener running by default (REQ-A-8).' },
  'idbots:assignGroupChatTask': { tier: 'P2' },
  'idbots:buildTransferPreview': { tier: 'P2', note: '`02`: read-only preview.' },
  'idbots:buildTokenTransferPreview': { tier: 'P2', note: '`02`: read-only preview.' },
  'idbots:getTransferFeeSummary': { tier: 'P2', note: '`02`: read-only preview.' },
  'idbots:getTokenTransferFeeSummary': { tier: 'P2', note: '`02`: read-only preview.' },
  'idbots:executeTransfer': { tier: 'N', note: '`02`: moving funds out of custodial wallets needs SMS re-verification; later release.' },
  'idbots:executeTokenTransfer': { tier: 'N', note: '`02`: moving funds out of custodial wallets needs SMS re-verification; later release.' },
  'idbots:transferMetabotMvcNft': { tier: 'N', note: '`02`: moving funds out of custodial wallets needs SMS re-verification; later release.' },
  'idbots:transferMetabotMrc721': { tier: 'N', note: '`02`: moving funds out of custodial wallets needs SMS re-verification; later release.' },
  'idbots:getMetaBotMnemonic': { tier: 'H', note: '`02`: C2 sensitive route only, never over the WebSocket.' },
  'idbots:restoreMetaBotFromMnemonic': { tier: 'N', note: '`02`: mnemonic input over the socket; later release.' },
  'userIdentity:get': { tier: 'P1' },
  'social:getPairRelationship': { tier: 'P1', note: '`S5`: friend badge pair state; read-only, cached.' },
  'userIdentity:updateName': { tier: 'P1' },
  'userIdentity:retryChainSync': { tier: 'P1' },
  'userIdentity:retrySubsidy': { tier: 'P1' },
  'userIdentity:revealMnemonic': { tier: 'H', note: '`02`: C2 sensitive route only, never over the WebSocket.' },
  'userIdentity:create': { tier: 'N', note: '`02`: server bootstrap creates the identity.' },
  'userIdentity:import': { tier: 'N', note: '`02`: account changes go through the control plane.' },
  'userIdentity:logout': { tier: 'N', note: '`02`: account changes go through the control plane.' },
  'metaid:getUserInfo': { tier: 'P1' },
  'metaid:resolveAvatarSource': { tier: 'P1' },
  'metaid:contacts:list': { tier: 'P2' },
  'metaid:contacts:detail': { tier: 'P2' },
  'metaid:knowledge:list': { tier: 'P2' },
  'metaid:knowledge:update': { tier: 'P2' },
  'metaid:knowledge:archive': { tier: 'P2' },
  'metaid:knowledge:delete': { tier: 'P2' },
};

// ---------------------------------------------------------------------------
// Invoke channels — sections "Skills", "Tasks", "Billing" of `02`.
// ---------------------------------------------------------------------------

const SKILLS_TASKS_BILLING_INVOKE: Record<string, AllowlistEntry> = {
  'skills:list': { tier: 'P1' },
  'skills:getConfig': { tier: 'P1' },
  'skills:setConfig': { tier: 'P1' },
  'skills:setEnabled': { tier: 'P1' },
  'skills:setScope': { tier: 'P1' },
  'skills:getAssignmentInfo': { tier: 'P1' },
  'skills:autoRoutingPrompt': { tier: 'P1' },
  'skills:getRoot': { tier: 'P1' },
  'skills:listMissing': { tier: 'P1' },
  'skills:forgetMissing': { tier: 'P1' },
  'skills:delete': { tier: 'P2' },
  'skills:testEmailConnectivity': { tier: 'P2' },
  'skills:download': { tier: 'N', note: '`02`: installs code from an arbitrary URL; official skills use idbots:installOfficialSkill.' },
  'scheduledTask:list': { tier: 'P1' },
  'scheduledTask:get': { tier: 'P1' },
  'scheduledTask:delete': { tier: 'P1' },
  'scheduledTask:toggle': { tier: 'P1' },
  'scheduledTask:runManually': { tier: 'P1' },
  'scheduledTask:stop': { tier: 'P1' },
  'scheduledTask:listRuns': { tier: 'P1' },
  'scheduledTask:countRuns': { tier: 'P1' },
  'scheduledTask:listAllRuns': { tier: 'P1' },
  'scheduledTask:create': { tier: 'P1', restrictions: ['R-cwd', 'R-exec'], note: '`02`: P1-R, R-cwd on `workingDirectory`; R-exec.' },
  'scheduledTask:update': { tier: 'P1', restrictions: ['R-cwd', 'R-exec'], note: '`02`: P1-R, R-cwd on `workingDirectory`; R-exec.' },
  'metatask:board': { tier: 'P2' },
  'metatask:get': { tier: 'P2' },
  'metatask:refresh': { tier: 'P2' },
  'traffic:ensureAccount': { tier: 'P1' },
  'traffic:getAccount': { tier: 'P1' },
  'traffic:bindAllBots': { tier: 'P1' },
  'traffic:getBalance': { tier: 'P1' },
  'traffic:getLedger': { tier: 'P1' },
  'traffic:getLocalJournal': { tier: 'P1' },
  'traffic:getDailyUsage': { tier: 'P1' },
  'traffic:getUsageSummary': { tier: 'P1' },
  'traffic:getPricing': { tier: 'P1' },
  'traffic:getRechargeGateway': { tier: 'P1' },
  'traffic:createRechargeOrder': { tier: 'P1' },
  'traffic:getRechargeOrder': { tier: 'P1' },
  'traffic:getFreeGrantCampaignStatus': { tier: 'P1' },
  'traffic:claimFreeGrant': { tier: 'P1' },
  'traffic:redeemCode': { tier: 'P1' },
  'traffic:getSettings': { tier: 'P1' },
  'traffic:mockConfirmRechargeOrder': { tier: 'P1', note: '`02`: staging only — denied when the tenant points at production Metaso.' },
  'traffic:setSettings': { tier: 'N', note: '`02`: the server sets traffic sponsorship at bootstrap.' },
  'llmRelay:getQuota': { tier: 'P1' },
  'llmRelay:bootstrap': { tier: 'N', note: '`02`: server bootstrap owns the relay key and base URL.' },
  'llmRelay:setApiBase': { tier: 'N', note: '`02`: server bootstrap owns the relay key and base URL.' },
  'llmRelay:getQuotaNudgeState': { tier: 'P1', note: '`02`: pure UI state for the free-quota nudge banner.' },
  'llmRelay:dismissQuotaNudge': { tier: 'P1', note: '`02`: pure UI state for the free-quota nudge banner.' },
  'brainSwitch:switchFreeBrainsTo': { tier: 'N', note: '`02`: server-side quota rescue owns brain routing; the channel rebinds the global default route and bot brains.' },
  'feeRates:getTiers': { tier: 'P1' },
  'feeRates:getSelected': { tier: 'P1' },
  'feeRates:select': { tier: 'P1' },
  'feeRates:refresh': { tier: 'P1' },
  'deepseek:getBalance': { tier: 'N', note: '`02`: bring-your-own-key feature, later release.' },
};

// ---------------------------------------------------------------------------
// Invoke channels — sections "Gig Square and Discovery", "Background
// Features, Knowledge, IM, Backup", "App, Config, and Utilities" of `02`.
// ---------------------------------------------------------------------------

const FEATURES_UTIL_INVOKE: Record<string, AllowlistEntry> = {
  'providerDiscovery:getOnlineBots': { tier: 'P2' },
  'providerDiscovery:getOnlineServices': { tier: 'P2' },
  'providerDiscovery:getSnapshot': { tier: 'P2' },
  'openTeamCollab:list': { tier: 'P2' },
  'openTeamCollab:listGuestInvites': { tier: 'P2' },
  'openTeamCollab:listMessages': { tier: 'P2' },
  'metawebStudy:list': { tier: 'P2' },
  'dream:getStatus': { tier: 'P2' },
  'dream:listRuns': { tier: 'P2' },
  'dream:listDailySummaries': { tier: 'P2' },
  'dream:listCapabilityDrafts': { tier: 'P2' },
  'dream:listTelemetryDaily': { tier: 'P2' },
  'dream:runNow': { tier: 'P2' },
  'surf:listRuns': { tier: 'P2' },
  'surf:runNow': { tier: 'P2' },
  'memoryHygiene:get': { tier: 'P2' },
  'memoryHygiene:setConfig': { tier: 'P2' },
  'memoryHygiene:runNow': { tier: 'P2' },
  'knowledgeBase:list': { tier: 'P2' },
  'knowledgeBase:create': { tier: 'P2' },
  'knowledgeBase:update': { tier: 'P2' },
  'knowledgeBase:remove': { tier: 'P2' },
  'knowledgeBase:learn': { tier: 'P2' },
  'knowledgeBase:importFiles': { tier: 'P2', restrictions: ['R-upload'], note: '`02`: P2-R, R-upload.' },
  'knowledgeBase:openDir': { tier: 'N', note: '`02`: opens a desktop folder.' },
  'im:config:get': { tier: 'P2', note: '`02`: answer permission requests through Feishu/DingTalk while the phone is closed.' },
  'im:config:set': { tier: 'P2', note: '`02`: answer permission requests through Feishu/DingTalk while the phone is closed.' },
  'im:status:get': { tier: 'P2', note: '`02`: answer permission requests through Feishu/DingTalk while the phone is closed.' },
  'im:gateway:start': { tier: 'P2', note: '`02`: answer permission requests through Feishu/DingTalk while the phone is closed.' },
  'im:gateway:stop': { tier: 'P2', note: '`02`: answer permission requests through Feishu/DingTalk while the phone is closed.' },
  'im:gateway:test': { tier: 'P2', note: '`02`: answer permission requests through Feishu/DingTalk while the phone is closed.' },
  'chainBackup:getState': { tier: 'P2' },
  'chainBackup:backup': { tier: 'P2', timeoutMs: 900_000, note: '`02`/C2 Limits: timeout 900 s.' },
  'chainBackup:restore': { tier: 'N', note: '`02`: needs mnemonic import; later release.' },
  'gigSquare:sendOrder': { tier: 'P2', timeoutMs: 300_000, note: '`02`/C2 Limits: timeout 300 s; exact entry so the timeout rides the channel.' },
  'app:getVersion': { tier: 'P1' },
  'app:getSystemLocale': { tier: 'P1' },
  'store:get': { tier: 'P1', restrictions: ['R-store'], note: '`02`: P1-R, R-store (only key `app_config`, apiKey redacted).' },
  'store:set': { tier: 'P1', restrictions: ['R-store'], note: '`02`: P1-R, R-store (only key `app_config`, provider entries frozen).' },
  'store:remove': { tier: 'P1', restrictions: ['R-store'], note: '`02`: P1-R, R-store (`remove` is rejected by R-store).' },
  'get-api-config': { tier: 'P1', note: '`02`: read and connection test only.' },
  'check-api-config': { tier: 'P1', note: '`02`: read and connection test only.' },
  'save-api-config': { tier: 'N', note: '`02`: provider management is not on the phone in v1.' },
  'generate-session-title': { tier: 'P1' },
  'fs:readTextFile': { tier: 'P1', restrictions: ['R-path'], note: '`02`: P1-R, R-path.' },
  'startup:rendererInitialized': { tier: 'S', note: '`02`: the mobile shim answers locally; the gateway denies it (REQ-A-2).' },
  'get-recent-cwds': { tier: 'S', note: '`02`: the mobile shim returns [].' },
  'window:isMaximized': { tier: 'S', note: '`02`: the mobile shim returns false.' },
  'dialog:selectFile': { tier: 'S', note: '`02`: shim opens the phone picker and uploads through C2.' },
  'dialog:selectDirectory': { tier: 'S', note: '`02`: shim returns a cancelled result.' },
  'dialog:saveInlineFile': { tier: 'S', note: '`02`: shim returns a cancelled result.' },
  'shell:openExternal': { tier: 'S', note: '`02`: shim opens http(s) URLs in the phone browser.' },
  'shell:openPath': { tier: 'S', note: '`02`: shim converts a /data path to a signed URL and opens it.' },
  'shell:showItemInFolder': { tier: 'S', note: '`02`: shim converts a /data path to a signed URL and opens it.' },
  'shell:openWith': { tier: 'S', note: '`02`: shim converts a /data path to a signed URL and opens it.' },
  'shell:getOpenWithApps': { tier: 'S', note: '`02`: shim converts a /data path to a signed URL and opens it.' },
  'shell:chooseOpenWithApp': { tier: 'S', note: '`02`: shim converts a /data path to a signed URL and opens it.' },
  'api:fetch': { tier: 'N', note: '`02`: generic outbound HTTP proxy.' },
  'api:stream': { tier: 'N', note: '`02`: generic outbound HTTP proxy.' },
  'api:stream:cancel': { tier: 'N', note: '`02`: generic outbound HTTP proxy.' },
  'app:getAutoLaunch': { tier: 'N', note: '`02`: desktop-only.' },
  'app:setAutoLaunch': { tier: 'N', note: '`02`: desktop-only.' },
  'app:getExperimentalAutomation': { tier: 'N', note: '`02`: desktop-only.' },
  'app:setExperimentalAutomation': { tier: 'N', note: '`02`: desktop-only.' },
  'app:getDataDirectory': { tier: 'N', note: 'feat/legacy-data-recovery ②: desktop Settings page data-directory visibility; desktop-only.' },
  'dailyReport:runNow': { tier: 'N', note: '`02`: desktop-only — spawns a local Twin report session.' },
};

// ---------------------------------------------------------------------------
// Invoke channels — "New Channels Added by WS-A" table of `02` (REQ-A-24).
// ---------------------------------------------------------------------------

const WS_A_NEW_INVOKE: Record<string, AllowlistEntry> = {
  'gateway:file:sign': { tier: 'P1', restrictions: ['R-path'], note: '`02`: C2 File Download; R-path.' },
  'mobile:permission:listPending': { tier: 'P1' },
  'mobile:bootstrap:status': { tier: 'P1' },
  'bundle:getPlans': { tier: 'P1' },
  'bundle:createOrder': { tier: 'P1' },
  'bundle:getOrder': { tier: 'P1' },
  'bundle:getMeters': { tier: 'P1' },
};

// ---------------------------------------------------------------------------
// Invoke channels present in src/main/preload.ts but NOT listed anywhere in
// `02` v1.0.0. They entered the preload on/after the 2026-10-14 inventory
// that produced `02` (git log: preference/jevRelay 2026-10-14, store:getStrict
// and cowork:session:prewarmTurnSlot 2026-10-16). `02` is frozen, so these
// tiers cannot be invented here; `02`'s default-deny rule ("Everything not
// listed as allowed is denied") makes them N until a change request adds them
// to `02`. Tracked as a change-request finding in the T2 delivery note.
// ---------------------------------------------------------------------------

const POST_FREEZE_INVOKE: Record<string, AllowlistEntry> = {
  'store:getStrict': { tier: 'N', note: 'Not in `02` v1.0.0 (preload addition of 2026-10-16); denied by `02` default-deny pending a change request.' },
  'cowork:session:prewarmTurnSlot': { tier: 'N', note: 'Not in `02` v1.0.0 (preload addition of 2026-10-16); denied by `02` default-deny pending a change request.' },
  'jevRelay:resolveCredentials': { tier: 'N', note: 'Not in `02` v1.0.0 (preload addition of 2026-10-14); denied by `02` default-deny pending a change request.' },
  'preference:listRounds': { tier: 'N', note: 'Not in `02` v1.0.0 (preload addition of 2026-10-14); denied by `02` default-deny pending a change request.' },
  'preference:roundStatus': { tier: 'N', note: 'Not in `02` v1.0.0 (preload addition of 2026-10-14); denied by `02` default-deny pending a change request.' },
  'preference:commit': { tier: 'N', note: 'Not in `02` v1.0.0 (preload addition of 2026-10-14); denied by `02` default-deny pending a change request.' },
  'preference:telemetry': { tier: 'N', note: 'Not in `02` v1.0.0 (preload addition of 2026-10-14); denied by `02` default-deny pending a change request.' },
  'preference:refresh': { tier: 'N', note: 'Not in `02` v1.0.0 (preload addition of 2026-10-14); denied by `02` default-deny pending a change request.' },
  'standingPages:create': { tier: 'N', note: 'Not in `02` v1.0.0; denied by `02` default-deny pending a change request.' },
  'standingPages:list': { tier: 'N', note: 'Not in `02` v1.0.0; denied by `02` default-deny pending a change request.' },
  'standingPages:remove': { tier: 'N', note: 'Not in `02` v1.0.0; denied by `02` default-deny pending a change request.' },
  'standingPages:restore': { tier: 'N', note: 'Not in `02` v1.0.0; denied by `02` default-deny pending a change request.' },
  'updateNotification:resolveFirstInstallVersion': { tier: 'N', note: 'Not in `02` v1.0.0 (desktop-only announcement system, 2026-10-26); denied by `02` default-deny pending a change request.' },
  'updateNotification:getFirstInstallVersion': { tier: 'N', note: 'Not in `02` v1.0.0 (desktop-only announcement system, 2026-10-26); denied by `02` default-deny pending a change request.' },
  'updateNotification:setFirstInstallVersion': { tier: 'N', note: 'Not in `02` v1.0.0 (desktop-only announcement system, 2026-10-26); denied by `02` default-deny pending a change request.' },
  'updateNotification:hasViewed': { tier: 'N', note: 'Not in `02` v1.0.0 (desktop-only announcement system, 2026-10-26); denied by `02` default-deny pending a change request.' },
  'updateNotification:markAsViewed': { tier: 'N', note: 'Not in `02` v1.0.0 (desktop-only announcement system, 2026-10-26); denied by `02` default-deny pending a change request.' },
  'updateNotification:shouldForceShow': { tier: 'N', note: 'Not in `02` v1.0.0 (desktop-only announcement system, 2026-10-26); denied by `02` default-deny pending a change request.' },
};

export const INVOKE_ALLOWLIST: Record<string, AllowlistEntry> = {
  ...COWORK_INVOKE,
  ...IDENTITY_INVOKE,
  ...SKILLS_TASKS_BILLING_INVOKE,
  ...FEATURES_UTIL_INVOKE,
  ...WS_A_NEW_INVOKE,
  ...POST_FREEZE_INVOKE,
};

// ---------------------------------------------------------------------------
// Invoke channel groups — the group rows of `02`. Exact entries above win
// over prefixes. The N families are `02`'s "Desktop-only or out of scope for
// v1" row.
// ---------------------------------------------------------------------------

export const INVOKE_ALLOWLIST_PREFIXES: Array<{ prefix: string; entry: AllowlistEntry }> = [
  { prefix: 'longtermTask:', entry: { tier: 'P1', note: '`02`: all 15 longtermTask:* channels are P1.' } },
  { prefix: 'groupTask:', entry: { tier: 'P2', note: '`02`: all 16 groupTask:* channels are P2.' } },
  {
    prefix: 'gigSquare:',
    entry: { tier: 'P2', note: '`02`: all 14 gigSquare:* channels are P2; gigSquare:sendOrder carries its own 300 s timeout entry.' },
  },
  { prefix: 'appUpdate:', entry: { tier: 'N', note: '`02`: desktop-only or out of scope for v1.' } },
  { prefix: 'botBrowser:', entry: { tier: 'N', note: '`02`: desktop-only or out of scope for v1.' } },
  { prefix: 'metaapps:', entry: { tier: 'N', note: '`02`: desktop-only or out of scope for v1.' } },
  { prefix: 'metaappOwner:', entry: { tier: 'N', note: '`02`: desktop-only or out of scope for v1.' } },
  { prefix: 'mcp:', entry: { tier: 'N', note: '`02`: desktop-only or out of scope for v1.' } },
  { prefix: 'projects:', entry: { tier: 'N', note: '`02`: desktop-only or out of scope for v1.' } },
  { prefix: 'agentGame:', entry: { tier: 'N', note: '`02`: desktop-only or out of scope for v1.' } },
  { prefix: 'teamCulture:', entry: { tier: 'N', note: '`02`: desktop-only or out of scope for v1.' } },
  { prefix: 'powerGuard:', entry: { tier: 'N', note: '`02`: desktop-only or out of scope for v1.' } },
  { prefix: 'permissions:', entry: { tier: 'N', note: '`02`: desktop-only or out of scope for v1.' } },
  { prefix: 'log:', entry: { tier: 'N', note: '`02`: desktop-only or out of scope for v1.' } },
  { prefix: 'git:', entry: { tier: 'N', note: '`02`: desktop-only or out of scope for v1.' } },
];

// ---------------------------------------------------------------------------
// Event channels — the Events table of `02`.
// ---------------------------------------------------------------------------

export const EVENT_ALLOWLIST: Record<string, AllowlistEntry> = {
  'cowork:stream:message': { tier: 'P1' },
  'cowork:stream:messageUpdate': { tier: 'P1' },
  'cowork:stream:complete': { tier: 'P1' },
  'cowork:stream:error': { tier: 'P1' },
  'cowork:stream:permission': { tier: 'P1' },
  'cowork:stream:permissionResolved': { tier: 'P1' },
  'cowork:stream:sessionTitle': { tier: 'P1' },
  'cowork:session:profileRefreshed': { tier: 'P1' },
  'cowork:delegation:stateChange': { tier: 'P1' },
  'scheduledTask:runUpdate': { tier: 'P1' },
  'scheduledTask:statusUpdate': { tier: 'P1' },
  'longtermTask:update': { tier: 'P1' },
  'llmRelay:quotaNudgeChanged': { tier: 'P1', note: '`02`: banner refresh broadcast.' },
  'skills:changed': { tier: 'P1' },
  'metabot:dreamStatusChanged': { tier: 'P1' },
  'metabot:surfStatusChanged': { tier: 'P1' },
  'store:changed': { tier: 'P1', restrictions: ['R-store'], note: '`02`: P1-R — only key `app_config`, redacted like R-store.' },
  'groupTask:statusChanged': { tier: 'P2' },
  'groupTask:checkpointChanged': { tier: 'P2' },
  'groupTask:turnActivityChanged': { tier: 'P2' },
  'groupTask:ownerReportDelivery': { tier: 'P2' },
  'metatask:update': { tier: 'P2' },
  'knowledgeBase:learnStatus': { tier: 'P2' },
  'chainBackup:progress': { tier: 'P2' },
  'providerDiscovery:changed': { tier: 'P2' },
  'memoryHygiene:statusChanged': { tier: 'P2' },
  'im:status:change': { tier: 'P2' },
  'im:message:received': { tier: 'P2' },
  'chainBackup:restoreProgress': { tier: 'N', note: '`02`: restore is not allowed.' },
  'agentGame:consentRequired': { tier: 'N', note: '`02`: named agentGame:* event, tier N.' },
  'agentGame:sessionUpdated': { tier: 'N', note: '`02`: named agentGame:* event, tier N.' },
  'app:newTask': { tier: 'N', note: '`02`: N event.' },
  'app:openSettings': { tier: 'N', note: '`02`: N event.' },
  'appUpdate:downloadProgress': { tier: 'N', note: '`02`: N event.' },
  'cowork:sandbox:downloadProgress': { tier: 'N', note: '`02`: N event.' },
  'idbots:listener-log': { tier: 'N', note: '`02`: N event.' },
  'metaapps:changed': { tier: 'N', note: '`02`: N event.' },
  'powerGuard:changed': { tier: 'N', note: '`02`: N event.' },
  'window:state-changed': { tier: 'N', note: '`02`: N event.' },
  // Preload event not listed in `02` v1.0.0 (preload addition of 2026-10-14);
  // denied by `02` default-deny pending a change request (same finding as the
  // preference:* invoke entries above).
  'preference:update': { tier: 'N', note: 'Not in `02` v1.0.0; denied by `02` default-deny pending a change request.' },
};

// Event channel groups: `agentGame:*` and `botBrowser:*` are N families in
// `02`'s Events table; `api:stream:` covers the per-request template event
// channels the preload registers for the N-tier api:stream invoke (see
// scripts/ipc-contract-overrides.json). Exact entries above win over prefixes.
export const EVENT_ALLOWLIST_PREFIXES: Array<{ prefix: string; entry: AllowlistEntry }> = [
  { prefix: 'agentGame:', entry: { tier: 'N', note: '`02`: agentGame:* events are N.' } },
  { prefix: 'botBrowser:', entry: { tier: 'N', note: '`02`: botBrowser:* events are N.' } },
  {
    prefix: 'api:stream:',
    entry: { tier: 'N', note: 'Per-request template events of the N-tier api:stream invoke; not listed in `02` v1.0.0, denied by default pending a change request.' },
  },
];

// ---------------------------------------------------------------------------
// Renderer-to-main `send` channels — `02`'s last row: all N, "the shim drops
// them". The gateway denies them in v1.
// ---------------------------------------------------------------------------

export const SEND_CHANNELS: string[] = [
  'window-close',
  'window-maximize',
  'window-minimize',
  'window:move-by',
  'window:showSystemMenu',
  'network:status-change',
  'botBrowser:capture-request:response',
  'botBrowser:tab-command:response',
];

// ---------------------------------------------------------------------------
// Lookup helpers — pure functions. Exact entries win over prefixes; the
// longest matching prefix wins among prefixes; unknown channels get the
// default-deny entry `{ tier: 'N' }` with matched: 'default'.
// ---------------------------------------------------------------------------

export interface AllowlistLookup {
  entry: AllowlistEntry;
  matched: 'exact' | 'prefix' | 'default';
}

const DEFAULT_DENY_ENTRY: AllowlistEntry = { tier: 'N' };

function lookupWithPrefixes(
  channel: string,
  exact: Record<string, AllowlistEntry>,
  prefixes: Array<{ prefix: string; entry: AllowlistEntry }>,
): AllowlistLookup {
  const exactEntry = exact[channel];
  if (exactEntry) {
    return { entry: exactEntry, matched: 'exact' };
  }
  let best: { prefix: string; entry: AllowlistEntry } | null = null;
  for (const candidate of prefixes) {
    if (!channel.startsWith(candidate.prefix)) continue;
    if (best === null || candidate.prefix.length > best.prefix.length) {
      best = candidate;
    }
  }
  if (best) {
    return { entry: best.entry, matched: 'prefix' };
  }
  return { entry: DEFAULT_DENY_ENTRY, matched: 'default' };
}

export function lookupInvokeChannelWithSource(channel: string): AllowlistLookup {
  return lookupWithPrefixes(channel, INVOKE_ALLOWLIST, INVOKE_ALLOWLIST_PREFIXES);
}

export function lookupInvokeChannel(channel: string): AllowlistEntry {
  return lookupInvokeChannelWithSource(channel).entry;
}

export function lookupEventChannelWithSource(channel: string): AllowlistLookup {
  return lookupWithPrefixes(channel, EVENT_ALLOWLIST, EVENT_ALLOWLIST_PREFIXES);
}

export function lookupEventChannel(channel: string): AllowlistEntry {
  return lookupEventChannelWithSource(channel).entry;
}
