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
}

/**
 * Run one skill turn using CoworkRunner: create a temporary session,
 * startSession with autoApprove, wait for 'complete', extract last assistant
 * content, delete session, return reply text.
 */
export function runOrchestratorSkillTurn(
  runner: CoworkRunner,
  store: CoworkStore,
  params: RunOrchestratorSkillTurnParams
): Promise<string> {
  const { systemPrompt, userMessage, cwd } = params;

  const hasAvailableSkills = systemPrompt.includes('<available_skills>');
  console.log('[Orchestrator] [Bridge] runOrchestratorSkillTurn start:', {
    cwd,
    systemPromptLength: systemPrompt.length,
    userMessageLength: userMessage.length,
    hasAvailableSkills,
  });

  const session = store.createSession(
    '[Orchestrator] skill-turn',
    cwd,
    systemPrompt,
    'local',
    [],
    null
  );
  const sessionId = session.id;

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
      try {
        store.deleteSession(sessionId);
      } catch (e) {
        console.warn('[Orchestrator] Failed to delete temp skill-turn session:', e);
      }
      resolve(result);
    };

    const fail = (err: string | Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        store.deleteSession(sessionId);
      } catch (e) {
        console.warn('[Orchestrator] Failed to delete temp skill-turn session:', e);
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
      console.log('[Orchestrator] [Bridge] skill-turn complete:', {
        totalMessages: messages.length,
        toolUseCount,
        toolResultCount,
        lastAssistantLength: lastAssistantContent.length,
      });
      if (toolUseCount === 0 && toolResultCount === 0) {
        console.warn('[Orchestrator] [Bridge] No tool_use/tool_result messages — agent may not have invoked Read/Bash.');
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

    console.log('[Orchestrator] [Bridge] Calling runner.startSession sessionId=', sessionId);
    runner
      .startSession(sessionId, userMessage, {
        systemPrompt,
        autoApprove: true,
        confirmationMode: 'text',
        workspaceRoot: cwd,
      })
      .catch((err) => {
        console.error('[Orchestrator] [Bridge] startSession rejected:', err instanceof Error ? err.message : String(err));
        if (!settled) fail(err instanceof Error ? err : new Error(String(err)));
      });
  });
}
