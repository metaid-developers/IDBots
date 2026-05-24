export function normalizeAllowChatSkills(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of values) {
    const normalized = String(item ?? '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function addAllowChatSkill(current: unknown, nextSkill: unknown): string[] {
  const normalized = String(nextSkill ?? '').trim();
  if (!normalized) return normalizeAllowChatSkills(current);
  const deduped = normalizeAllowChatSkills(current);
  if (deduped.includes(normalized)) return deduped;
  return [...deduped, normalized];
}

export function removeAllowChatSkill(current: unknown, skillId: unknown): string[] {
  const normalized = String(skillId ?? '').trim();
  if (!normalized) return normalizeAllowChatSkills(current);
  return normalizeAllowChatSkills(current).filter((id) => id !== normalized);
}
