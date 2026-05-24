export interface MetabotBioPayloadInput {
  role: string;
  soul: string;
  goal: string | null;
  background: string | null;
  llm_id: string | null;
  tools: string[];
  skills: string[];
  allow_chat_skills: string[];
  boss_id: number | string | null;
  boss_global_metaid: string | null;
  created_by: string;
}

export function buildMetabotBioPayload(metabot: MetabotBioPayloadInput) {
  return {
    role: metabot.role || '',
    soul: metabot.soul || '',
    goal: metabot.goal || '',
    background: metabot.background || '',
    llm: metabot.llm_id || '',
    tools: metabot.tools ?? [],
    skills: metabot.skills ?? [],
    allowChatSkills: metabot.allow_chat_skills ?? [],
    boss_id: String(metabot.boss_id ?? '0000'),
    boss_global_metaid: metabot.boss_global_metaid || '',
    createdBy: metabot.created_by || '0000',
  };
}
