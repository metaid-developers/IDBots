export function getEnabledGigSquareSkills(skills) {
  if (!Array.isArray(skills)) return [];
  return skills.filter((skill) => skill?.enabled === true);
}

export function buildGigSquareModifySkillOptions(skills, currentSkillName) {
  const enabledSkills = getEnabledGigSquareSkills(skills);
  const normalizedCurrentSkillName = String(currentSkillName || '').trim();
  if (!normalizedCurrentSkillName) return enabledSkills;
  if (enabledSkills.some((skill) => skill.name === normalizedCurrentSkillName)) {
    return enabledSkills;
  }

  const existsInLoadedSkills = Array.isArray(skills)
    && skills.some((skill) => skill?.name === normalizedCurrentSkillName);
  if (existsInLoadedSkills) {
    return enabledSkills;
  }

  return [
    {
      id: `__current__:${normalizedCurrentSkillName}`,
      name: normalizedCurrentSkillName,
      description: '',
      enabled: true,
      isOfficial: false,
      isBuiltIn: false,
      updatedAt: 0,
      prompt: '',
      skillPath: '',
    },
    ...enabledSkills,
  ];
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
