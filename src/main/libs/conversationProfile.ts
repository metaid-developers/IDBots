/**
 * Unified per-session / per-turn ConversationProfile (P1 governance).
 *
 * Replaces scattered boolean predicates (`isAssistantModeOwnerChatSession`,
 * `isMobileOwnerChatSession`, `isProjectorModeSession`, `isOwnerProgressChatSession`,
 * `isUnattendedAutomationSession`) with a single deterministic, side-effect-free
 * classifier.
 *
 * Must stay free of Electron imports so plain Node tests and server-mode helpers
 * can load it directly from compiled `dist-electron`.
 */

export type HostEnv = 'desktop' | 'server';

export type ConversationSurface =
  | 'desktop_botworks'
  | 'desktop_studio'
  | 'desktop_browser'
  | 'mobile_cloud'
  | 'im_channel'
  | 'a2a'
  | 'automation_unattended';

export type InteractionStyle =
  | 'owner_assistant'
  | 'professional'
  | 'im_human'
  | 'unattended';

export type PresentationSurface =
  | 'chat_only'
  | 'projector_right_pane'
  | 'bot_browser'
  | 'mobile_phone'
  | 'im_bridge';

export type ExecutionRole = 'twin' | 'welcome' | 'worker' | 'standard';

export interface ConversationProfileSessionShape {
  autoOrigin?: string | null;
  sessionType?: string | null;
  assistantMode?: boolean | null;
}

export interface ConversationProfileInput {
  serverMode: boolean;
  session: ConversationProfileSessionShape | null | undefined;
  sourceChannel?: string | null;
  executionRole?: ExecutionRole;
  imToolsAllowed?: boolean;
  isUnattendedActiveMarker?: boolean;
}

export interface ConversationProfile {
  readonly hostEnv: HostEnv;
  readonly surface: ConversationSurface;
  readonly interactionStyle: InteractionStyle;
  readonly presentation: PresentationSurface;
  readonly executionRole: ExecutionRole;
  /** Whether the turn emits owner-facing progress bubbles (turnAck + owner_update + wait heartbeat). */
  readonly isOwnerProgressChat: boolean;
  /** Desktop Studio owner-chat surface (`assistantMode && !autoOrigin` on desktop). */
  readonly isStudioOwnerChat: boolean;
  /** Desktop Studio right-pane projector (`desktop_studio` + `sessionType === 'browser'`). */
  readonly isProjectorMode: boolean;
  /** Desktop Studio Twin Chief-of-Staff front-office guardrails. */
  readonly isStudioTwinFrontOffice: boolean;
  /** Interactive Cloud Mobile owner chat (`serverMode` + `cowork_ui` + `standard|browser` + `!autoOrigin`). */
  readonly isMobileOwnerChat: boolean;
  /** Machine-driven / non-interactive run; skips per-message cerebellum effort selection. */
  readonly isUnattendedAutomation: boolean;
  /** Low-latency owner-chat effort posture (Studio or Cloud Mobile). */
  readonly fastEffortMode: boolean;
  /** False when an untrusted IM turn revokes tools (`toolScope === 'none'`). */
  readonly imToolsAllowed: boolean;
}

export function resolveConversationProfile(input: ConversationProfileInput): ConversationProfile {
  const hostEnv: HostEnv = input.serverMode ? 'server' : 'desktop';
  const executionRole: ExecutionRole = input.executionRole ?? 'standard';
  const imToolsAllowed = input.imToolsAllowed ?? true;
  const session = input.session;

  if (!session) {
    return {
      hostEnv,
      surface: hostEnv === 'server' ? 'automation_unattended' : 'desktop_botworks',
      interactionStyle: hostEnv === 'server' ? 'unattended' : 'professional',
      presentation: 'chat_only',
      executionRole,
      isOwnerProgressChat: false,
      isStudioOwnerChat: false,
      isProjectorMode: false,
      isStudioTwinFrontOffice: false,
      isMobileOwnerChat: false,
      isUnattendedAutomation: false,
      fastEffortMode: false,
      imToolsAllowed,
    };
  }

  const sessionType = session.sessionType ?? 'standard';
  const sourceChannel = input.sourceChannel || 'cowork_ui';

  // 1. Unattended auto-origin runs (schedule / longterm / orchestration) or
  // explicit surf/study/practice active markers always resolve unattended.
  if (session.autoOrigin || input.isUnattendedActiveMarker === true) {
    return {
      hostEnv,
      surface: sessionType === 'a2a' ? 'a2a' : 'automation_unattended',
      interactionStyle: 'unattended',
      presentation: 'chat_only',
      executionRole,
      isOwnerProgressChat: false,
      isStudioOwnerChat: false,
      isProjectorMode: false,
      isStudioTwinFrontOffice: false,
      isMobileOwnerChat: false,
      isUnattendedAutomation: true,
      fastEffortMode: false,
      imToolsAllowed,
    };
  }

  // 2. Human IM conversations (im:<platform>[:direct|:group]) stay interactive
  // even when stored under the 'a2a' session type.
  if (typeof sourceChannel === 'string' && sourceChannel.startsWith('im:')) {
    return {
      hostEnv,
      surface: 'im_channel',
      interactionStyle: 'im_human',
      presentation: 'im_bridge',
      executionRole,
      isOwnerProgressChat: false,
      isStudioOwnerChat: false,
      isProjectorMode: false,
      isStudioTwinFrontOffice: false,
      isMobileOwnerChat: false,
      isUnattendedAutomation: false,
      fastEffortMode: false,
      imToolsAllowed,
    };
  }

  // 3. Cloud Mobile interactive owner chats take precedence over historical
  // desktop Studio markers (e.g. a Studio session reopened on mobile).
  if (
    hostEnv === 'server'
    && (sessionType === 'standard' || sessionType === 'browser')
    && sourceChannel === 'cowork_ui'
  ) {
    return {
      hostEnv,
      surface: 'mobile_cloud',
      interactionStyle: 'owner_assistant',
      presentation: 'mobile_phone',
      executionRole,
      isOwnerProgressChat: true,
      isStudioOwnerChat: false,
      isProjectorMode: false,
      isStudioTwinFrontOffice: false,
      isMobileOwnerChat: true,
      isUnattendedAutomation: false,
      fastEffortMode: true,
      imToolsAllowed,
    };
  }

  // 4. Desktop Studio owner chats (`assistantMode` stamped on desktop).
  if (hostEnv === 'desktop' && Boolean(session.assistantMode)) {
    const isProjectorMode = sessionType === 'browser';
    return {
      hostEnv,
      surface: 'desktop_studio',
      interactionStyle: 'owner_assistant',
      presentation: isProjectorMode ? 'projector_right_pane' : 'chat_only',
      executionRole,
      isOwnerProgressChat: true,
      isStudioOwnerChat: true,
      isProjectorMode,
      isStudioTwinFrontOffice: isProjectorMode && executionRole === 'twin',
      isMobileOwnerChat: false,
      isUnattendedAutomation: false,
      fastEffortMode: true,
      imToolsAllowed,
    };
  }

  // 5. Desktop Bot Browser (non-assistant) pages run unattended.
  if (hostEnv === 'desktop' && sessionType === 'browser') {
    return {
      hostEnv,
      surface: 'desktop_browser',
      interactionStyle: 'unattended',
      presentation: 'bot_browser',
      executionRole,
      isOwnerProgressChat: false,
      isStudioOwnerChat: false,
      isProjectorMode: false,
      isStudioTwinFrontOffice: false,
      isMobileOwnerChat: false,
      isUnattendedAutomation: true,
      fastEffortMode: false,
      imToolsAllowed,
    };
  }

  // 6. Non-standard sessions (a2a, group, etc.) or non-cowork_ui internal
  // channels are unattended automation runs.
  if (sessionType !== 'standard' || sourceChannel !== 'cowork_ui') {
    return {
      hostEnv,
      surface: sessionType === 'a2a' ? 'a2a' : 'automation_unattended',
      interactionStyle: 'unattended',
      presentation: 'chat_only',
      executionRole,
      isOwnerProgressChat: false,
      isStudioOwnerChat: false,
      isProjectorMode: false,
      isStudioTwinFrontOffice: false,
      isMobileOwnerChat: false,
      isUnattendedAutomation: true,
      fastEffortMode: false,
      imToolsAllowed,
    };
  }

  // 7. Standard interactive desktop BotWorks chat.
  return {
    hostEnv,
    surface: 'desktop_botworks',
    interactionStyle: 'professional',
    presentation: 'chat_only',
    executionRole,
    isOwnerProgressChat: false,
    isStudioOwnerChat: false,
    isProjectorMode: false,
    isStudioTwinFrontOffice: false,
    isMobileOwnerChat: false,
    isUnattendedAutomation: false,
    fastEffortMode: false,
    imToolsAllowed,
  };
}
