import React, { useState } from 'react';
import { ClipboardIcon, CheckIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';

/**
 * Low-key id chip with a copy button (long-term task detail headers) — for
 * "just tell them the task id" conversations. Truncated mono id + tooltip with
 * the full id; click copies.
 */
const CopyIdChip: React.FC<{ id: string }> = ({ id }) => {
  const [copied, setCopied] = useState(false);
  const short = id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — the tooltip still exposes the full id
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={i18nService.t('longTermTask.copyId').replace('{id}', id)}
      className="non-draggable inline-flex items-center gap-1 rounded-[8px] px-1.5 py-0.5 font-mono text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
    >
      {copied ? (
        <>
          <CheckIcon className="h-3 w-3 text-emerald-500" />
          <span className="text-emerald-500">{i18nService.t('longTermTask.copied')}</span>
        </>
      ) : (
        <>
          <ClipboardIcon className="h-3 w-3" />
          <span>{short}</span>
        </>
      )}
    </button>
  );
};

export default CopyIdChip;
