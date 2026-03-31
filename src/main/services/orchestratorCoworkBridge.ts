/**
 * Bridge: run one orchestrator "skill turn" via CoworkRunner so the same
 * skill list + Read/Bash logic is used as in local Cowork (no duplicate prompts).
 */

import type { CoworkRunner } from '../libs/coworkRunner';
import type { CoworkStore } from '../coworkStore';

const SKILL_TURN_TIMEOUT_MS = 120_000;

export interface RunOrchestratorSkillTurnParams {
  systemPrompt: string;
  userMessage: string;
  cwd: string;
  /** MetaBot id for this group task; session will use its wallet env for skill scripts. */
  metabotId?: number;
  groupId?: string | null;
  triggerReason?: string;
  supervisorGlobalmetaid?: string | null;
  latestMessageSenderGlobalmetaid?: string | null;
}

/**
 * Run one skill turn using CoworkRunner: create a new session,
 * startSession with autoApprove, wait for 'complete', extract last assistant
 * content, keep session for UI visibility, return reply text.
 */
export function runOrchestratorSkillTurn(
  runner: CoworkRunner,
  store: CoworkStore,
  params: RunOrchestratorSkillTurnParams
): Promise<string> {
  const {
    systemPrompt,
    userMessage,
    cwd,
    metabotId,
    groupId,
    triggerReason,
    supervisorGlobalmetaid,
    latestMessageSenderGlobalmetaid,
  } = params;

  const now = Date.now();
  const normalizedGroupId = (groupId ?? '').trim();
  const sessionTitle = normalizedGroupId
    ? `Group-${normalizedGroupId.slice(0, 12)}-${now}`
    : `[Orchestrator] skill-turn-${now}`;
  const externalConversationId = normalizedGroupId
    ? `metaweb-group:${normalizedGroupId}:${now}`
    : `orchestrator:${now}`;

  const hasAvailableSkills = systemPrompt.includes('<available_skills>');

  const session = store.createSession(
    sessionTitle,
    cwd,
    systemPrompt,
    'local',
    [],
    metabotId ?? null
  );
  const sessionId = session.id;

  if (normalizedGroupId) {
    try {
      store.upsertConversationMapping({
        channel: 'metaweb_group',
        externalConversationId,
        metabotId: metabotId ?? null,
        coworkSessionId: sessionId,
      });
    } catch (error) {
      console.warn('[Orchestrator] Failed to upsert group conversation mapping:', error);
    }
  }

  const userMessageRecord = store.addMessage(sessionId, {
    type: 'user',
    content: userMessage,
    metadata: {
      sourceChannel: normalizedGroupId ? 'metaweb_group' : 'orchestrator',
      externalConversationId,
      groupId: normalizedGroupId || undefined,
      triggerReason,
      supervisorGlobalmetaid: supervisorGlobalmetaid ?? undefined,
      latestMessageSenderGlobalmetaid: latestMessageSenderGlobalmetaid ?? undefined,
    },
  });
  runner.emit('message', sessionId, userMessageRecord);

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      runner.off('complete', onComplete);
      runner.off('error', onError);
      if (timeoutId != null) clearTimeout(timeoutId);
    };

    const finish = (result: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const fail = (err: string | Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        store.updateSession(sessionId, { status: 'error' });
      } catch (e) {
        console.warn('[Orchestrator] Failed to mark session error:', e);
      }
      reject(typeof err === 'string' ? new Error(err) : err);
    };

    const onComplete = (sid: string) => {
      if (sid !== sessionId) return;
      const sessionWithMessages = store.getSession(sessionId);
      const messages = sessionWithMessages?.messages ?? [];
      const toolUseCount = messages.filter((m) => m.type === 'tool_use').length;
      const toolResultCount = messages.filter((m) => m.type === 'tool_result').length;
      let lastAssistantContent = '';
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].type === 'assistant' && messages[i].content) {
          lastAssistantContent = String(messages[i].content).trim();
          break;
        }
      }
      finish(lastAssistantContent || '');
    };

    const onError = (sid: string, errorMessage: string) => {
      if (sid !== sessionId) return;
      fail(errorMessage);
    };

    let timeoutId: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timeoutId = null;
      fail(`Skill turn timed out after ${SKILL_TURN_TIMEOUT_MS / 1000}s`);
    }, SKILL_TURN_TIMEOUT_MS);

    runner.on('complete', onComplete);
    runner.on('error', onError);

    runner
      .startSession(sessionId, userMessage, {
        skipInitialUserMessage: true,
        systemPrompt,
        autoApprove: true,
        disableMemoryUpdates: true,
        confirmationMode: 'text',
        workspaceRoot: cwd,
      })
      .catch((err) => {
        console.error('[Orchestrator] [Bridge] startSession rejected:', err instanceof Error ? err.message : String(err));
        if (!settled) fail(err instanceof Error ? err : new Error(String(err)));
      });
  });
}
