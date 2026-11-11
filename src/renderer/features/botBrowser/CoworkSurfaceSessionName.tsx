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
 * The surface header's inline session-name slot (owner order 2026-11-11
 * 17:37, item ④; reworked by the 18:05 order; left-anchor + frameless
 * editor by the 18:54 order): the Bot Internet face's open session name is
 * the actions row's LEFT TITLE — its root lane grows (flexible, shrink-safe)
 * from directly under the Studio label and pins the 新建会话 / 会话记录
 * buttons to the row's right end (supersedes the 17:37 between-the-buttons
 * placement). The title reads one step darker and medium at 13 px — a level
 * past the row's secondary icon ink — and truncates with an ellipsis.
 * Default state is a read-only label; a single click swaps in an inline
 * frameless editor (transparent background, no border/ring/shadow, the SAME
 * 13 px medium metrics as the display state — only the caret marks it as
 * editable; owner 18:54 feedback, the old boxed input broke the title look).
 * Enter or blur commits through the shared rename channel, Escape cancels,
 * and an empty commit is a deliberate no-op — the display falls back to the
 * default title and never blanks the stored title.
 * LEFT-ANCHOR contract (owner 18:54 feedback): the draft state (no open
 * session) renders a non-interactive spacer riding the SAME flex-1 lane
 * instead of unmounting, so the identity component pinned before this slot
 * never drifts toward the right end when the name is absent — the row's
 * free space is always absorbed by this lane, keeping the whole group
 * flush with the row's left edge and the icon cluster at the right end.
 * The contract mirrors the two rename implementations that already exist
 * (CoworkSessionItem rows and the CoworkSessionDetail header); the decision
 * math lives in the pure surfaceSessionName module.
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
    // Draft state (no open session): a non-interactive spacer riding the
    // same flex-1 lane as the title mounts. It absorbs the row's free
    // space exactly like the real title lane, so the identity component
    // portaled ahead of this slot stays pinned at the row's LEFT edge and
    // the icon cluster stays at the right end — no right-end drift when
    // there is no name (owner 18:54 feedback). Zero interaction, zero ink.
    return (
      <div
        data-slot="cowork-surface-session-name-spacer"
        aria-hidden="true"
        className="h-7 min-w-0 flex-1"
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
        // The editor rides the SAME left lane as the title, so the
        // read → edit swap never moves the row's geometry. Frameless inline
        // editing (owner 18:54 feedback): transparent background, no
        // border/ring/shadow — the caret is the ONLY edit affordance, and
        // the 13 px medium metrics are byte-identical to the display
        // state's so the swap reads as the same title, not a form field.
        className="non-draggable h-7 min-w-0 flex-1 border-0 bg-transparent shadow-none px-2 text-left text-[13px] font-medium leading-none dark:text-claude-darkText text-claude-text outline-none focus:outline-none focus:ring-0"
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
      // The title lane: flex-1 absorbs the free space left of the icon
      // cluster (the shared actions row stays justify-end). pl-2 puts the
      // label text directly under the Studio label's own text — the band's
      // 8 px bar inset + 1 px tray border + 2 px tray padding + 8 px segment
      // padding ≈ this row's 10 px inset + 8 px title padding — while the
      // hover pill keeps the row's px-2 rhythm. Title ink: one level darker
      // than the row's secondary icons, medium at 13 px.
      className="non-draggable flex h-7 min-w-0 flex-1 items-center rounded-lg px-2 text-left text-[13px] font-medium leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 text-claude-text dark:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
    >
      <span className="min-w-0 truncate">{displayTitle}</span>
    </button>
  );
};

export default CoworkSurfaceSessionName;
