function normalizeSkillMapping(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function resolveQuickActionPromptSkillMapping(action, promptId) {
  if (!action || !Array.isArray(action.prompts)) {
    return normalizeSkillMapping(action?.skillMapping);
  }

  const prompt = action.prompts.find((item) => item.id === promptId);
  if (prompt && Object.prototype.hasOwnProperty.call(prompt, 'skillMapping')) {
    return normalizeSkillMapping(prompt.skillMapping);
  }

  return normalizeSkillMapping(action.skillMapping);
}

export function buildPromptPanelHeaderModel(actionLabel) {
  const title = typeof actionLabel === 'string' ? actionLabel.trim() : '';
  return {
    title,
    showBackButton: title.length > 0,
  };
}
