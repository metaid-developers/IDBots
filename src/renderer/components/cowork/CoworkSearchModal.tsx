import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MagnifyingGlassIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { CoworkSessionSummary } from '../../types/cowork';
import type { SessionSidebarSection } from '../../utils/sessionAutoGrouping';
import CoworkSessionList from './CoworkSessionList';

interface CoworkSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessions: CoworkSessionSummary[];
  /** Sessions of the currently selected task-record tab (scope filter). */
  scopedSessions: CoworkSessionSummary[];
  /** Display name of the current tab, used for the scope-filter label. */
  scopeLabel: string;
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onTogglePin: (sessionId: string, pinned: boolean) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  /**
   * Move a result row to one of the three sidebar sections via the row menu's
   * "Move to…" submenu; optional, so a host without the sections (or without
   * the handler) simply omits the menu entry.
   */
  onMoveSessionToSection?: (sessionId: string, target: SessionSidebarSection) => void;
}

const CoworkSearchModal: React.FC<CoworkSearchModalProps> = ({
  isOpen,
  onClose,
  sessions,
  scopedSessions,
  scopeLabel,
  currentSessionId,
  onSelectSession,
  onDeleteSession,
  onTogglePin,
  onRenameSession,
  onMoveSessionToSection,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [scopedOnly, setScopedOnly] = useState(true);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const baseSessions = scopedOnly ? scopedSessions : sessions;

  const filteredSessions = useMemo(() => {
    const trimmedQuery = searchQuery.trim().toLowerCase();
    if (!trimmedQuery) return baseSessions;
    return baseSessions.filter((session) => session.title.toLowerCase().includes(trimmedQuery));
  }, [baseSessions, searchQuery]);

  useEffect(() => {
    if (isOpen) {
      // Scope the search to the current tab by default; the toggle falls back
      // to the full history list.
      setScopedOnly(true);
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
      return;
    }
    setSearchQuery('');
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  const handleSelectSession = async (sessionId: string) => {
    await onSelectSession(sessionId);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center modal-backdrop p-6"
      onClick={onClose}
    >
      <div
        className="modal-content glass-surface w-full max-w-2xl mt-10 rounded-2xl overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label={i18nService.t('search')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-glass-line">
          <div className="relative flex-1">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={i18nService.t('searchConversations')}
              className="w-full pl-9 pr-3 py-2 text-sm rounded-lg dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text dark:placeholder-claude-darkTextSecondary placeholder-claude-textSecondary border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent"
            />
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg glass-text-secondary hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
            aria-label={i18nService.t('close')}
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
        <div className="flex items-center px-4 pb-2.5 border-b border-glass-line">
          <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer select-none glass-text-secondary">
            <input
              type="checkbox"
              checked={scopedOnly}
              onChange={(event) => setScopedOnly(event.target.checked)}
              className="accent-claude-accent"
            />
            {i18nService.t('coworkSearchScopedOnly').replace('{scope}', scopeLabel)}
          </label>
        </div>
        {/* Results are a content surface: solid fill inside the glass sheet,
            never glass-on-glass (docs: liquid-glass design law #1). */}
        <div className="mx-3 mb-3 mt-3 rounded-xl border border-claude-border dark:border-claude-darkBorder bg-claude-surface px-3 py-3 max-h-[60vh] overflow-y-auto">
          {filteredSessions.length === 0 ? (
            <div className="py-10 text-center text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('searchNoResults')}
            </div>
          ) : (
            <CoworkSessionList
              sessions={filteredSessions}
              currentSessionId={currentSessionId}
              onSelectSession={handleSelectSession}
              onDeleteSession={onDeleteSession}
              onTogglePin={onTogglePin}
              onRenameSession={onRenameSession}
              onMoveSessionToSection={onMoveSessionToSection}
              /** The modal re-renders with the app on a language switch; the
               * memoized list needs to see it to refresh its labels. */
              language={i18nService.getLanguage()}
            />
          )}
        </div>
      </div>
    </div>
  );
};

export default CoworkSearchModal;
