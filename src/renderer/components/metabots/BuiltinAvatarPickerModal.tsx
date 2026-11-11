import React, { useEffect } from 'react';
import { CheckIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { BUILTIN_AVATARS, builtinAvatarSrc } from '../../assets/builtinAvatars';
import { i18nService } from '../../services/i18n';

interface BuiltinAvatarPickerModalProps {
  currentReference?: string;
  onPick: (reference: string) => void;
  onClose: () => void;
}

const BuiltinAvatarPickerModal: React.FC<BuiltinAvatarPickerModalProps> = ({
  currentReference = '',
  onPick,
  onClose,
}) => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" data-slot="metabot-builtin-avatar-picker" role="dialog" aria-modal="true" aria-label={i18nService.t('metabotBuiltinAvatarTitle')}>
      <div className="absolute inset-0 bg-black/50 dark:bg-black/60" onClick={onClose} aria-hidden />
      <div
        className="relative flex max-h-[76vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-main)] dark:bg-claude-darkSurface shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b dark:border-claude-darkBorder border-claude-border px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold dark:text-claude-darkText text-claude-text">
              {i18nService.t('metabotBuiltinAvatarTitle')}
            </div>
            <div className="truncate text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {i18nService.t('metabotBuiltinAvatarHint')}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded p-1.5 text-claude-textSecondary transition-colors hover:bg-black/5 dark:text-claude-darkTextSecondary dark:hover:bg-white/10"
            aria-label={i18nService.t('close')}
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="grid grid-cols-4 gap-3 sm:grid-cols-5">
            {BUILTIN_AVATARS.map((avatar) => {
              const selected = avatar.metafileUri === currentReference.trim();
              return (
                <button
                  key={avatar.code}
                  type="button"
                  data-slot="metabot-builtin-avatar-picker-tile"
                  data-avatar-code={avatar.code}
                  data-pin-id={avatar.pinId}
                  aria-pressed={selected}
                  onClick={() => onPick(avatar.metafileUri)}
                  className={`group relative overflow-hidden rounded-xl border transition-shadow hover:shadow-md dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 ${selected ? 'border-amber-500 ring-2 ring-amber-200 dark:ring-amber-900' : ''}`}
                >
                  <img
                    src={builtinAvatarSrc(avatar)}
                    alt={avatar.name}
                    className="aspect-square w-full object-cover"
                    loading="lazy"
                  />
                  {selected && (
                    <span className="absolute right-1.5 top-1.5 rounded-full bg-amber-500 p-1 text-white shadow-sm">
                      <CheckIcon className="h-3 w-3" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
        <div className="border-t dark:border-claude-darkBorder border-claude-border px-4 py-2 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
          {i18nService.t('metabotBuiltinAvatarReferenceHint')}
        </div>
      </div>
    </div>
  );
};

export default BuiltinAvatarPickerModal;
