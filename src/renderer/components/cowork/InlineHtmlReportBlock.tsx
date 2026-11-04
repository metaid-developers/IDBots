/**
 * InlineHtmlReportBlock — assistant-mode HTML report rendered in place.
 *
 * Assistant chat links to a local .html/.htm deliverable used to open the
 * right-hand MarkdownViewerPanel via a report card; the block now renders the
 * document directly inside the message column instead (full column width,
 * outside any text bubble). The document runs in a sandboxed srcdoc iframe
 * whose height tracks its content through a ResizeObserver + postMessage
 * reporter injected next to the <base href> the MarkdownViewerPanel already
 * uses for relative assets. The injected script double-jobs as a link
 * bridge: clicks on idbots:// anchors are forwarded to the parent, which
 * routes session deep links (idbots://session/<id> and the bare
 * IDBots://<id> form) through the same
 * 'cowork:viewSession' event Markdown links use, so report links jump to
 * the referenced conversation exactly like their markdown counterparts.
 * A toolbar carrying the title plus the
 * open-in-panel / view-source / download-as-image actions floats over the
 * report's top edge: it stays hidden (and click-transparent) until the
 * pointer hovers the block or its right-click menu is open, so the report
 * sits flush against the surrounding chat text with no permanent chrome.
 * The right-click menu adds the file-level conveniences (copy path, reveal,
 * open with default app). Reports taller than the frame cap (10000px) render
 * truncated with a footer notice plus an "open full report" action, so the
 * cut-off is explicit instead of silently unreachable.
 *
 * If the file cannot be read (missing, not a file, over the size cap, or
 * binary), the block degrades to the previous report card so the message
 * never shows a broken frame.
 *
 * Pure helpers (srcdoc construction, height-message parsing, height
 * clamping) are exported on purpose: this repo's renderer tests are
 * server-rendered with no DOM, so they drive these helpers directly
 * and pin the component wiring through source assertions.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownTrayIcon,
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  CodeBracketIcon,
  ComputerDesktopIcon,
  DocumentChartBarIcon,
  DocumentDuplicateIcon,
  EyeIcon,
  FolderOpenIcon,
} from '@heroicons/react/24/outline';
// @ts-ignore
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-light';
// @ts-ignore
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
// @ts-ignore
import prismMarkup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import { i18nService } from '../../services/i18n';
import { dispatchViewSession, parseIdbotsSessionUri } from '../../utils/sessionDeepLink';
import { buildLocalFileUrl } from '../../services/localFileUrl';
import { injectHtmlBaseHref } from './MarkdownViewerPanel';
import LocalFileLink from '../ui/LocalFileLink';

SyntaxHighlighter.registerLanguage('markup', prismMarkup);

/** Marker field the in-frame script posts on every block message (height reports and idbots:// nav requests). */
export const INLINE_HTML_HEIGHT_MESSAGE_KEY = '__idbotsHtmlBlock';

/** Reporter iframe height bounds: below 40px is a broken frame, above 10000px a runaway document. */
const MIN_FRAME_HEIGHT = 40;
const MAX_FRAME_HEIGHT = 10000;

export const clampInlineHtmlHeight = (height: number): number => {
  if (!Number.isFinite(height)) return MIN_FRAME_HEIGHT;
  return Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, Math.round(height)));
};

/**
 * Validate a window 'message' event from a reporter iframe: the data must
 * carry the marker field with a finite numeric height, and the source must
 * be exactly the iframe's contentWindow so multiple blocks in one session
 * never react to each other's reports. Returns the clamped height plus a
 * `truncated` flag when the raw report exceeded MAX_FRAME_HEIGHT — the frame
 * caps at the max and the document below it stays unreachable, so the block
 * must surface that state instead of silently cutting the report off.
 */
export const parseInlineHtmlHeightReport = (
  data: unknown,
  source: unknown,
  iframeWindow: unknown,
): { height: number; truncated: boolean } | null => {
  if (!iframeWindow || source !== iframeWindow) return null;
  if (!data || typeof data !== 'object') return null;
  const payload = data as Record<string, unknown>;
  if (payload[INLINE_HTML_HEIGHT_MESSAGE_KEY] !== true) return null;
  if (typeof payload.h !== 'number' || !Number.isFinite(payload.h)) return null;
  return { height: clampInlineHtmlHeight(payload.h), truncated: payload.h > MAX_FRAME_HEIGHT };
};

/** Height-only view of parseInlineHtmlHeightReport (see its contract). */
export const parseInlineHtmlHeightMessage = (
  data: unknown,
  source: unknown,
  iframeWindow: unknown,
): number | null => {
  const report = parseInlineHtmlHeightReport(data, source, iframeWindow);
  return report ? report.height : null;
};

/**
 * Same per-instance contract as parseInlineHtmlHeightMessage, for the
 * in-frame link bridge: a marked payload whose `nav` is a non-empty string
 * is an idbots:// link click the parent should route. Returns the raw href
 * (the caller validates the exact idbots:// shape before acting) or null.
 */
export const parseInlineHtmlNavMessage = (
  data: unknown,
  source: unknown,
  iframeWindow: unknown,
): string | null => {
  if (!iframeWindow || source !== iframeWindow) return null;
  if (!data || typeof data !== 'object') return null;
  const payload = data as Record<string, unknown>;
  if (payload[INLINE_HTML_HEIGHT_MESSAGE_KEY] !== true) return null;
  if (typeof payload.nav !== 'string' || !payload.nav) return null;
  return payload.nav;
};

/**
 * In-frame height reporter + idbots:// link bridge, injected before </body>
 * (or appended when the document has no body close tag). ResizeObserver
 * covers async layout (charts, images, fonts); load + two delayed reports
 * cover documents the observer fires before the final layout settles. The
 * capture-phase click listener intercepts idbots:// anchors — the sandboxed
 * frame cannot navigate to them anyway — and forwards the href to the
 * parent, which routes session deep links exactly like Markdown links do.
 */
export const buildInlineHtmlReporterScript = (): string => [
  '(function () {',
  '  var KEY = ' + JSON.stringify(INLINE_HTML_HEIGHT_MESSAGE_KEY) + ';',
  '  function reportHeight() {',
  '    var body = document.body;',
  '    var root = document.documentElement;',
  '    var bodyHeight = body ? (body.scrollHeight || 0) : 0;',
  '    var rootHeight = root ? (root.scrollHeight || 0) : 0;',
  '    var h = Math.ceil(Math.max(bodyHeight, rootHeight));',
  '    try { parent.postMessage({ [KEY]: true, h: h }, "*"); } catch (err) {}',
  '  }',
  '  try {',
  '    if (typeof ResizeObserver === "function") {',
  '      var observer = new ResizeObserver(function () { reportHeight(); });',
  '      if (document.documentElement) observer.observe(document.documentElement);',
  '      if (document.body) observer.observe(document.body);',
  '      window.__idbotsHtmlHeightObserver = observer;',
  '    }',
  '  } catch (err) {}',
  '  window.addEventListener("load", reportHeight);',
  '  reportHeight();',
  '  setTimeout(reportHeight, 300);',
  '  setTimeout(reportHeight, 1000);',
  '  document.addEventListener("click", function (event) {',
  '    var node = event.target;',
  '    var anchor = node && node.closest ? node.closest("a[href]") : null;',
  '    if (!anchor) return;',
  '    var href = anchor.getAttribute("href") || "";',
  '    if (!/^idbots:\\/\\//i.test(href)) return;',
  '    event.preventDefault();',
  '    event.stopPropagation();',
  '    try { parent.postMessage({ [KEY]: true, nav: href }, "*"); } catch (err) {}',
  '  }, true);',
  '})();',
].join('\n');

/**
 * Build the srcdoc for the inline frame: original document, plus the
 * file-directory <base href> that resolves relative assets (same helper the
 * MarkdownViewerPanel uses), plus the height reporter script.
 */
export const buildInlineHtmlSrcDoc = (html: string, filePath: string): string => {
  const withBase = injectHtmlBaseHref(html, filePath);
  const reporterTag = `<script>${buildInlineHtmlReporterScript()}</script>`;
  return /<\/body[^>]*>/i.test(withBase)
    ? withBase.replace(/<\/body[^>]*>/i, (match) => `${reporterTag}${match}`)
    : `${withBase}${reporterTag}`;
};

const showToast = (message: string): void => {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

// Align with DSH WebUI markdown code blocks: 11px/19px mono, 16px padding.
const SOURCE_VIEW_STYLE = {
  margin: 0,
  borderRadius: 0,
  background: '#282c34',
  padding: '16px',
  fontSize: '11px',
  lineHeight: '19px',
};

const MENU_WIDTH = 208;
const MENU_ITEM_HEIGHT = 34;
const DEFAULT_FRAME_HEIGHT = 120;

interface InlineHtmlReportBlockProps {
  /** Resolved absolute path of the local .html/.htm report. */
  filePath: string;
  /** Link text the Bot used for the report (shown as the block title). */
  displayName: string;
  /** Open the report in the right-hand document panel (same onOpenLocalFile chain as file links). */
  onOpenInSidePanel?: (filePath: string, event: React.MouseEvent) => boolean | void;
}

const InlineHtmlReportBlock: React.FC<InlineHtmlReportBlockProps> = ({
  filePath,
  displayName,
  onOpenInSidePanel,
}) => {
  const [status, setStatus] = useState<'loading' | 'ready' | 'fallback'>('loading');
  const [html, setHtml] = useState('');
  const [view, setView] = useState<'render' | 'source'>('render');
  const [height, setHeight] = useState(DEFAULT_FRAME_HEIGHT);
  const [heightTruncated, setHeightTruncated] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [copiedPath, setCopiedPath] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const copiedTimerRef = useRef<number | null>(null);
  const platform = useMemo(() => (window as any)?.electron?.platform ?? '', []);
  const revealLabel = platform === 'darwin'
    ? i18nService.t('fileRevealInFinder')
    : platform === 'win32'
      ? i18nService.t('fileShowInExplorer')
      : i18nService.t('showInFolder');

  useEffect(() => () => {
    if (copiedTimerRef.current != null) {
      window.clearTimeout(copiedTimerRef.current);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setView('render');
    setHeight(DEFAULT_FRAME_HEIGHT);
    setHeightTruncated(false);
    void (async () => {
      try {
        const result = await window.electron.fs.readTextFile(filePath);
        if (cancelled) return;
        const content = result?.success && typeof result.content === 'string' ? result.content : '';
        // A NUL byte marks binary content that must not land in a srcdoc frame.
        if (!content || content.includes('\u0000')) {
          setStatus('fallback');
          setHtml('');
          return;
        }
        setHtml(content);
        setStatus('ready');
      } catch {
        if (!cancelled) {
          setStatus('fallback');
          setHtml('');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  // Track the in-frame reporter: accept only messages whose source is THIS
  // block's iframe (multiple blocks share the window 'message' bus). Height
  // reports resize the frame — and flag truncation when the raw report tops
  // the frame cap, so the footer notice only appears while content is truly
  // cut off; nav requests are idbots:// link clicks, routed through the same
  // session deep-link path as Markdown links.
  useEffect(() => {
    if (status !== 'ready') return;
    const handleMessage = (event: MessageEvent) => {
      const iframeWindow = iframeRef.current?.contentWindow ?? null;
      const heightReport = parseInlineHtmlHeightReport(event.data, event.source, iframeWindow);
      if (heightReport !== null) {
        setHeight(heightReport.height);
        setHeightTruncated(heightReport.truncated);
        return;
      }
      const navHref = parseInlineHtmlNavMessage(event.data, event.source, iframeWindow);
      if (navHref) {
        const sessionId = parseIdbotsSessionUri(navHref);
        if (sessionId) {
          dispatchViewSession(sessionId);
        } else {
          console.warn('Unsupported idbots:// link:', navHref);
        }
      }
    };
    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [status, filePath]);

  const srcDoc = useMemo(
    () => (status === 'ready' ? buildInlineHtmlSrcDoc(html, filePath) : ''),
    [status, html, filePath],
  );

  const closeMenu = useCallback(() => {
    setMenuPosition(null);
  }, []);

  useEffect(() => {
    if (!menuPosition) return;
    const handleMouseDownOutside = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        closeMenu();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu();
      }
    };
    document.addEventListener('mousedown', handleMouseDownOutside);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', closeMenu);
    return () => {
      document.removeEventListener('mousedown', handleMouseDownOutside);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', closeMenu);
    };
  }, [menuPosition, closeMenu]);

  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const padding = 8;
    const x = Math.min(Math.max(padding, event.clientX), window.innerWidth - MENU_WIDTH - padding);
    const y = Math.min(Math.max(padding, event.clientY), window.innerHeight - 6 * MENU_ITEM_HEIGHT - padding);
    setMenuPosition({ x, y });
  }, []);

  const openInSidePanel = useCallback((event: React.MouseEvent) => {
    closeMenu();
    onOpenInSidePanel?.(filePath, event);
  }, [closeMenu, filePath, onOpenInSidePanel]);

  // Truncation footer action: prefer the side panel (full-height scrollable
  // view); without that callback, hand the file to the OS default app.
  const openFullReport = useCallback((event: React.MouseEvent) => {
    if (onOpenInSidePanel) {
      onOpenInSidePanel(filePath, event);
      return;
    }
    void (async () => {
      try {
        const result = await window.electron.shell.openPath(filePath);
        if (!result?.success) {
          showToast(i18nService.t('openFileFailed'));
        }
      } catch (error) {
        console.error('Failed to open file:', filePath, error);
        showToast(i18nService.t('openFileFailed'));
      }
    })();
  }, [filePath, onOpenInSidePanel]);

  const toggleView = useCallback(() => {
    closeMenu();
    setView((current) => (current === 'render' ? 'source' : 'render'));
  }, [closeMenu]);

  const exportImage = useCallback(() => {
    closeMenu();
    void (async () => {
      try {
        const result = await window.electron.cowork.exportHtmlReportImage({
          filePath,
          width: iframeRef.current?.clientWidth || 900,
          suggestedName: displayName || filePath,
        });
        if (result?.success && !result.canceled && result.path) {
          showToast(i18nService.t('htmlReportImageSaved'));
        } else if (result && result.success === false) {
          showToast(i18nService.t('htmlReportExportFailed'));
        }
      } catch (error) {
        console.error('Failed to export HTML report image:', filePath, error);
        showToast(i18nService.t('htmlReportExportFailed'));
      }
    })();
  }, [closeMenu, displayName, filePath]);

  const copyPath = useCallback(() => {
    closeMenu();
    void (async () => {
      try {
        await navigator.clipboard.writeText(filePath);
        setCopiedPath(true);
        if (copiedTimerRef.current != null) {
          window.clearTimeout(copiedTimerRef.current);
        }
        copiedTimerRef.current = window.setTimeout(() => setCopiedPath(false), 1500);
      } catch (error) {
        console.error('Failed to copy path:', filePath, error);
        showToast(i18nService.t('fileCopyFailed'));
      }
    })();
  }, [closeMenu, filePath]);

  const revealInFolder = useCallback(() => {
    closeMenu();
    void (async () => {
      try {
        const result = await window.electron.shell.showItemInFolder(filePath);
        if (!result?.success) {
          console.error('Failed to reveal file:', filePath, result?.error);
        }
      } catch (error) {
        console.error('Failed to reveal file:', filePath, error);
      }
    })();
  }, [closeMenu, filePath]);

  const openWithDefault = useCallback(() => {
    closeMenu();
    void (async () => {
      try {
        const result = await window.electron.shell.openPath(filePath);
        if (!result?.success) {
          showToast(i18nService.t('openFileFailed'));
        }
      } catch (error) {
        console.error('Failed to open file:', filePath, error);
        showToast(i18nService.t('openFileFailed'));
      }
    })();
  }, [closeMenu, filePath]);

  // Read failure (missing / not a file / too large / binary) degrades to the
  // previous report card — the message never shows a broken frame.
  if (status === 'fallback') {
    return (
      <LocalFileLink
        filePath={filePath}
        wrapperClassName="block w-full"
        className="group my-1 flex w-full items-center gap-3 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface px-3.5 py-2.5 shadow-subtle transition-colors hover:border-claude-accent/60 dark:hover:border-claude-accent/60 cursor-pointer no-underline"
        href={buildLocalFileUrl(filePath)}
        title={filePath}
        showTypeIcon={false}
        onOpen={onOpenInSidePanel
          ? (path, event) => { onOpenInSidePanel(path, event); }
          : undefined}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-claude-accent/10">
          <DocumentChartBarIcon className="h-5 w-5 text-claude-accent" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium dark:text-claude-darkText text-claude-text">
            {displayName}
          </span>
          <span className="mt-0.5 block text-[11px] leading-4 dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('htmlReportHint')}
          </span>
        </span>
        <ArrowTopRightOnSquareIcon className="h-4 w-4 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary transition-colors group-hover:text-claude-accent" />
      </LocalFileLink>
    );
  }

  const menuItemClass = 'w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover';

  return (
    <div
      className="group relative my-1 w-full overflow-hidden rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-subtle"
      onContextMenu={handleContextMenu}
      data-inline-html-report={filePath}
    >
      <div
        className={`absolute inset-x-0 top-0 z-10 flex h-9 items-center gap-2 border-b px-3 backdrop-blur-sm transition-opacity duration-150 dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/90 bg-claude-surface/90 ${
          menuPosition
            ? 'pointer-events-auto opacity-100'
            : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100'
        }`}
      >
        <DocumentChartBarIcon className="h-4 w-4 shrink-0 text-claude-accent" />
        <span
          className="min-w-0 flex-1 truncate text-xs font-medium text-claude-accent"
          title={filePath}
        >
          {displayName || filePath}
        </span>
        <span className="shrink-0 rounded bg-claude-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-claude-accent">
          {i18nService.t('htmlReportHint')}
        </span>
        {onOpenInSidePanel && (
          <button
            type="button"
            onClick={openInSidePanel}
            className="h-6 w-6 inline-flex shrink-0 items-center justify-center rounded-md dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            aria-label={i18nService.t('htmlReportOpenInPanel')}
            title={i18nService.t('htmlReportOpenInPanel')}
          >
            <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={toggleView}
          className="h-6 w-6 inline-flex shrink-0 items-center justify-center rounded-md dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          aria-label={view === 'render' ? i18nService.t('htmlReportViewSource') : i18nService.t('htmlReportViewRendered')}
          title={view === 'render' ? i18nService.t('htmlReportViewSource') : i18nService.t('htmlReportViewRendered')}
        >
          {view === 'render' ? <CodeBracketIcon className="h-3.5 w-3.5" /> : <EyeIcon className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={exportImage}
          className="h-6 w-6 inline-flex shrink-0 items-center justify-center rounded-md dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          aria-label={i18nService.t('htmlReportDownloadImage')}
          title={i18nService.t('htmlReportDownloadImage')}
        >
          <ArrowDownTrayIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {status === 'loading' ? (
        <div className="px-3 py-6 text-center text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('htmlReportLoading')}
        </div>
      ) : view === 'source' ? (
        <div className="max-h-[480px] overflow-auto">
          <SyntaxHighlighter
            language="markup"
            style={oneDark}
            customStyle={SOURCE_VIEW_STYLE}
            showLineNumbers={false}
          >
            {html}
          </SyntaxHighlighter>
        </div>
      ) : (
        // Sandboxed like the MarkdownViewerPanel preview (allow-scripts, opaque
        // origin). scrolling="no" + content-height + overflow:hidden keep the
        // report inside the frame — the frame itself must never scroll; the
        // ResizeObserver reporter keeps the height glued to the content. Past
        // MAX_FRAME_HEIGHT the frame stops growing and the footer below tells
        // the user the preview is cut off instead of hiding the rest silently.
        <iframe
          ref={iframeRef}
          title={displayName || filePath}
          sandbox="allow-scripts"
          scrolling="no"
          srcDoc={srcDoc}
          className="block w-full border-0 bg-white"
          style={{ height: `${height}px`, overflow: 'hidden' }}
        />
      )}

      {status === 'ready' && view === 'render' && heightTruncated && (
        <div className="flex items-center justify-between gap-2 border-t px-3 py-2 dark:border-claude-darkBorder border-claude-border">
          <span className="text-[11px] leading-4 dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('htmlReportTruncated')}
          </span>
          <button
            type="button"
            onClick={openFullReport}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-claude-accent transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
          >
            <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
            {i18nService.t('htmlReportOpenFullReport')}
          </button>
        </div>
      )}

      {menuPosition && (
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-50 min-w-[208px] rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-lg overflow-hidden"
          style={{ left: menuPosition.x, top: menuPosition.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {onOpenInSidePanel && (
            <button type="button" role="menuitem" onClick={openInSidePanel} className={menuItemClass}>
              <ArrowTopRightOnSquareIcon className="h-4 w-4 flex-shrink-0" />
              {i18nService.t('htmlReportOpenInPanel')}
            </button>
          )}
          <button type="button" role="menuitem" onClick={toggleView} className={menuItemClass}>
            {view === 'render' ? <CodeBracketIcon className="h-4 w-4 flex-shrink-0" /> : <EyeIcon className="h-4 w-4 flex-shrink-0" />}
            {view === 'render' ? i18nService.t('htmlReportViewSource') : i18nService.t('htmlReportViewRendered')}
          </button>
          <button type="button" role="menuitem" onClick={exportImage} className={menuItemClass}>
            <ArrowDownTrayIcon className="h-4 w-4 flex-shrink-0" />
            {i18nService.t('htmlReportDownloadImage')}
          </button>

          <div className="my-1 h-px dark:bg-claude-darkBorder bg-claude-border" />

          <button type="button" role="menuitem" onClick={copyPath} className={menuItemClass}>
            {copiedPath
              ? <CheckIcon className="h-4 w-4 flex-shrink-0 text-claude-accent" />
              : <DocumentDuplicateIcon className="h-4 w-4 flex-shrink-0" />}
            {copiedPath ? i18nService.t('fileCopied') : i18nService.t('fileCopyPath')}
          </button>
          <button type="button" role="menuitem" onClick={revealInFolder} className={menuItemClass}>
            <FolderOpenIcon className="h-4 w-4 flex-shrink-0" />
            {revealLabel}
          </button>
          <button type="button" role="menuitem" onClick={openWithDefault} className={menuItemClass}>
            <ComputerDesktopIcon className="h-4 w-4 flex-shrink-0" />
            {i18nService.t('htmlReportOpenWithDefault')}
          </button>
        </div>
      )}
    </div>
  );
};

export default InlineHtmlReportBlock;
