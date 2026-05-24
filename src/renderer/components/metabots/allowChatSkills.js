function normalizeAllowChatSkills(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const result = [];
  for (const item of values) {
    const normalized = String(item ?? '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function addAllowChatSkill(current, nextSkill) {
  const normalized = String(nextSkill ?? '').trim();
  if (!normalized) return normalizeAllowChatSkills(current);
  const deduped = normalizeAllowChatSkills(current);
  if (deduped.includes(normalized)) return deduped;
  return [...deduped, normalized];
}

function removeAllowChatSkill(current, skillId) {
  const normalized = String(skillId ?? '').trim();
  if (!normalized) return normalizeAllowChatSkills(current);
  return normalizeAllowChatSkills(current).filter((id) => id !== normalized);
}

exports.normalizeAllowChatSkills = normalizeAllowChatSkills;
exports.addAllowChatSkill = addAllowChatSkill;
exports.removeAllowChatSkill = removeAllowChatSkill;
