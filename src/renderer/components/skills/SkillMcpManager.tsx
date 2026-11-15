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

  // OWNER 2026-11-16 01:18 + 01:23: the 技能|MCP tray lives in a FIXED-HEIGHT
  // row owned by THIS component (h-9, always first, right-aligned) — its
  // absolute position is identical on both faces regardless of the view's
  // internal layout (the MCP bar carries a search box; tray-in-bar drifted
  // 34.75px when measured). Same 64px tray grammar as the credits face.
  const modeTray = (
    <div className="inline-flex h-9 min-w-0 shrink-0 overflow-hidden rounded-[var(--shape-radius-sm)] border border-claude-border/70 bg-claude-bg/80 dark:border-claude-darkBorder/70 dark:bg-claude-darkBg/80">
      <button
        type="button"
        onClick={() => dispatch({ type: 'set-mode', mode: 'skills' })}
        className={`flex h-full min-w-[64px] items-center justify-center px-3 text-sm font-medium leading-none transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 ${
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
        className={`flex h-full min-w-[64px] items-center justify-center px-3 text-sm font-medium leading-none transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 ${
          state.mode === 'mcp'
            ? 'bg-claude-accent text-claude-accentInk'
            : 'text-claude-textSecondary hover:bg-claude-surfaceHover/70 hover:text-claude-text dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover/70 dark:hover:text-claude-darkText'
        }`}
      >
        {i18nService.t('mcpServers')}
      </button>
    </div>
  );

  // OWNER 2026-11-16 01:35 FINAL: variant A — the 技能|MCP tray rides each
  // view's own tab bar (same row as 本地技能…/已安装…, above the divider);
  // page lifted so the bar sits 20px below the header divider.
  return (
    <div className="space-y-4 pt-[3px]">
      {state.mode === 'skills' ? (
        <SkillsManager
          onStartTaskWithSkill={onStartTaskWithSkill}
          activeTab={state.skillsTab}
          onTabChange={handleSkillTabChange}
          tabBarTrailing={modeTray}
        />
      ) : (
        <McpManager
          activeTab={state.mcpTab}
          onTabChange={handleMcpTabChange}
          tabBarTrailing={modeTray}
        />
      )}
    </div>
  );
};

export default SkillMcpManager;
