import { contextBridge, ipcRenderer } from 'electron';
import type {
  CoworkA2AGuidanceRequest,
  CoworkA2AOwnerMessageRequest,
  CoworkPermissionMode,
  CoworkSubmitInput,
  CoworkSubmitInputResult,
} from '../renderer/types/cowork';
import type { KnowledgeBaseLearnStatusEvent } from '../renderer/types/knowledgeBase';

// 暴露安全的 API 到渲染进程
contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  arch: process.arch,
  store: {
    get: (key: string) => ipcRenderer.invoke('store:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('store:set', key, value),
    remove: (key: string) => ipcRenderer.invoke('store:remove', key),
    onChanged: (callback: (payload: { key: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: { key: string }) => callback(payload);
      ipcRenderer.on('store:changed', handler);
      return () => {
        ipcRenderer.removeListener('store:changed', handler);
      };
    },
  },
  powerGuard: {
    getStatus: () => ipcRenderer.invoke('powerGuard:status'),
    getPreventDeviceSleep: () => ipcRenderer.invoke('powerGuard:getPreventDeviceSleep'),
    setPreventDeviceSleep: (enabled: boolean) => ipcRenderer.invoke('powerGuard:setPreventDeviceSleep', enabled),
    onChanged: (callback: (state: { active: boolean; sources: string[]; engaged: boolean; engagedBy: 'caffeinate' | 'powerSaveBlocker' | null; preventDeviceSleepEnabled: boolean }) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        state: { active: boolean; sources: string[]; engaged: boolean; engagedBy: 'caffeinate' | 'powerSaveBlocker' | null; preventDeviceSleepEnabled: boolean },
      ) => callback(state);
      ipcRenderer.on('powerGuard:changed', handler);
      return () => ipcRenderer.removeListener('powerGuard:changed', handler);
    },
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    setEnabled: (options: { id: string; enabled: boolean }) => ipcRenderer.invoke('skills:setEnabled', options),
    delete: (id: string) => ipcRenderer.invoke('skills:delete', id),
    download: (source: string) => ipcRenderer.invoke('skills:download', source),
    getRoot: () => ipcRenderer.invoke('skills:getRoot'),
    autoRoutingPrompt: () => ipcRenderer.invoke('skills:autoRoutingPrompt'),
    getAssignmentInfo: () => ipcRenderer.invoke('skills:getAssignmentInfo'),
    listMissing: () => ipcRenderer.invoke('skills:listMissing'),
    forgetMissing: (id: string) => ipcRenderer.invoke('skills:forgetMissing', id),
    setScope: (options: { id: string; scope: 'library' | 'global' | 'bots'; metabotIds?: number[] }) =>
      ipcRenderer.invoke('skills:setScope', options),
    getConfig: (skillId: string) => ipcRenderer.invoke('skills:getConfig', skillId),
    setConfig: (skillId: string, config: Record<string, string>) => ipcRenderer.invoke('skills:setConfig', skillId, config),
    testEmailConnectivity: (skillId: string, config: Record<string, string>) =>
      ipcRenderer.invoke('skills:testEmailConnectivity', skillId, config),
    onChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('skills:changed', handler);
      return () => ipcRenderer.removeListener('skills:changed', handler);
    },
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    create: (data: any) => ipcRenderer.invoke('mcp:create', data),
    update: (id: string, data: any) => ipcRenderer.invoke('mcp:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('mcp:delete', id),
    setEnabled: (options: { id: string; enabled: boolean }) => ipcRenderer.invoke('mcp:setEnabled', options),
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    create: (data: any) => ipcRenderer.invoke('projects:create', data),
    update: (id: string, data: any) => ipcRenderer.invoke('projects:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('projects:delete', id),
    setEnabled: (options: { id: string; enabled: boolean }) => ipcRenderer.invoke('projects:setEnabled', options),
  },
  metaapps: {
    list: () => ipcRenderer.invoke('metaapps:list'),
    listCommunity: (input?: { cursor?: string; size?: number }) => ipcRenderer.invoke('metaapps:listCommunity', input),
    installCommunity: (input: { sourcePinId: string }) => ipcRenderer.invoke('metaapps:installCommunity', input),
    open: (input: { appId: string; targetPath?: string }) => ipcRenderer.invoke('metaapps:open', input),
    resolveUrl: (input: { appId: string; targetPath?: string }) => ipcRenderer.invoke('metaapps:resolveUrl', input),
    autoRoutingPrompt: () => ipcRenderer.invoke('metaapps:autoRoutingPrompt'),
    onChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('metaapps:changed', handler);
      return () => ipcRenderer.removeListener('metaapps:changed', handler);
    },
  },
  metaappOwner: {
    list: (input: { metabotId: number; cursor?: string; size?: number }) =>
      ipcRenderer.invoke('metaappOwner:list', input),
    publish: (input: { metabotId: number; manifest: Record<string, unknown>; confirm?: boolean; network?: string }) =>
      ipcRenderer.invoke('metaappOwner:publish', input),
    update: (input: { metabotId: number; targetPinId: string; firstPinId?: string; manifest: Record<string, unknown>; confirm?: boolean; network?: string }) =>
      ipcRenderer.invoke('metaappOwner:update', input),
    remove: (input: { metabotId: number; targetPinId: string; firstPinId?: string; confirm?: boolean; network?: string }) =>
      ipcRenderer.invoke('metaappOwner:delete', input),
  },
  botBrowser: {
    onOpenUri: (callback: (input: { uri: string; actorId?: string | null }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, input: { uri: string; actorId?: string | null }) => callback(input);
      ipcRenderer.on('botBrowser:openUri', handler);
      return () => ipcRenderer.removeListener('botBrowser:openUri', handler);
    },
    onTabCommand: (callback: (input: {
      requestId: string;
      command: {
        action: 'open-tab' | 'close-tab' | 'switch-tab' | 'get-tabs' | 'get-active-tab';
        uri?: string;
        tabId?: number;
      };
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, input: Parameters<typeof callback>[0]) => callback(input);
      ipcRenderer.on('botBrowser:tab-command', handler);
      return () => ipcRenderer.removeListener('botBrowser:tab-command', handler);
    },
    respondToTabCommand: (response: {
      requestId: string;
      success: boolean;
      result?: unknown;
      error?: string;
    }) => ipcRenderer.send('botBrowser:tab-command:response', response),
    onCaptureRequest: (callback: (input: {
      requestId: string;
      tabId?: number;
      fullSurface?: boolean;
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, input: Parameters<typeof callback>[0]) => callback(input);
      ipcRenderer.on('botBrowser:capture-request', handler);
      return () => ipcRenderer.removeListener('botBrowser:capture-request', handler);
    },
    respondToCaptureRequest: (response: {
      requestId: string;
      success: boolean;
      result?: { data: string; mimeType: string; width: number; height: number };
      error?: string;
    }) => ipcRenderer.send('botBrowser:capture-request:response', response),
    capturePage: (options: {
      rect: { x: number; y: number; width: number; height: number };
      format?: 'png' | 'jpeg';
      quality?: number;
    }) => ipcRenderer.invoke('botBrowser:capturePage', options),
    resolveResource: (input: { actorId?: string; uri: string }) =>
      ipcRenderer.invoke('botBrowser:resolveResource', input),
    getProfile: (input: { actorId?: string; globalMetaId: string }) =>
      ipcRenderer.invoke('botBrowser:getProfile', input),
    getSettings: (input?: { actorId?: string }) =>
      ipcRenderer.invoke('botBrowser:getSettings', input),
    updateSettings: (input: { actorId?: string; browser?: Record<string, unknown> }) =>
      ipcRenderer.invoke('botBrowser:updateSettings', input),
    resolveMetaAppPin: (input: { pinId: string }) => ipcRenderer.invoke('botBrowser:resolveMetaAppPin', input),
    getMetaAppCache: () => ipcRenderer.invoke('botBrowser:getMetaAppCache'),
    clearMetaAppCache: (input?: { all?: boolean; scope?: string; pinId?: string; cacheKey?: string }) =>
      ipcRenderer.invoke('botBrowser:clearMetaAppCache', input),
    writeMetaIdPin: (input: { actorId?: string; resourceUri?: string; sessionId?: string; payload?: unknown; network?: string }) =>
      ipcRenderer.invoke('botBrowser:writeMetaIdPin', input),
    uploadMetaFile: (input: { actorId?: string; resourceUri?: string; sessionId?: string; payload?: unknown; network?: string }) =>
      ipcRenderer.invoke('botBrowser:uploadMetaFile', input),
    completeLlm: (input: { actorId?: string; resourceUri?: string; sessionId?: string; payload?: unknown }) =>
      ipcRenderer.invoke('botBrowser:completeLlm', input),
    requestPermissions: (input: { actorId?: string; resourceUri?: string; sessionId?: string; payload?: unknown }) =>
      ipcRenderer.invoke('botBrowser:requestPermissions', input),
    sendPrivateChat: (input: {
      actorId?: string;
      peerGlobalMetaId?: string;
      content?: string;
      replyPin?: string;
      network?: string;
    }) => ipcRenderer.invoke('botBrowser:sendPrivateChat', input),
  },
  agentGame: {
    // browser.app.session.* dispatch (start/list/status/pause/resume/stop).
    session: (input: { method: string; payload?: unknown; actorId?: string; resourceUri?: string }) =>
      ipcRenderer.invoke('agentGame:session', input),
    respondConsent: (input: { requestId: string; approved: boolean; reason?: string }) =>
      ipcRenderer.invoke('agentGame:respondConsent', input),
    listPendingConsent: () => ipcRenderer.invoke('agentGame:listPendingConsent'),
    listSessions: (input?: { appId?: string; status?: string; groupId?: string }) =>
      ipcRenderer.invoke('agentGame:listSessions', input),
    onConsentRequired: (callback: (info: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, info: unknown) => callback(info);
      ipcRenderer.on('agentGame:consentRequired', handler);
      return () => ipcRenderer.removeListener('agentGame:consentRequired', handler);
    },
    onSessionUpdated: (callback: (session: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, session: unknown) => callback(session);
      ipcRenderer.on('agentGame:sessionUpdated', handler);
      return () => ipcRenderer.removeListener('agentGame:sessionUpdated', handler);
    },
  },
  permissions: {
    checkCalendar: () => ipcRenderer.invoke('permissions:checkCalendar'),
    requestCalendar: () => ipcRenderer.invoke('permissions:requestCalendar'),
  },
  api: {
    // 普通 API 请求（非流式）
    fetch: (options: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }) => ipcRenderer.invoke('api:fetch', options),

    // 流式 API 请求
    stream: (options: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
      requestId: string;
    }) => ipcRenderer.invoke('api:stream', options),

    // 取消流式请求
    cancelStream: (requestId: string) => ipcRenderer.invoke('api:stream:cancel', requestId),

    // 监听流式数据
    onStreamData: (requestId: string, callback: (chunk: string) => void) => {
      const handler = (_event: any, chunk: string) => callback(chunk);
      ipcRenderer.on(`api:stream:${requestId}:data`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:data`, handler);
    },

    // 监听流式完成
    onStreamDone: (requestId: string, callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(`api:stream:${requestId}:done`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:done`, handler);
    },

    // 监听流式错误
    onStreamError: (requestId: string, callback: (error: string) => void) => {
      const handler = (_event: any, error: string) => callback(error);
      ipcRenderer.on(`api:stream:${requestId}:error`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:error`, handler);
    },

    // 监听流式取消
    onStreamAbort: (requestId: string, callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(`api:stream:${requestId}:abort`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:abort`, handler);
    },
  },
  gigSquare: {
    fetchServices: () => ipcRenderer.invoke('gigSquare:fetchServices'),
    fetchMyServices: (params?: { page?: number; pageSize?: number; refresh?: boolean }) =>
      ipcRenderer.invoke('gigSquare:fetchMyServices', params),
    fetchMyServiceOrders: (params: { serviceId: string; page?: number; pageSize?: number; refresh?: boolean }) =>
      ipcRenderer.invoke('gigSquare:fetchMyServiceOrders', params),
    fetchRefunds: () => ipcRenderer.invoke('gigSquare:fetchRefunds'),
    processRefundOrder: (params: { orderId: string }) =>
      ipcRenderer.invoke('gigSquare:processRefundOrder', params),
    syncFromRemote: () => ipcRenderer.invoke('gigSquare:syncFromRemote'),
    fetchProviderInfo: (params: { providerMetaId?: string; providerGlobalMetaId?: string; providerAddress?: string }) =>
      ipcRenderer.invoke('gigSquare:fetchProviderInfo', params),
    preflightOrder: (params: { metabotId: number; toGlobalMetaId: string }) =>
      ipcRenderer.invoke('gigSquare:preflightOrder', params),
    publishService: (params: {
      metabotId: number;
      serviceName: string;
      displayName: string;
      description: string;
      executionReminder?: string;
      providerSkills?: string[];
      providerSkill?: string;
      paymentTiming?: 'free' | 'prepaid' | string;
      price: string;
      currency: string;
      protocolSettlementKind?: 'native' | 'fiat' | string;
      metadata?: string;
      mrc20Ticker?: string;
      mrc20Id?: string;
      outputType: string;
      serviceIconDataUrl?: string | null;
    }) => ipcRenderer.invoke('gigSquare:publishService', params),
    revokeService: (params: { serviceId: string }) =>
      ipcRenderer.invoke('gigSquare:revokeService', params),
    modifyService: (params: {
      serviceId: string;
      serviceName?: string;
      displayName?: string;
      description?: string;
      executionReminder?: string;
      providerSkills?: string[];
      providerSkill?: string;
      paymentTiming?: 'free' | 'prepaid' | string;
      price?: string;
      currency?: string;
      protocolSettlementKind?: 'native' | 'fiat' | string;
      metadata?: string;
      mrc20Ticker?: string;
      mrc20Id?: string;
      outputType?: string;
      serviceIconDataUrl?: string | null;
    }) => ipcRenderer.invoke('gigSquare:modifyService', params),
    createServiceOrderPin: (params: {
      metabotId: number;
      servicePinId?: string | null;
      paymentTxid?: string | null;
      price?: string | null;
      currency?: string | null;
      settlementKind?: string | null;
      metadata?: string | null;
    }) => ipcRenderer.invoke('gigSquare:createServiceOrderPin', params),
    sendOrder: (params: {
      metabotId: number;
      toGlobalMetaId: string;
      toChatPubkey: string;
      orderPayload: string;
      peerName?: string | null;
      peerAvatar?: string | null;
      serviceId?: string | null;
      servicePrice?: string | null;
      serviceCurrency?: string | null;
      servicePaymentChain?: string | null;
      serviceSettlementKind?: 'native' | 'mrc20' | string | null;
      serviceMrc20Ticker?: string | null;
      serviceMrc20Id?: string | null;
      servicePaymentCommitTxid?: string | null;
      serviceSkill?: string | null;
      serviceOutputType?: string | null;
      serverBotGlobalMetaId?: string | null;
      serviceOrderPinId?: string | null;
      servicePaidTx?: string | null;
    }) => ipcRenderer.invoke('gigSquare:sendOrder', params),
    pingProvider: (params: {
      metabotId: number;
      toGlobalMetaId: string;
      toChatPubkey: string;
      timeoutMs?: number;
    }) => ipcRenderer.invoke('gigSquare:pingProvider', params),
  },
  providerDiscovery: {
    getOnlineServices: () =>
      ipcRenderer.invoke('providerDiscovery:getOnlineServices'),
    getOnlineBots: () =>
      ipcRenderer.invoke('providerDiscovery:getOnlineBots'),
    getSnapshot: () =>
      ipcRenderer.invoke('providerDiscovery:getSnapshot'),
    onChanged: (callback: (data: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('providerDiscovery:changed', handler);
      return () => ipcRenderer.removeListener('providerDiscovery:changed', handler);
    },
  },
  appEvents: {
    onOpenSettings: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('app:openSettings', handler);
      return () => ipcRenderer.removeListener('app:openSettings', handler);
    },
    onNewTask: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('app:newTask', handler);
      return () => ipcRenderer.removeListener('app:newTask', handler);
    },
  },
  window: {
    minimize: () => ipcRenderer.send('window-minimize'),
    toggleMaximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    moveBy: (dx: number, dy: number) => ipcRenderer.send('window:move-by', { dx, dy }),
    showSystemMenu: (position: { x: number; y: number }) => ipcRenderer.send('window:showSystemMenu', position),
    onStateChanged: (callback: (state: { isMaximized: boolean; isFullscreen: boolean; isFocused: boolean }) => void) => {
      const handler = (_event: any, state: { isMaximized: boolean; isFullscreen: boolean; isFocused: boolean }) => callback(state);
      ipcRenderer.on('window:state-changed', handler);
      return () => ipcRenderer.removeListener('window:state-changed', handler);
    },
  },
  getApiConfig: () => ipcRenderer.invoke('get-api-config'),
  checkApiConfig: () => ipcRenderer.invoke('check-api-config'),
  saveApiConfig: (config: { apiKey: string; baseURL: string; model: string; apiType?: 'anthropic' | 'openai' }) =>
    ipcRenderer.invoke('save-api-config', config),
  deepseek: {
    // Fetch wallet balance + availability from GET /user/balance.
    getBalance: () => ipcRenderer.invoke('deepseek:getBalance'),
  },
  generateSessionTitle: (userInput: string | null) =>
    ipcRenderer.invoke('generate-session-title', userInput),
  getRecentCwds: (limit?: number) =>
    ipcRenderer.invoke('get-recent-cwds', limit),
  getGitBranch: (cwd: string) =>
    ipcRenderer.invoke('git:getBranch', cwd),
  cowork: {
    // Session management
    startSession: (options: { prompt: string; cwd?: string; systemPrompt?: string; title?: string; activeSkillIds?: string[]; metabotId?: number | null; sessionType?: 'standard' | 'browser'; model?: string | null; modelProvider?: string | null; effort?: string | null; source?: 'quick_action'; projectId?: string | null; goal?: string }) =>
      ipcRenderer.invoke('cowork:session:start', options),
    continueSession: (options: { sessionId: string; prompt: string; systemPrompt?: string; activeSkillIds?: string[] }) =>
      ipcRenderer.invoke('cowork:session:continue', options),
    submitInput: (input: CoworkSubmitInput): Promise<CoworkSubmitInputResult> =>
      ipcRenderer.invoke('cowork:session:submitInput', input),
    stopSession: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:stop', sessionId),
    setPermissionMode: (sessionId: string, permissionMode: CoworkPermissionMode) =>
      ipcRenderer.invoke('cowork:session:setPermissionMode', { sessionId, permissionMode }),
    setSessionGoal: (sessionId: string, goal: { text: string; status: 'active' | 'paused' } | null) =>
      ipcRenderer.invoke('cowork:session:setGoal', { sessionId, goal }),
    requestManualCompaction: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:compact', sessionId),
    exportTranscript: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:exportTranscript', sessionId),
    stopTask: (sessionId: string, taskId: string) =>
      ipcRenderer.invoke('cowork:session:stopTask', { sessionId, taskId }),
    backgroundTask: (sessionId: string, toolUseId?: string) =>
      ipcRenderer.invoke('cowork:session:backgroundTask', { sessionId, toolUseId }),
    forkSession: (sessionId: string, messageId: string, title?: string) =>
      ipcRenderer.invoke('cowork:session:fork', { sessionId, messageId, title }),
    rewindSession: (sessionId: string, messageId: string) =>
      ipcRenderer.invoke('cowork:session:rewind', { sessionId, messageId }),
    getSubagents: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:getSubagents', sessionId),
    getSubagentMessages: (sessionId: string, agentId: string, limit?: number) =>
      ipcRenderer.invoke('cowork:session:getSubagentMessages', { sessionId, agentId, limit }),
    setEffort: (sessionId: string, effort: string | null) =>
      ipcRenderer.invoke('cowork:session:setEffort', { sessionId, effort }),
    getAutoApproveTools: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:getAutoApproveTools', sessionId),
    addAutoApproveTool: (sessionId: string, toolName: string) =>
      ipcRenderer.invoke('cowork:session:addAutoApproveTool', { sessionId, toolName }),
    removeAutoApproveTool: (sessionId: string, toolName: string) =>
      ipcRenderer.invoke('cowork:session:removeAutoApproveTool', { sessionId, toolName }),
    endA2APrivateChat: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:endA2APrivateChat', sessionId),
    clearSessionError: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:clearError', sessionId),
    ensureA2ASession: (input: {
      actorId?: string | null;
      localMetabotId?: number | null;
      peerGlobalMetaId: string;
      peerName?: string | null;
      peerAvatar?: string | null;
    }) =>
      ipcRenderer.invoke('cowork:session:ensureA2A', input),
    queueA2AGuidance: (input: CoworkA2AGuidanceRequest) =>
      ipcRenderer.invoke('cowork:session:queueA2AGuidance', input),
    sendOwnerA2AMessage: (input: CoworkA2AOwnerMessageRequest) =>
      ipcRenderer.invoke('cowork:session:sendOwnerA2AMessage', input),
    resendA2ADeliveryArtifact: (input: string | { sessionId: string; orderTxid?: string | null }) =>
      ipcRenderer.invoke('cowork:session:resendA2ADeliveryArtifact', input),
    archiveSession: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:archive', sessionId),
    unarchiveSession: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:unarchive', sessionId),
    listArchivedSessions: (options?: { metabotId?: number | null; query?: string; searchContent?: boolean; sessionType?: 'standard' | 'a2a' | 'browser' | 'group_task'; limit?: number; offset?: number }) =>
      ipcRenderer.invoke('cowork:session:listArchived', options),
    setSessionPinned: (options: { sessionId: string; pinned: boolean }) =>
      ipcRenderer.invoke('cowork:session:pin', options),
    setSessionFoldOverride: (options: { sessionId: string; override: 'in' | 'out' | null }) =>
      ipcRenderer.invoke('cowork:session:foldOverride', options),
    setSessionModel: (options: {
      sessionId: string;
      model: string | null;
      /** Optional per-session effort (off/low/high/max, or the 'default' sentinel for an explicit Default pick); undefined leaves it unchanged. */
      effort?: string | null;
      /** Provider key the model was picked from; required when model ids collide. */
      modelProvider?: string | null;
    }) =>
      ipcRenderer.invoke('cowork:session:setModel', options),
    renameSession: (options: { sessionId: string; title: string }) =>
      ipcRenderer.invoke('cowork:session:rename', options),
    setPlanMode: (options: { sessionId: string; active: boolean }) =>
      ipcRenderer.invoke('cowork:plan-mode:set', options),
    getPlanMode: (options: { sessionId: string }) =>
      ipcRenderer.invoke('cowork:plan-mode:get', options),
    getSession: (sessionId: string, options?: { messageLimit?: number }) =>
      ipcRenderer.invoke('cowork:session:get', options ? { sessionId, ...options } : sessionId),
    refreshPeerProfile: (input: { sessionId: string; force?: boolean }) =>
      ipcRenderer.invoke('cowork:session:refreshPeerProfile', input),
    getSessionMessagesPage: (input: {
      sessionId: string;
      beforeSequence?: number | null;
      beforeTranscriptCursor?: string | null;
      limit?: number;
    }) =>
      ipcRenderer.invoke('cowork:session:getMessagesPage', input),
    setMessageFeedback: (input: { messageId: string; rating: 'up' | 'down' | null; comment?: string | null }) =>
      ipcRenderer.invoke('cowork:message:setFeedback', input),
    listSessionFeedback: (input: { sessionId: string }) =>
      ipcRenderer.invoke('cowork:session:listFeedback', input),
    getA2AConversationHistoryPage: (input: {
      sessionId: string;
      beforeCursor?: { episodeIndex: number | null; beforeSequence: number | null } | null;
      limit?: number;
    }) => ipcRenderer.invoke('cowork:session:getA2AHistoryPage', input),
    getA2AEpisodes: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:getA2AEpisodes', sessionId),
    listSessions: (options?: { metabotId?: number | null }) =>
      ipcRenderer.invoke('cowork:session:list', options),
    listMetabotAvatars: (metabotIds: number[]) =>
      ipcRenderer.invoke('cowork:session:listMetabotAvatars', metabotIds),
    processServiceRefund: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:processServiceRefund', sessionId),
    readLocalImage: (options: { path: string; maxBytes?: number }) =>
      ipcRenderer.invoke('cowork:session:readLocalImage', options),
    exportResultImage: (options: { rect: { x: number; y: number; width: number; height: number }; defaultFileName?: string }) =>
      ipcRenderer.invoke('cowork:session:exportResultImage', options),
    captureImageChunk: (options: { rect: { x: number; y: number; width: number; height: number } }) =>
      ipcRenderer.invoke('cowork:session:captureImageChunk', options),
    saveResultImage: (options: { pngBase64: string; defaultFileName?: string }) =>
      ipcRenderer.invoke('cowork:session:saveResultImage', options),
    downloadMetafile: (options: { url: string; fallbackUrl?: string; fileName?: string }) =>
      ipcRenderer.invoke('cowork:metafile:download', options),

    // Permission handling
    respondToPermission: (options: { requestId: string; result: any }) =>
      ipcRenderer.invoke('cowork:permission:respond', options),

    // Configuration
    getConfig: () =>
      ipcRenderer.invoke('cowork:config:get'),
    setConfig: (config: {
      workingDirectory?: string;
      executionMode?: 'auto' | 'local' | 'sandbox';
      memoryEnabled?: boolean;
      memoryImplicitUpdateEnabled?: boolean;
      memoryLlmJudgeEnabled?: boolean;
      memoryGuardLevel?: 'strict' | 'standard' | 'relaxed';
      memoryUserMemoriesMaxItems?: number;
      lastWorkspaceSelection?: { kind: 'project' | 'folder' | 'botWorkspace'; projectId?: string; name?: string; cwd?: string } | null;
    }) =>
      ipcRenderer.invoke('cowork:config:set', config),
    listMemoryEntries: (input: {
      sessionId?: string;
      metabotId?: number;
      scopeKind?: 'owner' | 'contact' | 'conversation';
      scopeKey?: string;
      usageClass?: 'profile_fact' | 'preference' | 'operational_preference' | 'self_identity' | 'work_review' | 'value_boundary';
      query?: string;
      status?: 'created' | 'stale' | 'deleted' | 'all';
      includeDeleted?: boolean;
      includeArchived?: boolean;
      limit?: number;
      offset?: number;
    }) =>
      ipcRenderer.invoke('cowork:memory:listEntries', input),
    unarchiveMemoryEntry: (input: { id: string }) =>
      ipcRenderer.invoke('cowork:memory:unarchiveEntry', input),
    onMemoryHygieneStatusChanged: (callback: (stats: {
      dateKey: string;
      ranAt: number;
      trigger: 'scheduled' | 'manual';
      counts: Record<string, number>;
      errors: string[];
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, stats: {
        dateKey: string;
        ranAt: number;
        trigger: 'scheduled' | 'manual';
        counts: Record<string, number>;
        errors: string[];
      }) => callback(stats);
      ipcRenderer.on('memoryHygiene:statusChanged', handler);
      return () => ipcRenderer.removeListener('memoryHygiene:statusChanged', handler);
    },
    createMemoryEntry: (input: {
      sessionId?: string;
      metabotId?: number;
      scopeKind?: 'owner' | 'contact' | 'conversation';
      scopeKey?: string;
      usageClass?: 'profile_fact' | 'preference' | 'operational_preference' | 'work_review' | 'value_boundary';
      visibility?: 'local_only' | 'external_safe';
      text: string;
      confidence?: number;
      isExplicit?: boolean;
    }) =>
      ipcRenderer.invoke('cowork:memory:createEntry', input),
    updateMemoryEntry: (input: {
      sessionId?: string;
      metabotId?: number;
      scopeKind?: 'owner' | 'contact' | 'conversation';
      scopeKey?: string;
      usageClass?: 'profile_fact' | 'preference' | 'operational_preference' | 'work_review' | 'value_boundary';
      visibility?: 'local_only' | 'external_safe';
      id: string;
      text?: string;
      confidence?: number;
      status?: 'created' | 'stale' | 'deleted';
      isExplicit?: boolean;
    }) =>
      ipcRenderer.invoke('cowork:memory:updateEntry', input),
    deleteMemoryEntry: (input: { sessionId?: string; metabotId?: number; id: string }) =>
      ipcRenderer.invoke('cowork:memory:deleteEntry', input),
    getMemoryStats: (input?: { sessionId?: string; metabotId?: number; scopeKind?: 'owner' | 'contact' | 'conversation'; scopeKey?: string }) =>
      ipcRenderer.invoke('cowork:memory:getStats', input),
    listMemoryScopes: (input: { metabotId?: number }) =>
      ipcRenderer.invoke('cowork:memory:listScopes', input),
    getSessionMemoryScope: (input: { sessionId?: string }) =>
      ipcRenderer.invoke('cowork:memory:getSessionScope', input),
    getMemoryPolicy: (input?: { sessionId?: string; metabotId?: number }) =>
      ipcRenderer.invoke('cowork:memory:getPolicy', input),
    setMemoryPolicy: (input: {
      metabotId: number;
      memoryEnabled?: boolean;
      memoryImplicitUpdateEnabled?: boolean;
      memoryLlmJudgeEnabled?: boolean;
      memoryGuardLevel?: 'strict' | 'standard' | 'relaxed';
      memoryUserMemoriesMaxItems?: number;
      dreamEnabled?: boolean;
      hygieneEnabled?: boolean;
    }) =>
      ipcRenderer.invoke('cowork:memory:setPolicy', input),
    getMemoryHygiene: () =>
      ipcRenderer.invoke('memoryHygiene:get'),
    setMemoryHygieneConfig: (input: Record<string, unknown>) =>
      ipcRenderer.invoke('memoryHygiene:setConfig', input),
    runMemoryHygieneNow: () =>
      ipcRenderer.invoke('memoryHygiene:runNow'),
    listTeamCulture: (input?: {
      kind?: 'glossary' | 'convention' | 'team_lesson' | 'all';
      status?: 'active' | 'superseded' | 'archived' | 'all';
      query?: string;
      limit?: number;
      offset?: number;
    }) =>
      ipcRenderer.invoke('teamCulture:list', input),
    listTeamCultureDistillationLog: () =>
      ipcRenderer.invoke('teamCulture:distillationLog'),
    upsertTeamCulture: (input: {
      kind?: 'glossary' | 'convention' | 'team_lesson';
      topic: string;
      text: string;
    }) =>
      ipcRenderer.invoke('teamCulture:upsert', input),
    updateTeamCulture: (input: {
      id: string;
      kind?: 'glossary' | 'convention' | 'team_lesson';
      topic?: string;
      text?: string;
    }) =>
      ipcRenderer.invoke('teamCulture:update', input),
    archiveTeamCulture: (input: { id: string }) =>
      ipcRenderer.invoke('teamCulture:archive', input),
    restoreTeamCulture: (input: { id: string }) =>
      ipcRenderer.invoke('teamCulture:restore', input),
    deleteTeamCulture: (input: { id: string }) =>
      ipcRenderer.invoke('teamCulture:delete', input),
    listTaskCommTrend: () =>
      ipcRenderer.invoke('teamCulture:commTrend'),
    getTeamCultureConfig: () =>
      ipcRenderer.invoke('teamCulture:getConfig'),
    setTeamCultureConfig: (input: { enabled: boolean }) =>
      ipcRenderer.invoke('teamCulture:setConfig', input),
    approveTeamCulture: (input: { id: string }) =>
      ipcRenderer.invoke('teamCulture:approve', input),
    listKnowledge: (input: {
      metabotId: number;
      kind?: 'know_how' | 'pitfall' | 'principle';
      status?: 'active' | 'superseded' | 'archived' | 'all';
      query?: string;
      limit?: number;
      offset?: number;
    }) =>
      ipcRenderer.invoke('metaid:knowledge:list', input),
    archiveKnowledge: (input: { id: string; metabotId: number }) =>
      ipcRenderer.invoke('metaid:knowledge:archive', input),
    updateKnowledge: (input: {
      id: string;
      metabotId: number;
      topic?: string;
      summary?: string;
      kind?: 'know_how' | 'pitfall' | 'principle';
    }) =>
      ipcRenderer.invoke('metaid:knowledge:update', input),
    deleteKnowledge: (input: { id: string; metabotId: number }) =>
      ipcRenderer.invoke('metaid:knowledge:delete', input),
    deleteMemoryPolicy: (input: { metabotId: number }) =>
      ipcRenderer.invoke('cowork:memory:deletePolicy', input),
    isDelegationBlocking: (sessionId: string) =>
      ipcRenderer.invoke('cowork:isDelegationBlocking', sessionId) as Promise<boolean>,
    getDelegationInfo: (sessionId: string) =>
      ipcRenderer.invoke('cowork:getDelegationInfo', sessionId) as Promise<{ orderId: string } | null>,
    getSandboxStatus: () =>
      ipcRenderer.invoke('cowork:sandbox:status'),
    installSandbox: () =>
      ipcRenderer.invoke('cowork:sandbox:install'),
    onSandboxDownloadProgress: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('cowork:sandbox:downloadProgress', handler);
      return () => ipcRenderer.removeListener('cowork:sandbox:downloadProgress', handler);
    },
    // Stream event listeners
    onStreamMessage: (callback: (data: { sessionId: string; message: any }) => void) => {
      const handler = (_event: any, data: { sessionId: string; message: any }) => callback(data);
      ipcRenderer.on('cowork:stream:message', handler);
      return () => ipcRenderer.removeListener('cowork:stream:message', handler);
    },
    onStreamMessageUpdate: (callback: (data: { sessionId: string; messageId: string; content?: string; delta?: string; baseLength?: number; metadata?: Record<string, unknown> }) => void) => {
      const handler = (_event: any, data: { sessionId: string; messageId: string; content?: string; delta?: string; baseLength?: number; metadata?: Record<string, unknown> }) => callback(data);
      ipcRenderer.on('cowork:stream:messageUpdate', handler);
      return () => ipcRenderer.removeListener('cowork:stream:messageUpdate', handler);
    },
    getStreamLiveContent: (payload: { sessionId: string; messageId: string }) =>
      ipcRenderer.invoke('cowork:stream:liveContent', payload) as Promise<{ success: boolean; content?: string }>,
    onStreamPermission: (callback: (data: { sessionId: string; request: any }) => void) => {
      const handler = (_event: any, data: { sessionId: string; request: any }) => callback(data);
      ipcRenderer.on('cowork:stream:permission', handler);
      return () => ipcRenderer.removeListener('cowork:stream:permission', handler);
    },
    onStreamPermissionResolved: (callback: (data: { sessionId: string; requestId: string }) => void) => {
      const handler = (_event: any, data: { sessionId: string; requestId: string }) => callback(data);
      ipcRenderer.on('cowork:stream:permissionResolved', handler);
      return () => ipcRenderer.removeListener('cowork:stream:permissionResolved', handler);
    },
    onStreamComplete: (callback: (data: { sessionId: string; claudeSessionId: string | null }) => void) => {
      const handler = (_event: any, data: { sessionId: string; claudeSessionId: string | null }) => callback(data);
      ipcRenderer.on('cowork:stream:complete', handler);
      return () => ipcRenderer.removeListener('cowork:stream:complete', handler);
    },
    onStreamError: (callback: (data: { sessionId: string; error: string }) => void) => {
      const handler = (_event: any, data: { sessionId: string; error: string }) => callback(data);
      ipcRenderer.on('cowork:stream:error', handler);
      return () => ipcRenderer.removeListener('cowork:stream:error', handler);
    },
    onStreamSessionTitle: (callback: (data: { sessionId: string; title: string }) => void) => {
      const handler = (_event: any, data: { sessionId: string; title: string }) => callback(data);
      ipcRenderer.on('cowork:stream:sessionTitle', handler);
      return () => ipcRenderer.removeListener('cowork:stream:sessionTitle', handler);
    },
    onDelegationStateChange: (callback: (data: { sessionId: string; blocking: boolean; orderId?: string; message?: string }) => void) => {
      const handler = (_event: any, data: { sessionId: string; blocking: boolean; orderId?: string; message?: string }) => callback(data);
      ipcRenderer.on('cowork:delegation:stateChange', handler);
      return () => ipcRenderer.removeListener('cowork:delegation:stateChange', handler);
    },
    onSessionProfileRefreshed: (callback: (data: { sessionId: string }) => void) => {
      const handler = (_event: any, data: { sessionId: string }) => callback(data);
      ipcRenderer.on('cowork:session:profileRefreshed', handler);
      return () => ipcRenderer.removeListener('cowork:session:profileRefreshed', handler);
    },
  },
  dialog: {
    selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
    selectFile: (options?: { title?: string; filters?: { name: string; extensions: string[] }[]; multi?: boolean }) =>
      ipcRenderer.invoke('dialog:selectFile', options),
    saveInlineFile: (options: { dataBase64: string; fileName?: string; mimeType?: string; cwd?: string }) =>
      ipcRenderer.invoke('dialog:saveInlineFile', options),
  },
  shell: {
    openPath: (filePath: string) => ipcRenderer.invoke('shell:openPath', filePath),
    showItemInFolder: (filePath: string) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
    getOpenWithApps: (filePath: string) => ipcRenderer.invoke('shell:getOpenWithApps', filePath),
    openWith: (filePath: string, appId: string) => ipcRenderer.invoke('shell:openWith', { filePath, appId }),
    chooseOpenWithApp: (filePath: string) => ipcRenderer.invoke('shell:chooseOpenWithApp', filePath),
  },
  fs: {
    readTextFile: (filePath: string, maxBytes?: number) => ipcRenderer.invoke('fs:readTextFile', { filePath, maxBytes }),
  },
  autoLaunch: {
    get: () => ipcRenderer.invoke('app:getAutoLaunch'),
    set: (enabled: boolean) => ipcRenderer.invoke('app:setAutoLaunch', enabled),
  },
  experimentalAutomation: {
    get: () => ipcRenderer.invoke('app:getExperimentalAutomation') as Promise<{ enabled: boolean }>,
    set: (enabled: boolean) => ipcRenderer.invoke('app:setExperimentalAutomation', enabled) as Promise<{ success: boolean; error?: string }>,
  },
  feeRates: {
    getTiers: () => ipcRenderer.invoke('feeRates:getTiers') as Promise<Record<string, { title: string; desc: string; feeRate: number }[]>>,
    getSelected: () => ipcRenderer.invoke('feeRates:getSelected') as Promise<Record<string, string>>,
    select: (chain: string, tierTitle: string) => ipcRenderer.invoke('feeRates:select', chain, tierTitle) as Promise<{ success: boolean }>,
    refresh: () => ipcRenderer.invoke('feeRates:refresh') as Promise<Record<string, { title: string; desc: string; feeRate: number }[]>>,
  },
  traffic: {
    ensureAccount: () => ipcRenderer.invoke('traffic:ensureAccount'),
    getAccount: () => ipcRenderer.invoke('traffic:getAccount'),
    getBalance: (input?: { forceRefresh?: boolean }) => ipcRenderer.invoke('traffic:getBalance', input ?? {}),
    getLedger: (input?: { cursor?: number; limit?: number; direction?: number }) =>
      ipcRenderer.invoke('traffic:getLedger', input ?? {}),
    getDailyUsage: (input?: { from?: number; to?: number; botAddress?: string }) =>
      ipcRenderer.invoke('traffic:getDailyUsage', input ?? {}),
    getUsageSummary: () => ipcRenderer.invoke('traffic:getUsageSummary'),
    bindAllBots: () => ipcRenderer.invoke('traffic:bindAllBots'),
    getLocalJournal: (input?: { limit?: number; botAddress?: string }) =>
      ipcRenderer.invoke('traffic:getLocalJournal', input ?? {}),
    getPricing: () => ipcRenderer.invoke('traffic:getPricing'),
    getRechargeGateway: () => ipcRenderer.invoke('traffic:getRechargeGateway'),
    createRechargeOrder: (input: { planId: string }) => ipcRenderer.invoke('traffic:createRechargeOrder', input),
    getRechargeOrder: (input: { orderId: string }) => ipcRenderer.invoke('traffic:getRechargeOrder', input),
    mockConfirmRechargeOrder: (input: { orderId: string }) => ipcRenderer.invoke('traffic:mockConfirmRechargeOrder', input),
    getFreeGrantCampaignStatus: () => ipcRenderer.invoke('traffic:getFreeGrantCampaignStatus'),
    claimFreeGrant: () => ipcRenderer.invoke('traffic:claimFreeGrant'),
    redeemCode: (input: { code: string }) => ipcRenderer.invoke('traffic:redeemCode', input),
    getSettings: () => ipcRenderer.invoke('traffic:getSettings'),
    setSettings: (input: { mode?: string; fallbackPolicy?: string; apiBase?: string; rechargeGateway?: string }) => ipcRenderer.invoke('traffic:setSettings', input),
  },
  llmRelay: {
    bootstrap: () => ipcRenderer.invoke('llmRelay:bootstrap'),
    getQuota: (input: { apiKey: string; forceRefresh?: boolean }) => ipcRenderer.invoke('llmRelay:getQuota', input),
    setApiBase: (input: { apiBase: string }) => ipcRenderer.invoke('llmRelay:setApiBase', input),
  },
  appInfo: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getSystemLocale: () => ipcRenderer.invoke('app:getSystemLocale'),
  },
  startup: {
    rendererInitialized: () => ipcRenderer.invoke('startup:rendererInitialized') as Promise<{
      success: boolean;
      elapsedMs: number;
      startedAt: number;
    }>,
  },
  appUpdate: {
    download: (url: string, version: string, sha256?: string) => ipcRenderer.invoke('appUpdate:download', { url, version, sha256 }),
    cancelDownload: () => ipcRenderer.invoke('appUpdate:cancelDownload'),
    install: (filePath: string) => ipcRenderer.invoke('appUpdate:install', filePath),
    applySilent: (filePath: string) => ipcRenderer.invoke('appUpdate:applySilent', filePath),
    relaunchNow: () => ipcRenderer.invoke('appUpdate:relaunchNow'),
    onDownloadProgress: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('appUpdate:downloadProgress', handler);
      return () => ipcRenderer.removeListener('appUpdate:downloadProgress', handler);
    },
  },
  log: {
    getPath: () => ipcRenderer.invoke('log:getPath'),
    openFolder: () => ipcRenderer.invoke('log:openFolder'),
  },
  im: {
    // Configuration
    getConfig: () => ipcRenderer.invoke('im:config:get'),
    setConfig: (config: any) => ipcRenderer.invoke('im:config:set', config),

    // Gateway control
    startGateway: (platform: 'dingtalk' | 'feishu' | 'telegram' | 'discord') => ipcRenderer.invoke('im:gateway:start', platform),
    stopGateway: (platform: 'dingtalk' | 'feishu' | 'telegram' | 'discord') => ipcRenderer.invoke('im:gateway:stop', platform),
    testGateway: (
      platform: 'dingtalk' | 'feishu' | 'telegram' | 'discord',
      configOverride?: any
    ) => ipcRenderer.invoke('im:gateway:test', platform, configOverride),

    // Status
    getStatus: () => ipcRenderer.invoke('im:status:get'),

    // Event listeners
    onStatusChange: (callback: (status: any) => void) => {
      const handler = (_event: any, status: any) => callback(status);
      ipcRenderer.on('im:status:change', handler);
      return () => ipcRenderer.removeListener('im:status:change', handler);
    },
    onMessageReceived: (callback: (message: any) => void) => {
      const handler = (_event: any, message: any) => callback(message);
      ipcRenderer.on('im:message:received', handler);
      return () => ipcRenderer.removeListener('im:message:received', handler);
    },
  },
  scheduledTasks: {
    // Task CRUD
    list: () => ipcRenderer.invoke('scheduledTask:list'),
    get: (id: string) => ipcRenderer.invoke('scheduledTask:get', id),
    create: (input: any) => ipcRenderer.invoke('scheduledTask:create', input),
    update: (id: string, input: any) => ipcRenderer.invoke('scheduledTask:update', id, input),
    delete: (id: string) => ipcRenderer.invoke('scheduledTask:delete', id),
    toggle: (id: string, enabled: boolean) => ipcRenderer.invoke('scheduledTask:toggle', id, enabled),

    // Execution
    runManually: (id: string) => ipcRenderer.invoke('scheduledTask:runManually', id),
    stop: (id: string) => ipcRenderer.invoke('scheduledTask:stop', id),

    // Run history
    listRuns: (taskId: string, limit?: number, offset?: number) =>
      ipcRenderer.invoke('scheduledTask:listRuns', taskId, limit, offset),
    countRuns: (taskId: string) => ipcRenderer.invoke('scheduledTask:countRuns', taskId),
    listAllRuns: (limit?: number, offset?: number) =>
      ipcRenderer.invoke('scheduledTask:listAllRuns', limit, offset),

    // Stream event listeners
    onStatusUpdate: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('scheduledTask:statusUpdate', handler);
      return () => ipcRenderer.removeListener('scheduledTask:statusUpdate', handler);
    },
    onRunUpdate: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('scheduledTask:runUpdate', handler);
      return () => ipcRenderer.removeListener('scheduledTask:runUpdate', handler);
    },
  },
  longtermTask: {
    // Long-term task board (first-class redesign): board read + owner actions.
    // The Twin's channel is the longterm_* agent tools; these are the owner's.
    board: () => ipcRenderer.invoke('longtermTask:board'),
    get: (input: { taskId: string }) => ipcRenderer.invoke('longtermTask:get', input),
    update: (input: { taskId: string; title?: string; goal?: string; acceptanceDelegate?: boolean }) =>
      ipcRenderer.invoke('longtermTask:update', input),
    setStage: (input: { taskId: string; action: 'pause' | 'resume' | 'cancel'; note?: string }) =>
      ipcRenderer.invoke('longtermTask:setStage', input),
    subtaskAdd: (input: {
      taskId: string;
      title: string;
      description?: string;
      acceptanceCriteria?: string[];
      dependsOnOrdinals?: number[];
      preferredChannel?: 'delegate_bot' | 'group_task' | 'owner_external' | 'owner_together';
      notes?: string;
    }) => ipcRenderer.invoke('longtermTask:subtaskAdd', input),
    subtaskUpdate: (input: {
      subtaskId: string;
      title?: string;
      description?: string;
      acceptanceCriteria?: string[];
      dependsOn?: string[];
      preferredChannel?: 'delegate_bot' | 'group_task' | 'owner_external' | 'owner_together' | null;
      notes?: string;
      ordinal?: number;
      metataskRoot?: string | null;
    }) => ipcRenderer.invoke('longtermTask:subtaskUpdate', input),
    begin: (input: { subtaskId: string; channel?: 'delegate_bot' | 'group_task' | 'owner_external' | 'owner_together' }) =>
      ipcRenderer.invoke('longtermTask:begin', input),
    accept: (input: { subtaskId: string; note?: string }) => ipcRenderer.invoke('longtermTask:accept', input),
    reject: (input: { subtaskId: string; feedback: string }) => ipcRenderer.invoke('longtermTask:reject', input),
    unblock: (input: { subtaskId: string; note?: string }) => ipcRenderer.invoke('longtermTask:unblock', input),
    note: (input: { taskId: string; subtaskId?: string; text: string }) => ipcRenderer.invoke('longtermTask:note', input),
    /** Reverse lookup for the session-side origin chip. */
    forSession: (input: { sessionId: string }) => ipcRenderer.invoke('longtermTask:forSession', input),
    moveSubtask: (input: { subtaskId: string; direction: 'up' | 'down' }) => ipcRenderer.invoke('longtermTask:moveSubtask', input),
    /** Monotonic seq per process: drop frames with seq <= lastSeenSeq. */
    onUpdate: (callback: (data: { seq: number; taskIds: string[]; reason: string }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('longtermTask:update', handler);
      return () => ipcRenderer.removeListener('longtermTask:update', handler);
    },
  },
  metatask: {
    // MetaTask (chain-side, read path P1): local projection of on-chain tasks.
    // The chain is the source of truth; the projection is rebuildable.
    board: () => ipcRenderer.invoke('metatask:board'),
    get: (input: { rootPinId: string }) => ipcRenderer.invoke('metatask:get', input),
    refresh: () => ipcRenderer.invoke('metatask:refresh'),
    onUpdate: (callback: (data: { seq: number; reason: string }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('metatask:update', handler);
      return () => ipcRenderer.removeListener('metatask:update', handler);
    },
  },
  groupTask: {
    create: (input: { title: string; goal: string; acceptanceCriteria?: string; memberMetabotIds?: number[]; mode?: 'task' | 'chat' }) =>
      ipcRenderer.invoke('groupTask:create', input),
    list: (filter?: { status?: string }) => ipcRenderer.invoke('groupTask:list', filter),
    get: (taskId: number) => ipcRenderer.invoke('groupTask:get', { taskId }),
    close: (input: { taskId: number; status: 'done' | 'cancelled'; reason?: string; rating?: number; ratingComment?: string }) =>
      ipcRenderer.invoke('groupTask:close', input),
    reopen: (input: { taskId: number; reason?: string }) =>
      ipcRenderer.invoke('groupTask:reopen', input),
    rework: (input: { taskId: number; reason?: string }) =>
      ipcRenderer.invoke('groupTask:rework', input),
    resume: (input: { taskId: number }) =>
      ipcRenderer.invoke('groupTask:resume', input),
    listMessages: (input: { taskId: number; beforeId?: number; limit?: number }) =>
      ipcRenderer.invoke('groupTask:listMessages', input),
    sendUserMessage: (input: { taskId: number; content: string }) =>
      ipcRenderer.invoke('groupTask:sendUserMessage', input),
    kickMember: (input: { taskId: number; metabotId?: number; globalmetaid?: string; reason?: string }) =>
      ipcRenderer.invoke('groupTask:kickMember', input),
    rename: (input: { taskId: number; title: string }) =>
      ipcRenderer.invoke('groupTask:rename', input),
    pin: (input: { taskId: number; pinned: boolean }) =>
      ipcRenderer.invoke('groupTask:pin', input),
    archive: (input: { taskId: number }) =>
      ipcRenderer.invoke('groupTask:archive', input),
    unarchive: (input: { taskId: number }) =>
      ipcRenderer.invoke('groupTask:unarchive', input),
    listArchived: (options?: { offset?: number; limit?: number }) =>
      ipcRenderer.invoke('groupTask:listArchived', options),
    // Sidebar background-task badge: current in-flight MetaBot turn snapshot.
    getTurnActivity: () => ipcRenderer.invoke('groupTask:getTurnActivity'),
    onStatusChanged: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('groupTask:statusChanged', handler);
      return () => ipcRenderer.removeListener('groupTask:statusChanged', handler);
    },
    onOwnerReportDelivery: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('groupTask:ownerReportDelivery', handler);
      return () => ipcRenderer.removeListener('groupTask:ownerReportDelivery', handler);
    },
    // HITL: fired when a human checkpoint opens/resolves so the detail view refreshes.
    onCheckpointChanged: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('groupTask:checkpointChanged', handler);
      return () => ipcRenderer.removeListener('groupTask:checkpointChanged', handler);
    },
    // Fired whenever the daemon's in-flight MetaBot turn set changes (badge).
    onTurnActivityChanged: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('groupTask:turnActivityChanged', handler);
      return () => ipcRenderer.removeListener('groupTask:turnActivityChanged', handler);
    },
  },
  openTeamCollab: {
    list: () => ipcRenderer.invoke('openTeamCollab:list'),
    listMessages: (input: { groupId: string; beforeId?: number; limit?: number }) =>
      ipcRenderer.invoke('openTeamCollab:listMessages', input),
    // P0-1: every [OPENTEAM_INVITE] this machine's bots received (joined or
    // not), newest first — backs the "Received invites" block of the collab UI.
    listGuestInvites: () => ipcRenderer.invoke('openTeamCollab:listGuestInvites'),
  },
  idbots: {
    getMetaBots: () => ipcRenderer.invoke('idbots:getMetaBots'),
    getOfficialSkillsStatus: () => ipcRenderer.invoke('idbots:getOfficialSkillsStatus'),
    installOfficialSkill: (skill: { name: string; skillFileUri: string; remoteVersion: string; remoteCreator: string }) =>
      ipcRenderer.invoke('idbots:installOfficialSkill', skill),
    syncAllOfficialSkills: () => ipcRenderer.invoke('idbots:syncAllOfficialSkills'),
    getCommunitySkillsStatus: () => ipcRenderer.invoke('idbots:getCommunitySkillsStatus'),
    addMetaBot: (input: {
      name: string;
      avatar?: string | null;
      role: string;
      soul: string;
      goal?: string | null;
      bio?: string | null;
      /** Deprecated compatibility input; use bio. */
      background?: string | null;
      boss_id?: number | null;
      boss_global_metaid?: string | null;
      llm_id?: string | null;
      llm_provider?: string | null;
      llm_effort?: string | null;
      allow_chat_skills?: string[];
      metabot_type?: 'twin' | 'worker';
    }) => ipcRenderer.invoke('idbots:addMetaBot', input),
    restoreMetaBotFromMnemonic: (input: { mnemonic: string; path?: string }) =>
      ipcRenderer.invoke('idbots:restoreMetaBotFromMnemonic', input),
    getAddressBalance: (options: { metabotId?: number; addresses?: { btc?: string; mvc?: string; doge?: string } }) =>
      ipcRenderer.invoke('idbots:getAddressBalance', options),
    getMetabotWalletAssets: (input: { metabotId: number }) =>
      ipcRenderer.invoke('idbots:getMetabotWalletAssets', input),
    getTransferFeeSummary: (chain: 'mvc' | 'doge' | 'btc') => ipcRenderer.invoke('idbots:getTransferFeeSummary', chain),
    getTokenTransferFeeSummary: (input: { kind: 'mrc20' | 'mvc-ft' }) =>
      ipcRenderer.invoke('idbots:getTokenTransferFeeSummary', input),
    buildTransferPreview: (params: {
      metabotId: number;
      chain: 'mvc' | 'doge' | 'btc';
      toAddress: string;
      amountSpaceOrDoge: string;
      feeRate: number;
    }) => ipcRenderer.invoke('idbots:buildTransferPreview', params),
    buildTokenTransferPreview: (params: {
      kind: 'mrc20' | 'mvc-ft';
      metabotId: number;
      asset: any;
      toAddress: string;
      amount: string;
      feeRate: number;
    }) => ipcRenderer.invoke('idbots:buildTokenTransferPreview', params),
    executeTransfer: (params: {
      metabotId: number;
      chain: 'mvc' | 'doge' | 'btc';
      toAddress: string;
      amountSpaceOrDoge: string;
      feeRate: number;
    }) => ipcRenderer.invoke('idbots:executeTransfer', params),
    executeTokenTransfer: (params: {
      kind: 'mrc20' | 'mvc-ft';
      metabotId: number;
      asset: any;
      toAddress: string;
      amount: string;
      feeRate: number;
    }) => ipcRenderer.invoke('idbots:executeTokenTransfer', params),
    getMetaBotMnemonic: (metabotId: number) => ipcRenderer.invoke('idbots:getMetaBotMnemonic', metabotId),
    deleteMetaBot: (metabotId: number) => ipcRenderer.invoke('idbots:deleteMetaBot', metabotId),
    syncMetaBot: (metabotId: number) => ipcRenderer.invoke('idbots:syncMetaBot', metabotId),
    /**
     * Resume a locally-created bot's on-chain setup: 'subsidized' re-requests
     * the gas subsidy then publishes missing pins; 'self-funded' publishes
     * with the bot's own address funds (user transferred MVC manually).
     */
    resumeMetabotSetup: (input: { metabotId: number; mode: 'subsidized' | 'self-funded' }) =>
      ipcRenderer.invoke('idbots:resumeMetabotSetup', input),
    syncMetaBotEditChanges: (input: {
      metabotId: number;
      syncName?: boolean;
      syncAvatar?: boolean;
      syncBio?: boolean;
      syncPersona?: boolean;
      syncLlm?: boolean;
      syncChatSkills?: boolean;
      syncHomepage?: boolean;
      syncOwner?: boolean;
    }) => ipcRenderer.invoke('idbots:syncMetaBotEditChanges', input),
    createMetaBotOnChain: (input: {
      name: string;
      avatar?: string | null;
      role?: string;
      soul?: string;
      goal?: string | null;
      bio?: string | null;
      /** Deprecated compatibility input; use bio. */
      background?: string | null;
      boss_id?: number | null;
      boss_global_metaid?: string | null;
      llm_id?: string | null;
      llm_provider?: string | null;
      llm_effort?: string | null;
      fallback_llm_id?: string | null;
      fallback_llm_provider?: string | null;
      fallback_llm_effort?: string | null;
      allow_chat_skills?: string[];
      metabot_type?: 'twin' | 'worker';
      homepage?: string | null;
    }) => ipcRenderer.invoke('idbots:createMetaBotOnChain', input),
    uploadMetabotHomepageFile: (input: {
      metabotId: number;
      fileName: string;
      contentType?: string;
      base64: string;
      network?: string;
    }) => ipcRenderer.invoke('idbots:uploadMetabotHomepageFile', input),
  },
  userIdentity: {
    get: () => ipcRenderer.invoke('userIdentity:get'),
    create: (input: { name: string; avatar?: string | null }) =>
      ipcRenderer.invoke('userIdentity:create', input),
    importFromMnemonic: (input: { mnemonic: string; path?: string }) =>
      ipcRenderer.invoke('userIdentity:import', input),
    updateName: (input: { name: string }) => ipcRenderer.invoke('userIdentity:updateName', input),
    logout: () => ipcRenderer.invoke('userIdentity:logout'),
    revealMnemonic: () => ipcRenderer.invoke('userIdentity:revealMnemonic'),
    retrySubsidy: () => ipcRenderer.invoke('userIdentity:retrySubsidy'),
    retryChainSync: () => ipcRenderer.invoke('userIdentity:retryChainSync'),
    syncToMobile: () => ipcRenderer.invoke('userIdentity:syncToMobile'),
  },
  metaWebListener: {
    getListenerConfig: () => ipcRenderer.invoke('idbots:getListenerConfig'),
    getListenerStatus: () => ipcRenderer.invoke('idbots:getListenerStatus'),
    toggleListener: (payload: { type: 'enabled' | 'groupChats' | 'privateChats' | 'serviceRequests' | 'respondToStrangerPrivateChats'; enabled: boolean }) =>
      ipcRenderer.invoke('idbots:toggleListener', payload),
    startMetaWebListener: () => ipcRenderer.invoke('idbots:startMetaWebListener'),
    onListenerLog: (callback: (log: string) => void) => {
      const handler = (_event: unknown, log: string) => callback(log);
      ipcRenderer.on('idbots:listener-log', handler);
      return () => ipcRenderer.removeListener('idbots:listener-log', handler);
    },
    assignGroupChatTask: (params: import('./services/assignGroupChatTaskService').AssignGroupChatTaskParams) =>
      ipcRenderer.invoke('idbots:assignGroupChatTask', params),
  },
  metabot: {
    list: () => ipcRenderer.invoke('metabot:list'),
    get: (id: number) => ipcRenderer.invoke('metabot:get', id),
    create: (input: {
      name: string;
      avatar?: string | null;
      metabot_type: 'twin' | 'worker';
      role: string;
      soul: string;
      goal?: string | null;
      bio?: string | null;
      /** Deprecated compatibility input; use bio. */
      background?: string | null;
      boss_id?: number | null;
      llm_id?: string | null;
      llm_provider?: string | null;
      llm_effort?: string | null;
    }) => ipcRenderer.invoke('metabot:create', input),
    update: (id: number, input: {
      name?: string;
      avatar?: string | null;
      enabled?: boolean;
      metabot_type?: 'twin' | 'worker';
      role?: string;
      soul?: string;
      goal?: string | null;
      bio?: string | null;
      /** Deprecated compatibility input; use bio. */
      background?: string | null;
      boss_id?: number | null;
      boss_global_metaid?: string | null;
      llm_id?: string | null;
      llm_provider?: string | null;
      llm_effort?: string | null;
      fallback_llm_id?: string | null;
      fallback_llm_provider?: string | null;
      fallback_llm_effort?: string | null;
      homepage?: string | null;
    }) => ipcRenderer.invoke('metabot:update', id, input),
    setEnabled: (id: number, enabled: boolean) => ipcRenderer.invoke('metabot:setEnabled', id, enabled),
    /** Per-metabot kv settings; key must be whitelisted in src/main/services/metabotSettingsService.ts. */
    getSetting: (id: number, key: string) => ipcRenderer.invoke('metabot:getSetting', id, key),
    setSetting: (id: number, key: string, value: string) => ipcRenderer.invoke('metabot:setSetting', id, key, value),
    checkNameExists: (options: { name: string; excludeId?: number }) =>
      ipcRenderer.invoke('metabot:checkNameExists', options),
  },
  dream: {
    getStatus: () => ipcRenderer.invoke('dream:getStatus'),
    listDailySummaries: (options: { metabotId: number; limit?: number; offset?: number }) =>
      ipcRenderer.invoke('dream:listDailySummaries', options),
    listRuns: (options: { metabotId: number; limit?: number }) =>
      ipcRenderer.invoke('dream:listRuns', options),
    listCapabilityDrafts: (options: { metabotId: number; limit?: number }) =>
      ipcRenderer.invoke('dream:listCapabilityDrafts', options),
    runNow: (options: { metabotId: number; date?: string }) =>
      ipcRenderer.invoke('dream:runNow', options),
    onStatusChanged: (callback: (payload: { metabotId: number; dreaming: boolean }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: { metabotId: number; dreaming: boolean }) => callback(payload);
      ipcRenderer.on('metabot:dreamStatusChanged', handler);
      return () => ipcRenderer.removeListener('metabot:dreamStatusChanged', handler);
    },
  },
  knowledgeBase: {
    list: (metabotId: number) => ipcRenderer.invoke('knowledgeBase:list', metabotId),
    create: (metabotId: number, input: { name: string; description?: string; rawDir?: string }) =>
      ipcRenderer.invoke('knowledgeBase:create', metabotId, input),
    update: (metabotId: number, kbId: string, patch: { name?: string; description?: string; autoLearn?: boolean }) =>
      ipcRenderer.invoke('knowledgeBase:update', metabotId, kbId, patch),
    remove: (metabotId: number, kbId: string) => ipcRenderer.invoke('knowledgeBase:remove', metabotId, kbId),
    learn: (metabotId: number, kbId: string, options?: { full?: boolean }) =>
      ipcRenderer.invoke('knowledgeBase:learn', metabotId, kbId, options),
    importFiles: (metabotId: number, kbId: string, filePaths: string[]) =>
      ipcRenderer.invoke('knowledgeBase:importFiles', metabotId, kbId, filePaths),
    openDir: (metabotId: number, kbId: string) => ipcRenderer.invoke('knowledgeBase:openDir', metabotId, kbId),
    onLearnStatus: (callback: (payload: KnowledgeBaseLearnStatusEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: KnowledgeBaseLearnStatusEvent) => callback(payload);
      ipcRenderer.on('knowledgeBase:learnStatus', handler);
      return () => ipcRenderer.removeListener('knowledgeBase:learnStatus', handler);
    },
  },
  metawebStudy: {
    list: (metabotId: number) => ipcRenderer.invoke('metawebStudy:list', metabotId),
  },
  surf: {
    listRuns: (metabotId: number, limit?: number) =>
      ipcRenderer.invoke('surf:listRuns', metabotId, limit),
    runNow: (metabotId: number) => ipcRenderer.invoke('surf:runNow', metabotId),
    onStatusChanged: (callback: (payload: { metabotId: number; runId: string; trigger: string; status: string; error?: string | null }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: { metabotId: number; runId: string; trigger: string; status: string; error?: string | null }) => callback(payload);
      ipcRenderer.on('metabot:surfStatusChanged', handler);
      return () => ipcRenderer.removeListener('metabot:surfStatusChanged', handler);
    },
  },
  networkStatus: {
    send: (status: 'online' | 'offline') => ipcRenderer.send('network:status-change', status),
  },
  // Namespace kept under its legacy `p2p` name for the renderer; it now only
  // bridges the metaid user-info/contacts IPC channels.
  p2p: {
    getUserInfo: (params: { globalMetaId: string }) =>
      ipcRenderer.invoke('metaid:getUserInfo', params),
    resolveAvatarSource: (params: { reference: string }) =>
      ipcRenderer.invoke('metaid:resolveAvatarSource', params),
    listContacts: (params: { observerGlobalMetaId: string }) =>
      ipcRenderer.invoke('metaid:contacts:list', params),
    getContactDetail: (params: { observerGlobalMetaId: string; subjectGlobalMetaId: string }) =>
      ipcRenderer.invoke('metaid:contacts:detail', params),
  },
});
