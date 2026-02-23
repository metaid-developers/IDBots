import React from 'react';
import { i18nService } from '../../services/i18n';

interface AppUpdateModalProps {
  latestVersion: string;
  onConfirm: () => void;
  onCancel: () => void;
}

const AppUpdateModal: React.FC<AppUpdateModalProps> = ({ latestVersion, onConfirm, onCancel }) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop">
      <div className="modal-content w-full max-w-sm mx-4 dark:bg-claude-darkSurface bg-claude-surface rounded-2xl shadow-modal overflow-hidden">
        <div className="px-5 pt-5 pb-3">
          <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
            {i18nService.t('updateAvailableTitle')}
          </h3>
          <p className="mt-2 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('updateAvailableMessage')}
          </p>
          <p className="mt-2 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {latestVersion}
          </p>
        </div>
        <div className="px-5 pb-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
          >
            {i18nService.t('updateAvailableCancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-3 py-1.5 text-sm rounded-lg bg-claude-accent text-white hover:bg-claude-accentHover transition-colors"
          >
            {i18nService.t('updateAvailableConfirm')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AppUpdateModal;
