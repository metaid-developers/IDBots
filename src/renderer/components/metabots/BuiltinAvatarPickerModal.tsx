import React, { useEffect } from 'react';
import { CheckIcon, Squares2X2Icon, XMarkIcon } from '@heroicons/react/24/outline';
import { BUILTIN_AVATARS, builtinAvatarSrc } from '../../assets/builtinAvatars';
import { i18nService } from '../../services/i18n';
import {
  METABOT_BTN_FLAT_CLASS,
  METABOT_ICON_BTN_CLASS,
  METABOT_MODAL_BACKDROP_CLASS,
  METABOT_MODAL_FOOTER_CLASS,
  METABOT_MODAL_HEADER_CLASS,
  METABOT_MODAL_SCRIM_CLASS,
  METABOT_MODAL_SHELL_CLASS,
} from './metaBotCardPresentation.js';

interface BuiltinAvatarPickerModalProps {
  currentReference?: string;
  onPick: (reference: string) => void;
  onClose: () => void;
}

const BuiltinAvatarPickerModal: React.FC<BuiltinAvatarPickerModalProps> = ({
  currentReference,
  onPick,
  onClose,
}) => {
  const normalizedCurrent = (currentReference ?? '').trim();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className={METABOT_MODAL_BACKDROP_CLASS} data-slot="metabot-builtin-avatar-picker-modal">
      <div className={METABOT_MODAL_SCRIM_CLASS} onClick={onClose} aria-hidden />
      <div
        className={`${METABOT_MODAL_SHELL_CLASS} w-full max-w-[540px] max-h-[82vh]`}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={i18nService.t('metabotBuiltinAvatarTitle')}
      >
        <div className={METABOT_MODAL_HEADER_CLASS}>
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border border-slate-900/[0.08] dark:border-white/[0.09] bg-white dark:bg-[#141e2e] text-[#181d25] dark:text-[#f3f5f8]">
              <Squares2X2Icon className="h-4 w-4" aria-hidden />
            </div>
            <h3 className="truncate text-[14px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
              {i18nService.t('metabotBuiltinAvatarTitle')}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={METABOT_ICON_BTN_CLASS}
            aria-label={i18nService.t('close')}
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-5 gap-2.5">
            {BUILTIN_AVATARS.map((avatar) => {
              const selected = normalizedCurrent === avatar.metafileUri;
              return (
                <button
                  key={avatar.code}
                  type="button"
                  data-slot="metabot-builtin-avatar-picker-tile"
                  data-avatar-code={avatar.code}
                  data-pin-id={avatar.pinId}
                  aria-pressed={selected}
                  aria-label={avatar.name}
                  title={avatar.name}
                  onClick={() => onPick(avatar.metafileUri)}
                  className={`relative aspect-square overflow-hidden rounded-[10px] border transition-[border-color,transform,box-shadow] duration-150 focus:outline-none ${
                    selected
                      ? 'border-[#d4af1f] ring-2 ring-[#FFDC51]/65 scale-[0.98]'
                      : 'border-slate-900/[0.10] dark:border-white/[0.10] hover:border-slate-900/[0.25] dark:hover:border-white/[0.25]'
                  }`}
                >
                  <img
                    src={builtinAvatarSrc(avatar)}
                    alt={avatar.name}
                    className="h-full w-full object-cover"
                  />
                  {selected && (
                    <span className="absolute right-1 top-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-[#FFDC51] text-[#24210c] shadow-sm">
                      <CheckIcon className="h-2.5 w-2.5 stroke-[3]" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className={METABOT_MODAL_FOOTER_CLASS}>
          <div className="flex w-full justify-end">
            <button type="button" onClick={onClose} className={METABOT_BTN_FLAT_CLASS}>
              {i18nService.t('cancel')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default BuiltinAvatarPickerModal;
