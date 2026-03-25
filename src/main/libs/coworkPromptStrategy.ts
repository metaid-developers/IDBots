export interface ResolveContinueSystemPromptInput {
  persistedSystemPrompt?: string | null;
  requestedSystemPrompt?: string;
  activeSkillIds?: string[];
}

/**
 * Keep the persisted session prompt for ordinary follow-up turns so Claude can
 * resume the same conversation. Only forward a new system prompt when the user
 * explicitly selected fresh skills for this turn, or when we have no persisted
 * prompt to fall back to.
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

  const activeSkillIds = Array.isArray(input.activeSkillIds)
    ? input.activeSkillIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  if (activeSkillIds.length > 0) {
    return requestedSystemPrompt;
  }

  if (typeof input.persistedSystemPrompt === 'string') {
    return undefined;
  }

  return requestedSystemPrompt;
}
