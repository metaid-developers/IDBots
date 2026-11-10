import { store } from '../store';
import {
  setBrowserSession,
  setBrowserStreaming,
} from '../store/slices/browserCoworkSlice';
import { setBrowserOpenSessionId } from '../store/slices/coworkSlice';
import { coworkService } from './cowork';
import { sessionTabBinding } from './sessionTabBinding';
import type { CoworkSession } from '../types/cowork';

/**
 * Session service for the Bot Browser side-panel Co-Work surface.
 *
 * Browser sessions are `sessionType === 'browser'` cowork sessions: they reuse
 * the whole cowork pipeline (IPC, runner, stream events, SQLite persistence)
 * but are driven from the Bot Browser sidebar instead of the main CoworkView.
 * The panel keeps its own current-session pointer in `browserCoworkSlice`;
 * history is derived from the shared `cowork.sessions` list filtered by type.
 */
/**
 * Pinned-skill payload for a browser-session turn, mirroring the home
 * composer's contract (CoworkView.handleStartSession/handleContinueSession):
 * the inlined `## Skill:` blocks ride the base system prompt, and the ids are
 * persisted onto the session so per-skill env overrides keep applying.
 */
export interface BrowserCoworkSkills {
  /** Inlined `## Skill:` blocks for the pinned skills (undefined = none). */
  prompt?: string;
  /** Store ids of the pinned skills. */
  activeSkillIds?: string[];
}

class BrowserCoworkService {
  private starting = false;

  /**
   * Every transition of the panel's open session goes through here so the
   * browserCowork pointer and the shared unread bookkeeping (coworkSlice)
   * never drift apart: opening a browser conversation clears its notification
   * dot and live turns while it stays open do not re-mark it unread.
   */
  private applySession(session: CoworkSession | null): void {
    store.dispatch(setBrowserSession(session));
    store.dispatch(setBrowserOpenSessionId(session?.id ?? null));
    // The BotHub conversation window's last-open session pointer (survives
    // restarts); null (draft/archive) clears it and launch falls back to the
    // freshest browser session.
    sessionTabBinding.rememberOpenSession(session?.id ?? null);
  }

  private async buildCombinedSystemPrompt(skillPrompt?: string): Promise<string | undefined> {
    const config = store.getState().cowork.config;
    // NOTE: the local MetaApp auto-routing prompt (<available_metaapps> →
    // open_metaapp) is deliberately excluded for browser sessions — in this
    // surface apps are opened on-chain via search_metaapps + metaapp:// URIs.
    // Skill routing rules/catalog are composed main-side (SKILLS prompt
    // section + volatile catalog tail), so only the user's pinned skill
    // blocks and custom prompt are embedded here — same split as the home
    // composer's buildCombinedSystemPrompt.
    return [skillPrompt, config.systemPrompt]
      .filter((part) => part?.trim())
      .join('\n\n') || undefined;
  }

  async start(
    prompt: string,
    metabotId?: number | null,
    cwd?: string,
    modelEffort?: { model?: string | null; modelProvider?: string | null; effort?: string | null },
    skills?: BrowserCoworkSkills,
    projectId?: string | null,
    /**
     * What the title generator sees (defaults to prompt). The element-picker
     * context block rides inside prompt but must not seed the session title.
     */
    titleSource?: string,
  ): Promise<CoworkSession | null> {
    if (this.starting) return null;
    const cowork = window.electron?.cowork;
    if (!cowork) return null;
    this.starting = true;
    try {
      store.dispatch(setBrowserStreaming(true));
      const titlePrompt = titleSource?.trim() ? titleSource : prompt;
      const fallbackTitle = titlePrompt.split('\n')[0].slice(0, 50) || 'Bot Browser';
      const [generatedTitle, systemPrompt] = await Promise.all([
        coworkService.generateSessionTitle(titlePrompt).catch(() => null),
        this.buildCombinedSystemPrompt(skills?.prompt),
      ]);
      const result = await cowork.startSession({
        prompt,
        title: generatedTitle?.trim() || fallbackTitle,
        systemPrompt,
        sessionType: 'browser',
        // Bot Internet projector sessions (owner ruling 2026-11-07): stamped
        // at creation so the session runs assistant mode regardless of the
        // global chatExperienceMode. Legacy browser sessions stay unmarked.
        assistantMode: true,
        ...(typeof metabotId === 'number' ? { metabotId } : {}),
        ...(skills?.activeSkillIds?.length ? { activeSkillIds: skills.activeSkillIds } : {}),
        ...(cwd?.trim() ? { cwd: cwd.trim() } : {}),
        // Project binding matters even when its source dir is empty or equals
        // the default working directory: main-side it pins the session to the
        // project (project dir used as-is, no per-bot workspace redirect).
        ...(projectId?.trim() ? { projectId: projectId.trim() } : {}),
        ...(modelEffort?.model ? { model: modelEffort.model } : {}),
        ...(modelEffort?.modelProvider ? { modelProvider: modelEffort.modelProvider } : {}),
        ...(modelEffort && modelEffort.effort !== undefined ? { effort: modelEffort.effort } : {}),
      });
      if (result?.success && result.session) {
        this.applySession(result.session);
        // Every session owns one browser tab: bind the fresh session to the
        // pending draft tab (blank-reuse policy), fire-and-forget.
        void sessionTabBinding.bindNewSession(result.session.id);
        // Refresh the shared session list so the panel history sees the new session.
        await coworkService.loadSessions();
        return result.session;
      }
      store.dispatch(setBrowserStreaming(false));
      console.error('Failed to start browser cowork session:', result?.error);
      return null;
    } finally {
      this.starting = false;
    }
  }

  async send(prompt: string, skills?: BrowserCoworkSkills): Promise<boolean> {
    const session = store.getState().browserCowork.currentSession;
    if (!session) return false;
    // Fresh system prompt only when skills were pinned for this turn;
    // ordinary turns keep the session's persisted prompt so the cacheable
    // head never rewrites mid-session (same policy as the home composer's
    // continue path).
    const systemPrompt = skills?.activeSkillIds?.length
      ? await this.buildCombinedSystemPrompt(skills.prompt)
      : undefined;
    const result = await coworkService.submitInput({
      sessionId: session.id,
      submissionId: crypto.randomUUID(),
      text: prompt,
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(skills?.activeSkillIds?.length ? { activeSkillIds: skills.activeSkillIds } : {}),
    });
    return result.success !== false;
  }

  async stop(): Promise<void> {
    const session = store.getState().browserCowork.currentSession;
    if (!session) return;
    await coworkService.stopSession(session.id);
  }

  async loadSession(sessionId: string): Promise<void> {
    const result = await window.electron?.cowork?.getSession(sessionId);
    if (result?.success && result.session) {
      this.applySession(result.session);
    }
  }

  async archiveSession(sessionId: string): Promise<void> {
    await coworkService.archiveSession(sessionId);
    if (store.getState().browserCowork.currentSession?.id === sessionId) {
      this.applySession(null);
    }
  }

  startNewDraft(): void {
    this.applySession(null);
  }
}

export const browserCoworkService = new BrowserCoworkService();
