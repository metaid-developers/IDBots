import React, { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import {
  HandThumbUpIcon as HandThumbUpOutlineIcon,
  HandThumbDownIcon as HandThumbDownOutlineIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import {
  HandThumbUpIcon as HandThumbUpSolidIcon,
  HandThumbDownIcon as HandThumbDownSolidIcon,
} from '@heroicons/react/24/solid';
import { RootState } from '../../store';
import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import type { MessageFeedbackRating } from '../../types/cowork';

/**
 * Thumbs up/down feedback controls for one assistant message, rendered next to
 * the copy button. Selecting a thumb records the rating and opens an optional
 * comment panel; clicking the other thumb switches the rating (panel stays
 * open); clicking the active thumb clears the rating and closes the panel.
 */
const MessageFeedbackControls: React.FC<{
  messageId: string;
  visible: boolean;
}> = ({ messageId, visible }) => {
  const feedback = useSelector((state: RootState) => state.cowork.feedbackByMessageId[messageId]);
  const rating = feedback?.rating ?? null;
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [commentDraft, setCommentDraft] = useState(feedback?.comment ?? '');
  const containerRef = useRef<HTMLDivElement>(null);

  // Close the panel without saving on click outside or Escape.
  useEffect(() => {
    if (!isPanelOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsPanelOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsPanelOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isPanelOpen]);

  const handleThumbClick = (next: MessageFeedbackRating) => {
    if (rating === next) {
      // Clicking the active thumb toggles the rating off.
      setIsPanelOpen(false);
      void coworkService.setMessageFeedback({ messageId, rating: null });
      return;
    }
    if (!isPanelOpen) {
      // Opening the panel fresh: pre-fill with the last saved comment.
      setCommentDraft(feedback?.comment ?? '');
    }
    setIsPanelOpen(true);
    void coworkService.setMessageFeedback({
      messageId,
      rating: next,
      comment: feedback?.comment ?? null,
    });
  };

  const handleSaveComment = () => {
    if (!rating) return;
    const comment = commentDraft.trim();
    void coworkService.setMessageFeedback({
      messageId,
      rating,
      comment: comment.length > 0 ? comment : null,
    });
    setIsPanelOpen(false);
  };

  const renderThumbButton = (value: MessageFeedbackRating) => {
    const isActive = rating === value;
    const OutlineIcon = value === 'up' ? HandThumbUpOutlineIcon : HandThumbDownOutlineIcon;
    const SolidIcon = value === 'up' ? HandThumbUpSolidIcon : HandThumbDownSolidIcon;
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          handleThumbClick(value);
        }}
        className={`p-1.5 rounded-md dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-all duration-200 ${
          isActive || visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
        } ${
          isActive
            ? 'text-claude-accent'
            : 'dark:text-claude-darkTextSecondary text-claude-textSecondary'
        }`}
        title={i18nService.t(value === 'up' ? 'coworkFeedbackGood' : 'coworkFeedbackBad')}
      >
        {isActive ? (
          <SolidIcon className="w-4 h-4" />
        ) : (
          <OutlineIcon className="w-4 h-4" />
        )}
      </button>
    );
  };

  return (
    <div ref={containerRef} className="relative flex items-center gap-1.5">
      {renderThumbButton('up')}
      {renderThumbButton('down')}
      {rating && isPanelOpen && (
        <div className="absolute left-0 top-full mt-1 w-64 rounded-xl shadow-xl dark:bg-claude-darkBg bg-claude-bg dark:border-claude-darkBorder border-claude-border border p-2 z-50">
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={() => setIsPanelOpen(false)}
              className="p-1 rounded-md dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary transition-colors"
              title={i18nService.t('close')}
            >
              <XMarkIcon className="w-4 h-4" />
            </button>
          </div>
          <textarea
            rows={2}
            maxLength={2000}
            value={commentDraft}
            onChange={(e) => setCommentDraft(e.target.value)}
            placeholder={i18nService.t('coworkFeedbackPlaceholder')}
            className="w-full resize-none rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset px-3 py-2 text-sm dark:text-claude-darkText text-claude-text placeholder:dark:text-claude-darkTextSecondary/50 placeholder:text-claude-textSecondary/50 focus:outline-none focus:ring-1 focus:ring-claude-accent/40"
          />
          <div className="flex items-center justify-end mt-2">
            <button
              type="button"
              onClick={handleSaveComment}
              className="px-3 py-1.5 text-sm font-medium rounded-[8px] bg-claude-accent hover:opacity-90 text-claude-accentInk transition-colors"
            >
              {i18nService.t('save')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default MessageFeedbackControls;
