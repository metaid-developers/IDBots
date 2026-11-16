export interface ResolveContinueSystemPromptInput {
  persistedSystemPrompt?: string | null;
  requestedSystemPrompt?: string;
  activeSkillIds?: string[];
  /**
   * Skill set the persisted prompt was built for (cowork_sessions.active_skill_ids).
   * Absent for callers that predate skill-set tracking; the policy then falls
   * back to comparing only the requested set against emptiness.
   */
  persistedActiveSkillIds?: string[];
}

/** Normalize a skill-id list to a deduplicated, order-free set signature. */
function normalizeSkillIds(input: unknown): string[] {
  const ids = Array.isArray(input)
    ? input.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  return [...new Set(ids)];
}

/** Set equality, order-insensitive — skill ordering must not affect the decision. */
function sameSkillSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}

/**
 * Decide which system prompt a continued turn should use.
 *
 * The persisted prompt leads DeepSeek's cacheable prefix; rewriting it
 * mid-session resets the underlying SDK session and re-caches the whole
 * context. The renderer historically rebuilt the combined prompt on EVERY
 * send from the LIVE MetaApp/Skill catalogs, so any catalog change (e.g. a
 * bot publishing a new MetaApp) silently broke the prefix of every running
 * session. This policy keeps the persisted prompt unless the user made a
 * deliberate skill-set change:
 *
 * - no requested prompt                    -> persisted (caller decides)
 * - no persisted prompt                    -> requested (first real prompt)
 * - requested skill set == persisted set   -> persisted: the only possible
 *   byte difference is live-catalog drift, which must never touch the prefix
 * - requested skill set != persisted set   -> requested: a deliberate change
 *   (the runner labels the resulting miss 'system_prompt_changed')
 */
export function resolveContinueSystemPrompt(
  input: ResolveContinueSystemPromptInput
): string | undefined {
  const requestedSystemPrompt =
    typeof input.requestedSystemPrompt === 'string' && input.requestedSystemPrompt.trim()
      ? input.requestedSystemPrompt
      : undefined;
  if (!requestedSystemPrompt) {
    return undefined;
  }
  if (typeof input.persistedSystemPrompt !== 'string') {
    return requestedSystemPrompt;
  }

  const requestedIds = normalizeSkillIds(input.activeSkillIds);
  const persistedIds = normalizeSkillIds(input.persistedActiveSkillIds);
  return sameSkillSet(requestedIds, persistedIds)
    ? undefined
    : requestedSystemPrompt;
}

/**
 * Turn-start framing for owner-typed chat text (the continue path of
 * CoworkTurnSubmissionController).
 *
 * A continue turn composes the kernel user message as
 * "<volatile context head>\n\n<owner text>" — the owner's words sit as a bare
 * tail after up to ~45k chars of local-time/memory/catalog blocks. Mid-turn
 * steers never hit this (the kernel frames them as <operator_steer>), but on
 * an idle-session continue a terse ruling ("1", "A", "过") reads as context
 * noise: the model concluded "no owner message arrived this turn" and
 * confabulated a heartbeat round while the UI showed the reply as delivered
 * (long-term task sessions 883caf62/7ac5533e, 2026-09-28/29). The envelope
 * makes the owner text unmissable; the persisted/UI-visible message stays
 * raw (the controller wraps only the runner-bound copy).
 */
export function buildOwnerTurnInputPrompt(text: string): string {
  return [
    '<owner_message>',
    'This turn was opened by the human OWNER sending the message below in the chat. It is the ONLY new owner input this turn — the other blocks in this user message (local time, memory projections, catalogs) are per-turn background context, not the owner\'s words.',
    'If the message is terse (a digit, a single option letter/word — e.g. "1", "A", "过"), it answers the most recent question or pending decision you put to the owner: locate that question in the recent conversation (for long-term tasks, also the task journal), map the reply to its options, and act on the ruling. Exception: bare continuation cues ("继续", "continue", "重试", "retry", "接着做") after an interrupted/failed turn or after an unanswered critique mean "resume your interrupted work and answer my pending request" — NEVER treat a bare "继续" as selecting Option A or authorizing irreversible on-chain publishing/minting unless the owner already explicitly approved that exact action! Never claim the owner has not replied while this block is present.',
    '',
    text,
    '</owner_message>',
  ].join('\n');
}
