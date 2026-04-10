export type SkillMode = 'skills' | 'mcp';
export type SkillsTab = 'local' | 'official';
export type McpTab = 'installed' | 'marketplace' | 'custom';

export interface SkillMcpState {
  mode: SkillMode;
  skillsTab: SkillsTab;
  mcpTab: McpTab;
}

export type SkillMcpAction =
  | { type: 'set-mode'; mode: SkillMode }
  | { type: 'set-skills-tab'; tab: SkillsTab }
  | { type: 'set-mcp-tab'; tab: McpTab };

export const initialSkillMcpState: SkillMcpState = {
  mode: 'skills',
  skillsTab: 'local',
  mcpTab: 'installed',
};

export function skillMcpReducer(state: SkillMcpState, action: SkillMcpAction): SkillMcpState {
  switch (action.type) {
    case 'set-mode':
      return {
        ...state,
        mode: action.mode,
      };
    case 'set-skills-tab':
      return {
        ...state,
        mode: 'skills',
        skillsTab: action.tab,
      };
    case 'set-mcp-tab':
      return {
        ...state,
        mode: 'mcp',
        mcpTab: action.tab,
      };
    default:
      return state;
  }
}
