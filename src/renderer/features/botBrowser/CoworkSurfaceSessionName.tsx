import React, { useEffect, useRef, useState } from 'react';
import {
  decideSurfaceSessionRename,
  resolveSurfaceSessionDisplayTitle,
} from './surfaceSessionName';

/**
 * Inline replica of lucide-react's `MessageSquare` (24×24 stroke SVG, ISC;
 * path verbatim from lucide) — owner icon ruling 2026-11-15 09:03 for the
 * session-name prefix. lucide-react is NOT in package.json and the
 * worktree's node_modules is a symlink into the main checkout, so adding the
 * dependency would mutate the main tree's graph; the decision to install (or
 * keep this replica) belongs to the orchestrator. Mon design: square chat
 * bubble (NOT MessageCircle, NOT double-bubble), 14px (verified already at 14 —
 * the 09:51 ruling's "back from 16px" premise did not exist in this tree),
 * secondary text color.
 */
const SessionNameMessageSquareIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    data-slot="cowork-surface-session-name-icon"
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={className}
  >
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

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
  /**
   * Editing-state bridge for the studio header's grace-collapse logic
   * (owner ruling 2026-11-15 09:17 clause ②): fires `true` when the inline
   * editor opens and `false` when it closes (commit or cancel). While
   * `true`, the header suppresses its auto-collapse entirely.
   */
  onRenameEditingChange?: (editing: boolean) => void;
}

/**
 * Left-anchored, ellipsis-truncated session title below the Studio bot
 * identity (owner order 2026-11-15: centered lane retired; the title's left
 * edge rides pl-1 so its text lands on the identity avatar's left edge, and
 * the size steps up one token (13px → text-base/15px at the 15px root) — the
 * title is the hover-revealed element, exempt from the compact row's scale).
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
  onRenameEditingChange,
}) => {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  // Same blur guard as the transcript header's rename: save/cancel set the
  // flag so the input's blur (which fires as the editor unmounts) does not
  // double-commit over the Enter path.
  const ignoreNextBlurRef = useRef(false);

  // Single funnel for the editing state: every transition (click into the
  // editor, commit, cancel) ALSO bridges to the header's grace-collapse
  // logic (owner ruling 2026-11-15 09:17 clause ② — editing pins the row).
  const applyRenaming = (next: boolean) => {
    setIsRenaming(next);
    onRenameEditingChange?.(next);
  };

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
        className="h-6 min-w-0 flex-none mx-[41.25px] w-[calc(100%-82.5px)]"
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
    applyRenaming(false);
  };

  const handleRenameCancel = (e?: React.SyntheticEvent) => {
    e?.stopPropagation();
    ignoreNextBlurRef.current = true;
    setRenameValue(title);
    applyRenaming(false);
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
        className="non-draggable h-6 min-w-0 flex-none mx-[41.25px] w-[calc(100%-82.5px)] border-0 bg-transparent shadow-none pl-0 pr-0 text-left text-sm font-medium leading-none dark:text-claude-darkText text-claude-text outline-none focus:outline-none focus:ring-0"
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
        applyRenaming(true);
      }}
      aria-label={displayTitle}
      title={displayTitle}
      className="non-draggable group flex h-6 min-w-0 flex-none mx-[41.25px] w-[calc(100%-82.5px)] items-center rounded-lg gap-[6px] pl-0 pr-0 text-left text-sm font-medium leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 text-claude-text dark:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
    >
      <SessionNameMessageSquareIcon className="w-[1em] h-[1em] flex-none text-claude-textSecondary transition-colors group-hover:text-claude-text dark:text-claude-darkTextSecondary dark:group-hover:text-claude-darkText" />
      <span className="min-w-0 truncate">{displayTitle}</span>
    </button>
  );
};

export default CoworkSurfaceSessionName;
