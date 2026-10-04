import React, { useEffect, useRef, useState } from 'react';
import { i18nService } from '../../services/i18n';

/** Inline "copy" chip with a transient "copied" confirmation — used next to
 * metafile URIs, hashes and pin ids across the detail-v2 surfaces. */
const MetaTaskCopyMini: React.FC<{ text: string; title?: string; className?: string }> = ({
  text,
  title,
  className,
}) => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return (
    <button
      type="button"
      title={title ?? i18nService.t('metatask.cand.copyTip')}
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard.writeText(text).catch(() => {});
        setCopied(true);
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setCopied(false), 1200);
      }}
      className={
        className ??
        'shrink-0 rounded border dark:border-claude-darkBorder border-claude-border px-1 py-px text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text transition-colors'
      }
    >
      {copied ? i18nService.t('metatask.cand.copied') : i18nService.t('metatask.cand.copy')}
    </button>
  );
};

export default MetaTaskCopyMini;
