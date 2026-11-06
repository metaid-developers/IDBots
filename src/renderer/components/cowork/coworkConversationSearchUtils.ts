export interface CoworkSearchOccurrence {
  start: number;
  end: number;
}

export interface CoworkSearchMatch {
  range: Range;
}

interface SearchTextChunk {
  node: Text;
  start: number;
  end: number;
}

export const COWORK_SEARCH_HIGHLIGHT = 'cowork-conversation-search';
export const COWORK_SEARCH_ACTIVE_HIGHLIGHT = 'cowork-conversation-search-active';

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3',
  'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE',
  'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);

const SKIPPED_TAGS = new Set([
  'INPUT', 'NOSCRIPT', 'SCRIPT', 'SELECT', 'STYLE', 'SVG', 'TEMPLATE', 'TEXTAREA',
]);

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const findCoworkSearchOccurrences = (
  text: string,
  query: string,
): CoworkSearchOccurrence[] => {
  if (!query) return [];
  const matcher = new RegExp(escapeRegExp(query), 'giu');
  const occurrences: CoworkSearchOccurrence[] = [];
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    if (!match[0]) break;
    occurrences.push({ start: match.index, end: match.index + match[0].length });
  }
  return occurrences;
};

export const getNextCoworkSearchIndex = (
  currentIndex: number,
  resultCount: number,
  direction: 'previous' | 'next',
): number => {
  if (resultCount <= 0) return -1;
  if (direction === 'previous') {
    return currentIndex < 0
      ? resultCount - 1
      : (currentIndex - 1 + resultCount) % resultCount;
  }
  return currentIndex < 0 ? 0 : (currentIndex + 1) % resultCount;
};

export const isCoworkConversationSearchShortcut = (
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
): boolean => (
  event.key.toLowerCase() === 'f'
  && (event.metaKey || event.ctrlKey)
  && !event.altKey
  && !event.shiftKey
);

const findChunk = (
  chunks: SearchTextChunk[],
  offset: number,
  endOffset: boolean,
): SearchTextChunk | null => {
  let low = 0;
  let high = chunks.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const chunk = chunks[middle];
    if (endOffset ? offset <= chunk.start : offset < chunk.start) {
      high = middle - 1;
    } else if (endOffset ? offset > chunk.end : offset >= chunk.end) {
      low = middle + 1;
    } else {
      return chunk;
    }
  }
  return null;
};

const buildSearchText = (root: HTMLElement): { text: string; chunks: SearchTextChunk[] } => {
  let text = '';
  const chunks: SearchTextChunk[] = [];
  const appendBoundary = () => {
    if (text && !text.endsWith('\n')) text += '\n';
  };

  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      const value = node.nodeValue ?? '';
      if (!value) return;
      const start = text.length;
      text += value;
      chunks.push({ node: node as Text, start, end: text.length });
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as HTMLElement;
    if (
      SKIPPED_TAGS.has(element.tagName)
      || element.closest('[hidden], [aria-hidden="true"], [data-cowork-search-ignore="true"]')
    ) {
      return;
    }
    if (element.tagName === 'BR') {
      appendBoundary();
      return;
    }
    const isBlock = BLOCK_TAGS.has(element.tagName);
    if (isBlock) appendBoundary();
    element.childNodes.forEach(visit);
    if (isBlock) appendBoundary();
  };

  const blocks = root.querySelectorAll<HTMLElement>(
    '[data-export-role="user-message"], [data-export-role="assistant-block"]',
  );
  blocks.forEach(visit);
  return { text, chunks };
};

export const findCoworkConversationSearchMatches = (
  root: HTMLElement | null,
  query: string,
): CoworkSearchMatch[] => {
  if (!root || !query) return [];
  const { text, chunks } = buildSearchText(root);
  const matches: CoworkSearchMatch[] = [];
  for (const occurrence of findCoworkSearchOccurrences(text, query)) {
    const startChunk = findChunk(chunks, occurrence.start, false);
    const endChunk = findChunk(chunks, occurrence.end, true);
    if (!startChunk || !endChunk) continue;
    const range = root.ownerDocument.createRange();
    range.setStart(startChunk.node, occurrence.start - startChunk.start);
    range.setEnd(endChunk.node, occurrence.end - endChunk.start);
    matches.push({ range });
  }
  return matches;
};

export const clearCoworkConversationSearchHighlights = (): void => {
  if (typeof CSS === 'undefined' || !CSS.highlights) return;
  CSS.highlights.delete(COWORK_SEARCH_HIGHLIGHT);
  CSS.highlights.delete(COWORK_SEARCH_ACTIVE_HIGHLIGHT);
};

export const applyCoworkConversationSearchHighlights = (
  matches: CoworkSearchMatch[],
  activeIndex: number,
): void => {
  clearCoworkConversationSearchHighlights();
  if (
    matches.length === 0
    || typeof CSS === 'undefined'
    || !CSS.highlights
    || typeof Highlight === 'undefined'
  ) {
    return;
  }
  CSS.highlights.set(
    COWORK_SEARCH_HIGHLIGHT,
    new Highlight(...matches.map((match) => match.range)),
  );
  const active = matches[activeIndex];
  if (active) {
    CSS.highlights.set(COWORK_SEARCH_ACTIVE_HIGHLIGHT, new Highlight(active.range));
  }
};

export const scrollCoworkSearchMatchIntoView = (
  container: HTMLElement,
  match: CoworkSearchMatch,
): boolean => {
  const rangeRect = match.range.getBoundingClientRect();
  const startElement = match.range.startContainer.nodeType === 1
    ? match.range.startContainer as HTMLElement
    : match.range.startContainer.parentElement;
  const fallback = startElement?.closest<HTMLElement>('[data-export-role]');
  const targetRect = rangeRect.width || rangeRect.height
    ? rangeRect
    : fallback?.getBoundingClientRect();
  if (!targetRect) return false;
  const containerRect = container.getBoundingClientRect();
  const centered = container.scrollTop
    + targetRect.top - containerRect.top
    - Math.max(0, (container.clientHeight - targetRect.height) / 2);
  container.scrollTo({ top: Math.max(0, centered), behavior: 'auto' });
  return true;
};
