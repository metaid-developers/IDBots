import React, { useReducer } from 'react';
import SkillsManager from './SkillsManager';
import McpManager from '../mcp/McpManager';
import {
  initialSkillMcpState,
  skillMcpReducer,
  type McpTab,
  type SkillsTab,
} from './skillMcpState';
import { i18nService } from '../../services/i18n';

interface SkillMcpManagerProps {
  onStartTaskWithSkill?: (skillId: string) => void;
}

const SkillMcpManager: React.FC<SkillMcpManagerProps> = ({ onStartTaskWithSkill }) => {
  const [state, dispatch] = useReducer(skillMcpReducer, initialSkillMcpState);

  const handleSkillTabChange = (tab: SkillsTab) => {
    dispatch({ type: 'set-skills-tab', tab });
  };

  const handleMcpTabChange = (tab: McpTab) => {
    dispatch({ type: 'set-mcp-tab', tab });
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <div className="inline-flex items-center rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface p-1">
          <button
            type="button"
            onClick={() => dispatch({ type: 'set-mode', mode: 'skills' })}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
              state.mode === 'skills'
                ? 'bg-claude-accent text-white shadow-sm'
                : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
            }`}
          >
            {i18nService.t('skills')}
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: 'set-mode', mode: 'mcp' })}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
              state.mode === 'mcp'
                ? 'bg-claude-accent text-white shadow-sm'
                : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
            }`}
          >
            {i18nService.t('mcpServers')}
          </button>
        </div>
      </div>

      {state.mode === 'skills' ? (
        <SkillsManager
          onStartTaskWithSkill={onStartTaskWithSkill}
          activeTab={state.skillsTab}
          onTabChange={handleSkillTabChange}
        />
      ) : (
        <McpManager
          activeTab={state.mcpTab}
          onTabChange={handleMcpTabChange}
        />
      )}
    </div>
  );
};

export default SkillMcpManager;
