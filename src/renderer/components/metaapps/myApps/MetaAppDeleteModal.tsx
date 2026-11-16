import React from 'react';
import { i18nService } from '../../../services/i18n';
import type { OwnerMetaAppRecord } from '../../../types/metaAppOwner';

interface MetaAppDeleteModalProps {
  record: OwnerMetaAppRecord;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const MetaAppDeleteModal: React.FC<MetaAppDeleteModalProps> = ({ record, busy, onConfirm, onCancel }) => {
  const t = (k: string) => i18nService.t(k);
  const name = record.title || record.appName || record.pinId;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-sm mx-4 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-xl">
        <div className="p-5">
          <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
            {t('myAppsDeleteTitle') || 'Delete MetaApp'}
          </h3>
          <p className="mt-2 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {(t('myAppsDeleteConfirm') || 'Revoke "{{name}}" on chain? This hides it but does not erase history.')
              .replace('{{name}}', name)}
          </p>
        </div>
        <div className="px-5 py-3 border-t dark:border-claude-darkBorder border-claude-border flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded-[8px] border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          >
            {t('cancel') || 'Cancel'}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="border border-red-600 px-3 py-1.5 text-sm rounded-[8px] bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50"
          >
            {busy ? (t('deleting') || 'Deleting…') : (t('delete') || 'Delete')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default MetaAppDeleteModal;
