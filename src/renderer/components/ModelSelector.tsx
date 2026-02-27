import React, { useEffect } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../store';
import { ChevronDownIcon, CheckIcon } from '@heroicons/react/24/outline';
import { setSelectedModel } from '../store/slices/modelSlice';
import { i18nService } from '../services/i18n';
import type { Model } from '../store/slices/modelSlice';

interface ModelSelectorProps {
  dropdownDirection?: 'up' | 'down';
  /** When set, only show models from this LLM provider (e.g. "deepseek"). */
  restrictToLlmId?: string | null;
}

const ModelSelector: React.FC<ModelSelectorProps> = ({ dropdownDirection = 'down', restrictToLlmId }) => {
  const dispatch = useDispatch();
  const [isOpen, setIsOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const selectedModel = useSelector((state: RootState) => state.model.selectedModel);
  const availableModels = useSelector((state: RootState) => state.model.availableModels);

  const displayModels = React.useMemo((): Model[] => {
    if (!restrictToLlmId?.trim()) return availableModels;
    const llm = restrictToLlmId.trim().toLowerCase();
    return availableModels.filter(
      (m) => (m.provider ?? '').toLowerCase() === llm
    );
  }, [availableModels, restrictToLlmId]);

  useEffect(() => {
    if (!restrictToLlmId?.trim() || displayModels.length === 0) return;
    const inList = displayModels.some((m) => m.id === selectedModel.id);
    if (!inList) {
      dispatch(setSelectedModel(displayModels[0]));
    }
  }, [restrictToLlmId, displayModels, selectedModel.id, dispatch]);

  // 点击外部区域关闭下拉框
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const handleModelSelect = (model: Model) => {
    dispatch(setSelectedModel(model));
    setIsOpen(false);
  };

  const emptyMessage = i18nService.t('noModelsConfigured');
  if (availableModels.length === 0) {
    return (
      <div className="px-3 py-1.5 rounded-xl dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkTextSecondary text-claude-textSecondary text-sm">
        {emptyMessage}
      </div>
    );
  }
  if (restrictToLlmId?.trim() && displayModels.length === 0) {
    return (
      <div className="px-3 py-1.5 rounded-xl dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkTextSecondary text-claude-textSecondary text-sm">
        {emptyMessage}
      </div>
    );
  }

  const dropdownPositionClass = dropdownDirection === 'up'
    ? 'bottom-full mb-1'
    : 'top-full mt-1';

  return (
    <div ref={containerRef} className="relative cursor-pointer">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center space-x-2 px-3 py-1.5 rounded-xl dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:text-claude-darkText text-claude-text transition-colors cursor-pointer ${isOpen ? 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover' : ''}`}
      >
        <span className="font-medium text-sm">
          {displayModels.some((m) => m.id === selectedModel.id) ? selectedModel.name : displayModels[0]?.name ?? selectedModel.name}
        </span>
        <ChevronDownIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
      </button>

      {isOpen && (
        <div className={`absolute ${dropdownPositionClass} w-52 dark:bg-claude-darkSurface bg-claude-surface rounded-xl popover-enter shadow-popover z-50 dark:border-claude-darkBorder border-claude-border border overflow-hidden`}>
          <div className="max-h-64 overflow-y-auto">
          {displayModels.map((model) => (
            <button
              key={model.id}
              onClick={() => handleModelSelect(model)}
              className={`w-full px-4 py-2.5 text-left dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover flex items-center justify-between transition-colors ${
                model.id === (displayModels.some((m) => m.id === selectedModel.id) ? selectedModel.id : displayModels[0]?.id) ? 'dark:bg-claude-darkSurfaceHover/50 bg-claude-surfaceHover/50' : ''
              }`}
            >
              <div className="flex flex-col">
                <span className="text-sm">{model.name}</span>
                {model.provider && (
                  <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{model.provider}</span>
                )}
              </div>
              {model.id === (displayModels.some((m) => m.id === selectedModel.id) ? selectedModel.id : displayModels[0]?.id) && (
                <CheckIcon className="h-4 w-4 text-claude-accent" />
              )}
            </button>
          ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default ModelSelector;
