import React, { useEffect, useRef, useState } from 'react';
import {
  decideSurfaceSessionRename,
  resolveSurfaceSessionDisplayTitle,
} from './surfaceSessionName';

interface CoworkSurfaceSessionNameProps {
  /** The Bot Internet face's open session id; null (draft) renders nothing. */
  sessionId: string | null;
  /**
   * The open session's STORED title, read from the shared cowork sessions
   * list (the node updateSessionTitle patches) so a rename from ANY surface —
   * this slot, a history-drawer row, the transcript header — re-renders here.
   * A stale copy (e.g. the browserCowork slice's session snapshot) must NOT
   * feed this prop: it is not patched by updateSessionTitle.
   */
  title: string;
  /** Default title shown when the stored title is blank ('新会话'). */
  fallbackTitle: string;
  /**
   * The existing rename channel: coworkService.renameSession (its
   * updateSessionTitle dispatch syncs the list and the session header).
   */
  onRename: (sessionId: string, title: string) => void | Promise<void>;
}

/**
 * Centered, ellipsis-truncated session title below the Studio bot identity.
 * A click swaps the label for a frameless editor with identical metrics.
 * Enter or blur commits through the shared rename channel, Escape cancels,
 * and an empty or unchanged commit is a no-op. Drafts keep an empty spacer
 * with the same geometry so the header height remains stable.
 */
const CoworkSurfaceSessionName: React.FC<CoworkSurfaceSessionNameProps> = ({
  sessionId,
  title,
  fallbackTitle,
  onRename,
}) => {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  // Same blur guard as the transcript header's rename: save/cancel set the
  // flag so the input's blur (which fires as the editor unmounts) does not
  // double-commit over the Enter path.
  const ignoreNextBlurRef = useRef(false);

  // Track the stored title while not editing, so external renames (list row,
  // transcript header, title refinement) keep the editor's pending value in
  // sync with what is actually stored.
  useEffect(() => {
    if (!isRenaming) {
      setRenameValue(title);
    }
  }, [isRenaming, title, sessionId]);

  // Focus + select on entering the editor, like the transcript header.
  useEffect(() => {
    if (!isRenaming) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isRenaming]);

  if (sessionId == null) {
    return (
      <div
        data-slot="cowork-surface-session-name-spacer"
        aria-hidden="true"
        className="h-6 w-full min-w-0 flex-none"
      />
    );
  }

  const displayTitle = resolveSurfaceSessionDisplayTitle(title, fallbackTitle);

  const handleRenameSave = (e?: React.SyntheticEvent) => {
    e?.stopPropagation();
    ignoreNextBlurRef.current = true;
    const decision = decideSurfaceSessionRename(title, renameValue);
    if (decision.action === 'rename') {
      void onRename(sessionId, decision.nextTitle);
    }
    setIsRenaming(false);
  };

  const handleRenameCancel = (e?: React.SyntheticEvent) => {
    e?.stopPropagation();
    ignoreNextBlurRef.current = true;
    setRenameValue(title);
    setIsRenaming(false);
  };

  const handleRenameBlur = (event: React.FocusEvent<HTMLInputElement>) => {
    if (ignoreNextBlurRef.current) {
      ignoreNextBlurRef.current = false;
      return;
    }
    handleRenameSave(event);
  };

  if (isRenaming) {
    return (
      <input
        ref={inputRef}
        type="text"
        data-slot="cowork-surface-session-name-input"
        value={renameValue}
        onChange={(e) => setRenameValue(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            handleRenameSave(e);
          }
          if (e.key === 'Escape') {
            handleRenameCancel(e);
          }
        }}
        onBlur={handleRenameBlur}
        className="non-draggable h-6 w-full min-w-0 flex-none border-0 bg-transparent shadow-none px-4 text-center text-[13px] font-medium leading-none dark:text-claude-darkText text-claude-text outline-none focus:outline-none focus:ring-0"
      />
    );
  }

  return (
    <button
      type="button"
      data-slot="cowork-surface-session-name"
      onClick={(e) => {
        e.stopPropagation();
        setRenameValue(title);
        setIsRenaming(true);
      }}
      aria-label={displayTitle}
      title={displayTitle}
      className="non-draggable flex h-6 w-full min-w-0 flex-none items-center justify-center rounded-lg px-4 text-center text-[13px] font-medium leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 text-claude-text dark:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
    >
      <span className="min-w-0 truncate">{displayTitle}</span>
    </button>
  );
};

export default CoworkSurfaceSessionName;
