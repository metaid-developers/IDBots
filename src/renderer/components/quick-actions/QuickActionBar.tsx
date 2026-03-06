import React from 'react';
import type { LocalizedQuickAction } from '../../types/quickAction';
import {
  PaperAirplaneIcon,
  BookOpenIcon,
  ChatBubbleLeftRightIcon,
  Squares2X2Icon,
} from '@heroicons/react/24/outline';

interface QuickActionBarProps {
  actions: LocalizedQuickAction[];
  onActionSelect: (actionId: string) => void;
}

// Icon map for quick action buttons
const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
  PaperAirplaneIcon,
  BookOpenIcon,
  ChatBubbleLeftRightIcon,
  Squares2X2Icon,
};

const QuickActionBar: React.FC<QuickActionBarProps> = ({ actions, onActionSelect }) => {
  if (actions.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center justify-center gap-2.5">
      {actions.map((action) => {
        const IconComponent = iconMap[action.icon];

        return (
          <button
            key={action.id}
            type="button"
            onClick={() => onActionSelect(action.id)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-all duration-200 ease-out dark:bg-claude-darkSurface bg-claude-surface dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover hover:border-claude-accent/40"
          >
            {IconComponent && (
              <IconComponent className="w-4 h-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
            )}
            <span>{action.label}</span>
          </button>
        );
      })}
    </div>
  );
};

export default QuickActionBar;
