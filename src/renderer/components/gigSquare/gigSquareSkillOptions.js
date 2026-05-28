export function getEnabledGigSquareSkills(skills) {
  if (!Array.isArray(skills)) return [];
  return skills.filter((skill) => skill?.enabled === true);
}

export function normalizeGigSquareProviderSkillNames(providerSkills) {
  const source = Array.isArray(providerSkills) ? providerSkills : [providerSkills];
  const seen = new Set();
  const normalized = [];
  for (const skillName of source) {
    const name = String(skillName || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    normalized.push(name);
  }
  return normalized;
}

function createLegacyCurrentSkillOption(skillName) {
  return {
    id: `__current__:${skillName}`,
    name: skillName,
    description: '',
    enabled: true,
    isOfficial: false,
    isBuiltIn: false,
    updatedAt: 0,
    prompt: '',
    skillPath: '',
    readOnly: true,
  };
}

export function buildGigSquareSkillSelectionOptions(skills, currentSkillNames = []) {
  const enabledSkills = getEnabledGigSquareSkills(skills);
  const enabledSkillNames = new Set(enabledSkills.map((skill) => skill.name));
  const loadedSkillNames = new Set(
    (Array.isArray(skills) ? skills : [])
      .map((skill) => String(skill?.name || '').trim())
      .filter(Boolean),
  );
  const legacyOptions = normalizeGigSquareProviderSkillNames(currentSkillNames)
    .filter((skillName) => !enabledSkillNames.has(skillName) && !loadedSkillNames.has(skillName))
    .map(createLegacyCurrentSkillOption);
  return [...legacyOptions, ...enabledSkills];
}

export function resolveGigSquareSelectedProviderSkills(skillOptions, selectedSkillIds) {
  const skillNameById = new Map(
    (Array.isArray(skillOptions) ? skillOptions : [])
      .map((skill) => [skill?.id, skill?.name]),
  );
  const selectedNames = (Array.isArray(selectedSkillIds) ? selectedSkillIds : [selectedSkillIds])
    .map((skillId) => skillNameById.get(skillId));
  return normalizeGigSquareProviderSkillNames(selectedNames);
}

export function buildGigSquareModifySkillOptions(skills, currentSkillName) {
  return buildGigSquareSkillSelectionOptions(skills, [currentSkillName]);
}

export function resolveGigSquareModifySkillSelection(skills, currentSkillName) {
  const normalizedCurrentSkillName = String(currentSkillName || '').trim();
  if (!normalizedCurrentSkillName) {
    return {
      selectedSkillId: '',
      providerSkill: '',
    };
  }

  const enabledSkills = getEnabledGigSquareSkills(skills);
  const enabledMatch = enabledSkills.find((skill) => skill.name === normalizedCurrentSkillName);
  if (enabledMatch) {
    return {
      selectedSkillId: enabledMatch.id,
      providerSkill: enabledMatch.name,
    };
  }

  const existsInLoadedSkills = Array.isArray(skills)
    && skills.some((skill) => skill?.name === normalizedCurrentSkillName);
  if (existsInLoadedSkills) {
    return {
      selectedSkillId: '',
      providerSkill: '',
    };
  }

  return {
    selectedSkillId: `__current__:${normalizedCurrentSkillName}`,
    providerSkill: normalizedCurrentSkillName,
  };
}
