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
      {/* Joined segmented tray (owner 2026-11-15 17:24): same language as the
          取消/保存 pair and the 积分|流量 header — 1px tray border, zero inset,
          overflow-hidden, selected face is a flat accent rectangle with ink
          text, labels flex-centered. */}
      <div className="flex justify-end">
        <div className="inline-flex h-8 min-w-0 overflow-hidden rounded-[var(--shape-radius-md)] border border-claude-border/70 bg-claude-bg/80 dark:border-claude-darkBorder/70 dark:bg-claude-darkBg/80">
          <button
            type="button"
            onClick={() => dispatch({ type: 'set-mode', mode: 'skills' })}
            className={`flex h-full min-w-[72px] items-center justify-center px-4 text-sm font-medium leading-none transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 ${
              state.mode === 'skills'
                ? 'bg-claude-accent text-claude-accentInk'
                : 'text-claude-textSecondary hover:bg-claude-surfaceHover/70 hover:text-claude-text dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover/70 dark:hover:text-claude-darkText'
            }`}
          >
            {i18nService.t('skills')}
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: 'set-mode', mode: 'mcp' })}
            className={`flex h-full min-w-[72px] items-center justify-center px-4 text-sm font-medium leading-none transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 ${
              state.mode === 'mcp'
                ? 'bg-claude-accent text-claude-accentInk'
                : 'text-claude-textSecondary hover:bg-claude-surfaceHover/70 hover:text-claude-text dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover/70 dark:hover:text-claude-darkText'
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
