import React, { useState } from 'react';
import { BookOpenIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { coworkService } from '../../services/cowork';

interface StudioChapterCloseButtonProps {
  sessionId: string;
  /** Disable while a turn is running (the close requires an idle session). */
  disabled?: boolean;
}

/**
 * Manual Studio chapter close (Phase 1 slice 2, owner ruling 方案 B): closes
 * the active chapter with an idle-time LLM chapter card, compacts the working
 * context via native compactNow, and opens the next chapter — the
 * conversation keeps its history (chapter cards + conversation_recall) while
 * the working set resets to "fresh session" sharpness. Always visible in the
 * composer tool row for live Studio sessions, unlike the usage-gated manual
 * compact button: chaptering is the primary context strategy for
 * months-long conversations, not an emergency lever.
 */
const StudioChapterCloseButton: React.FC<StudioChapterCloseButtonProps> = ({
  sessionId,
  disabled = false,
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label = i18nService.t('studioChapterClose');
  const handleClick = async () => {
    if (busy || disabled) return;
    setBusy(true);
    setError(null);
    try {
      const result = await coworkService.closeSessionChapter(sessionId);
      if (!result.success) {
        setError(result.error || i18nService.t('studioChapterCloseFailed'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : i18nService.t('studioChapterCloseFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative inline-flex flex-col items-end">
      <button
        type="button"
        onClick={() => { void handleClick(); }}
        disabled={disabled || busy}
        title={error ?? label}
        aria-label={label}
        className="p-1.5 rounded-lg text-xs font-medium transition-colors dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:hover:text-claude-darkText hover:text-claude-text disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <BookOpenIcon className={`h-4 w-4 ${busy ? 'animate-pulse' : ''}`} />
      </button>
      {error && (
        <span className="absolute top-full right-0 z-20 mt-1 whitespace-nowrap rounded-md border border-red-200 dark:border-red-800/60 bg-white dark:bg-claude-darkBg px-1.5 py-0.5 text-[10px] text-red-500 dark:text-red-400 shadow-sm">
          {error}
        </span>
      )}
    </div>
  );
};

export default StudioChapterCloseButton;
