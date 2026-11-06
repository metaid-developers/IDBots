import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  MagnifyingGlassIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import {
  applyCoworkConversationSearchHighlights,
  clearCoworkConversationSearchHighlights,
  findCoworkConversationSearchMatches,
  getNextCoworkSearchIndex,
  isCoworkConversationSearchShortcut,
  scrollCoworkSearchMatchIntoView,
  type CoworkSearchMatch,
} from './coworkConversationSearchUtils';

export interface CoworkConversationSearchHandle {
  open: () => void;
  close: () => void;
}

interface CoworkConversationSearchProps {
  rootRef: React.RefObject<HTMLDivElement>;
  containerRef: React.RefObject<HTMLDivElement>;
  sessionId: string;
  enabled: boolean;
  contentVersion: unknown;
  hasMoreBefore: boolean;
  isLoadingEarlierMessages: boolean;
  loadEarlierMessages: () => Promise<number>;
  onBeforeNavigate: () => void;
  onOpenChange: (isOpen: boolean) => void;
}

interface CoworkConversationSearchBarProps {
  inputRef: React.RefObject<HTMLInputElement>;
  query: string;
  resultCount: number;
  activeIndex: number;
  isSearching: boolean;
  isPartial: boolean;
  onQueryChange: (query: string) => void;
  onNavigate: (direction: 'previous' | 'next') => void;
  onClose: () => void;
}

export const CoworkConversationSearchBar: React.FC<CoworkConversationSearchBarProps> = ({
  inputRef,
  query,
  resultCount,
  activeIndex,
  isSearching,
  isPartial,
  onQueryChange,
  onNavigate,
  onClose,
}) => {
  const hasMatches = resultCount > 0 && !isSearching;
  const resultLabel = isSearching
    ? i18nService.t('coworkConversationSearchSearching')
    : isPartial
      ? i18nService.t('coworkConversationSearchPartialResults').replace('{count}', String(resultCount))
      : i18nService.t('coworkConversationSearchResults')
        .replace('{current}', String(activeIndex >= 0 ? activeIndex + 1 : 0))
        .replace('{total}', String(resultCount));

  return (
    <div
      id="cowork-conversation-search"
      role="search"
      aria-label={i18nService.t('coworkConversationSearch')}
      className="shrink-0 border-b border-claude-border bg-claude-surface/50 px-4 py-2 animate-fade-in dark:border-claude-darkBorder dark:bg-claude-darkSurface/50"
    >
      <div className="mx-auto max-w-[clamp(680px,64%,920px)] overflow-hidden rounded-xl border border-claude-border bg-claude-surface shadow-subtle dark:border-claude-darkBorder dark:bg-claude-darkSurface">
        <div className="flex h-10 items-center">
          <MagnifyingGlassIcon className="ml-3 h-4 w-4 shrink-0 text-claude-textSecondary dark:text-claude-darkTextSecondary" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              const isComposing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
              if (event.key !== 'Enter' || !hasMatches || isComposing) return;
              event.preventDefault();
              onNavigate(event.shiftKey ? 'previous' : 'next');
            }}
            placeholder={i18nService.t('coworkConversationSearchPlaceholder')}
            aria-label={i18nService.t('coworkConversationSearchPlaceholder')}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent px-2.5 text-sm text-claude-text outline-none placeholder:text-claude-textSecondary dark:text-claude-darkText dark:placeholder:text-claude-darkTextSecondary"
          />
          <button
            type="button"
            onClick={onClose}
            title={i18nService.t('close')}
            aria-label={i18nService.t('close')}
            className="mr-0.5 flex h-10 w-10 shrink-0 items-center justify-center border-l border-claude-border text-claude-textSecondary transition-colors hover:bg-claude-surfaceHover hover:text-claude-text active:scale-[0.96] dark:border-claude-darkBorder dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover dark:hover:text-claude-darkText"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="flex h-10 items-center border-t border-claude-border dark:border-claude-darkBorder">
          <button
            type="button"
            disabled={!hasMatches}
            onClick={() => onNavigate('previous')}
            title={i18nService.t('coworkConversationSearchPrevious')}
            aria-label={i18nService.t('coworkConversationSearchPrevious')}
            className="flex h-10 w-10 items-center justify-center text-claude-textSecondary transition-colors hover:bg-claude-surfaceHover hover:text-claude-text active:scale-[0.96] disabled:cursor-default disabled:opacity-35 dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover dark:hover:text-claude-darkText"
          >
            <ArrowUpIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={!hasMatches}
            onClick={() => onNavigate('next')}
            title={i18nService.t('coworkConversationSearchNext')}
            aria-label={i18nService.t('coworkConversationSearchNext')}
            className="flex h-10 w-10 items-center justify-center text-claude-textSecondary transition-colors hover:bg-claude-surfaceHover hover:text-claude-text active:scale-[0.96] disabled:cursor-default disabled:opacity-35 dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover dark:hover:text-claude-darkText"
          >
            <ArrowDownIcon className="h-4 w-4" />
          </button>
          <span
            aria-live="polite"
            className="ml-auto select-none px-3 text-xs tabular-nums text-claude-textSecondary dark:text-claude-darkTextSecondary"
          >
            {resultLabel}
          </span>
        </div>
      </div>
    </div>
  );
};

const CoworkConversationSearch = forwardRef<CoworkConversationSearchHandle, CoworkConversationSearchProps>(({
  rootRef,
  containerRef,
  sessionId,
  enabled,
  contentVersion,
  hasMoreBefore,
  isLoadingEarlierMessages,
  loadEarlierMessages,
  onBeforeNavigate,
  onOpenChange,
}, ref) => {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [settledQuery, setSettledQuery] = useState('');
  const [resultCount, setResultCount] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [isSearching, setIsSearching] = useState(false);
  const [historyLoadFailed, setHistoryLoadFailed] = useState(false);
  const [domRevision, setDomRevision] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const matchesRef = useRef<CoworkSearchMatch[]>([]);
  const activeIndexRef = useRef(-1);
  const pendingInitialJumpRef = useRef(true);
  const latestSearchRef = useRef({ sessionId, query });
  latestSearchRef.current = { sessionId, query };

  const clearMatches = useCallback(() => {
    matchesRef.current = [];
    activeIndexRef.current = -1;
    setResultCount(0);
    setActiveIndex(-1);
    clearCoworkConversationSearchHighlights();
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setQuery('');
    setSettledQuery('');
    setIsSearching(false);
    setHistoryLoadFailed(false);
    pendingInitialJumpRef.current = true;
    clearMatches();
  }, [clearMatches]);

  const open = useCallback(() => {
    if (!enabled) return;
    setIsOpen(true);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [enabled]);

  useImperativeHandle(ref, () => ({ open, close }), [open, close]);

  useEffect(() => {
    onOpenChange(isOpen);
  }, [isOpen, onOpenChange]);

  useEffect(() => {
    close();
  }, [sessionId, close]);

  useEffect(() => {
    if (!enabled) close();
  }, [enabled, close]);

  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      const withinConversation = target === document.body
        || (target instanceof Node && Boolean(rootRef.current?.contains(target)));
      if (isCoworkConversationSearchShortcut(event) && withinConversation) {
        event.preventDefault();
        event.stopPropagation();
        open();
        return;
      }
      if (event.key === 'Escape' && isOpen && withinConversation) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [enabled, isOpen, open, close, rootRef]);

  useEffect(() => {
    if (!isOpen) return;
    const timer = window.setTimeout(() => {
      pendingInitialJumpRef.current = true;
      setSettledQuery(query);
      if (!query) {
        clearMatches();
        setIsSearching(false);
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [isOpen, query, clearMatches]);

  useEffect(() => {
    if (
      !isOpen
      || !settledQuery
      || settledQuery !== query
      || !hasMoreBefore
      || historyLoadFailed
      || isLoadingEarlierMessages
    ) {
      return;
    }
    const requestedSessionId = sessionId;
    const requestedQuery = settledQuery;
    void loadEarlierMessages().then((loadedCount) => {
      const latest = latestSearchRef.current;
      if (
        loadedCount <= 0
        && latest.sessionId === requestedSessionId
        && latest.query === requestedQuery
      ) {
        setHistoryLoadFailed(true);
      }
    }).catch(() => {
      const latest = latestSearchRef.current;
      if (latest.sessionId === requestedSessionId && latest.query === requestedQuery) {
        setHistoryLoadFailed(true);
      }
    });
  }, [
    isOpen,
    query,
    settledQuery,
    sessionId,
    hasMoreBefore,
    historyLoadFailed,
    isLoadingEarlierMessages,
    loadEarlierMessages,
  ]);

  useEffect(() => {
    if (!isOpen) return;
    const container = containerRef.current;
    if (!container || typeof MutationObserver === 'undefined') return;
    let timer: number | null = null;
    const observer = new MutationObserver(() => {
      if (timer != null) return;
      timer = window.setTimeout(() => {
        timer = null;
        setDomRevision((revision) => revision + 1);
      }, 80);
    });
    observer.observe(container, { childList: true, characterData: true, subtree: true });
    return () => {
      observer.disconnect();
      if (timer != null) window.clearTimeout(timer);
    };
  }, [isOpen, containerRef, sessionId]);

  useLayoutEffect(() => {
    if (!isOpen || !settledQuery || settledQuery !== query) return;
    if ((hasMoreBefore && !historyLoadFailed) || isLoadingEarlierMessages) {
      setIsSearching(true);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container) return;
      const matches = findCoworkConversationSearchMatches(container, settledQuery);
      const shouldJumpToFirst = pendingInitialJumpRef.current;
      pendingInitialJumpRef.current = false;
      const nextActiveIndex = matches.length === 0
        ? -1
        : shouldJumpToFirst
          ? 0
          : Math.min(Math.max(activeIndexRef.current, 0), matches.length - 1);
      matchesRef.current = matches;
      activeIndexRef.current = nextActiveIndex;
      setResultCount(matches.length);
      setActiveIndex(nextActiveIndex);
      setIsSearching(false);
      applyCoworkConversationSearchHighlights(matches, nextActiveIndex);
      if (shouldJumpToFirst && nextActiveIndex >= 0) {
        onBeforeNavigate();
        scrollCoworkSearchMatchIntoView(container, matches[nextActiveIndex]);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    isOpen,
    query,
    settledQuery,
    contentVersion,
    domRevision,
    hasMoreBefore,
    historyLoadFailed,
    isLoadingEarlierMessages,
    containerRef,
    onBeforeNavigate,
  ]);

  useEffect(() => () => {
    clearCoworkConversationSearchHighlights();
  }, []);

  const navigate = useCallback((direction: 'previous' | 'next') => {
    const matches = matchesRef.current;
    const nextIndex = getNextCoworkSearchIndex(activeIndexRef.current, matches.length, direction);
    if (nextIndex < 0) return;
    activeIndexRef.current = nextIndex;
    setActiveIndex(nextIndex);
    applyCoworkConversationSearchHighlights(matches, nextIndex);
    const container = containerRef.current;
    if (container) {
      onBeforeNavigate();
      scrollCoworkSearchMatchIntoView(container, matches[nextIndex]);
    }
  }, [containerRef, onBeforeNavigate]);

  const handleQueryChange = useCallback((nextQuery: string) => {
    pendingInitialJumpRef.current = true;
    setQuery(nextQuery);
    setIsSearching(Boolean(nextQuery));
    setHistoryLoadFailed(false);
    clearMatches();
  }, [clearMatches]);

  if (!isOpen) return null;

  return (
    <CoworkConversationSearchBar
      inputRef={inputRef}
      query={query}
      resultCount={resultCount}
      activeIndex={activeIndex}
      isSearching={isSearching}
      isPartial={historyLoadFailed && hasMoreBefore}
      onQueryChange={handleQueryChange}
      onNavigate={navigate}
      onClose={close}
    />
  );
});

CoworkConversationSearch.displayName = 'CoworkConversationSearch';

export default CoworkConversationSearch;
