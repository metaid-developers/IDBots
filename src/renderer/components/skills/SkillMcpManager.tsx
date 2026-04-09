import React, { useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { i18nService } from '../../services/i18n';
import { mcpRegistry } from '../../data/mcpRegistry';
import SkillsManager from './SkillsManager';
import McpManager from '../mcp/McpManager';

type SkillMcpTab = 'localSkills' | 'featuredSkills' | 'localMcp' | 'featuredMcp' | 'customMcp';

interface SkillMcpManagerProps {
  onStartTaskWithSkill?: (skillId: string) => void;
}

const SkillMcpManager: React.FC<SkillMcpManagerProps> = ({ onStartTaskWithSkill }) => {
  const servers = useSelector((state: RootState) => state.mcp.servers);
  const [activeTab, setActiveTab] = useState<SkillMcpTab>('localSkills');

  const installedRegistryIds = useMemo(() => {
    const ids = new Set<string>();
    for (const server of servers) {
      if (server.registryId) ids.add(server.registryId);
    }
    return ids;
  }, [servers]);

  const marketplaceCount = useMemo(
    () => mcpRegistry.filter((entry) => !installedRegistryIds.has(entry.id)).length,
    [installedRegistryIds]
  );

  const customCount = useMemo(
    () => servers.filter((server) => !server.isBuiltIn).length,
    [servers]
  );

  const isSkillTab = activeTab === 'localSkills' || activeTab === 'featuredSkills';

  const handleSkillTabChange = (tab: 'local' | 'official') => {
    setActiveTab(tab === 'local' ? 'localSkills' : 'featuredSkills');
  };

  const handleMcpTabChange = (tab: 'installed' | 'marketplace' | 'custom') => {
    if (tab === 'installed') setActiveTab('localMcp');
    if (tab === 'marketplace') setActiveTab('featuredMcp');
    if (tab === 'custom') setActiveTab('customMcp');
  };

  const tabClass = (tab: SkillMcpTab) =>
    `px-4 py-2 text-sm font-medium transition-colors relative whitespace-nowrap ${
      activeTab === tab
        ? 'dark:text-claude-darkText text-claude-text'
        : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
    }`;

  const tabIndicatorClass = (tab: SkillMcpTab) =>
    `absolute bottom-0 left-0 right-0 h-0.5 rounded-full transition-colors ${
      activeTab === tab ? 'bg-claude-accent' : 'bg-transparent'
    }`;

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <div className="flex min-w-max items-center border-b dark:border-claude-darkBorder border-claude-border">
          <button type="button" onClick={() => setActiveTab('localSkills')} className={tabClass('localSkills')}>
            {i18nService.t('localSkills')}
            <div className={tabIndicatorClass('localSkills')} />
          </button>
          <button type="button" onClick={() => setActiveTab('featuredSkills')} className={tabClass('featuredSkills')}>
            {i18nService.t('officialRecommended')}
            <div className={tabIndicatorClass('featuredSkills')} />
          </button>
          <button type="button" onClick={() => setActiveTab('localMcp')} className={tabClass('localMcp')}>
            {i18nService.t('localMcp')}
            {servers.length > 0 && (
              <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full dark:bg-claude-darkSurface bg-claude-surface">
                {servers.length}
              </span>
            )}
            <div className={tabIndicatorClass('localMcp')} />
          </button>
          <button type="button" onClick={() => setActiveTab('featuredMcp')} className={tabClass('featuredMcp')}>
            {i18nService.t('featuredMcp')}
            {marketplaceCount > 0 && (
              <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full dark:bg-claude-darkSurface bg-claude-surface">
                {marketplaceCount}
              </span>
            )}
            <div className={tabIndicatorClass('featuredMcp')} />
          </button>
          <button type="button" onClick={() => setActiveTab('customMcp')} className={tabClass('customMcp')}>
            {i18nService.t('customMcp')}
            {customCount > 0 && (
              <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full dark:bg-claude-darkSurface bg-claude-surface">
                {customCount}
              </span>
            )}
            <div className={tabIndicatorClass('customMcp')} />
          </button>
        </div>
      </div>

      {isSkillTab ? (
        <SkillsManager
          onStartTaskWithSkill={onStartTaskWithSkill}
          activeTab={activeTab === 'localSkills' ? 'local' : 'official'}
          onTabChange={handleSkillTabChange}
          hideTabBar
        />
      ) : (
        <McpManager
          activeTab={
            activeTab === 'localMcp'
              ? 'installed'
              : activeTab === 'featuredMcp'
                ? 'marketplace'
                : 'custom'
          }
          onTabChange={handleMcpTabChange}
          hideTabBar
          hideSearch
        />
      )}
    </div>
  );
};

export default SkillMcpManager;
