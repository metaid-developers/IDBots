import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowTopRightOnSquareIcon, DocumentIcon, XMarkIcon } from '@heroicons/react/24/outline';
import MarkdownContent from '../MarkdownContent';
import { i18nService } from '../../services/i18n';
import { buildLocalFileDirBaseHref } from '../../services/localFileUrl';
import { formatBytes } from '../update/format';
import { inlineLocalHtmlImages } from './inlineHtmlImages';

interface MarkdownViewerPanelProps {
  /** Absolute path of the document to render (markdown or HTML). */
  filePath: string;
  onClose: () => void;
  /** Open another previewable document in this same panel (chained links). */
  onOpenFile: (filePath: string) => void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; error: string; size?: number; limit?: number }
  | { status: 'loaded'; content: string };

const getFileName = (filePath: string): string => {
  const segments = filePath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? filePath;
};

const getDirName = (filePath: string): string => {
  const match = filePath.match(/^(.*)[\\/][^\\/]*$/);
  return match?.[1] ?? filePath;
};

// Mirrors the TLD exclusion in MarkdownContent's isLikelyLocalFilePath so a
// bare `[x](example.com)` keeps rendering as a plain link, not a file path.
const COMMON_TLDS = new Set(['com', 'net', 'org', 'io', 'cn', 'co', 'ai', 'app', 'dev', 'gov', 'edu']);

// Extensions the panel renders as a live HTML preview instead of markdown.
const HTML_FILE_RE = /\.html?$/i;

/**
 * srcdoc documents have no URL of their own, so a relative asset reference
 * (img/css/js) inside a report would resolve nowhere. Point <base> at the
 * file's directory on a best-effort basis — assistant reports are single-file
 * by prompt design, so a still-broken relative path is acceptable. Exported
 * for the inline report block, which renders the same documents in the chat
 * message column.
 */
export const injectHtmlBaseHref = (html: string, filePath: string): string => {
  const baseHref = buildLocalFileDirBaseHref(getDirName(filePath));
  const baseTag = `<base href="${baseHref}">`;
  return /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (match) => `${match}${baseTag}`)
    : `${baseTag}${html}`;
};

/**
 * Resolve a markdown link target against the directory of the document shown
 * in the panel, so relative links (./other.md, ../docs/a.md, sub/b.md or a
 * bare sibling.md) inside the opened file stay navigable. Absolute paths,
 * file:// URLs and scheme-ful hrefs return null and keep their default
 * handling in MarkdownContent.
 */
const resolveRelativeToDocument = (documentPath: string, href: string): string | null => {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (/^file:\/\//i.test(trimmed)) return null;
  if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('/')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  // Keep %-escapes intact: MarkdownContent decodes the resolved value itself.
  const clean = trimmed.split('#')[0].split('?')[0].trim();
  if (!clean) return null;

  const isRelative = clean.startsWith('./') || clean.startsWith('../')
    || clean.includes('/') || clean.includes('\\');
  if (!isRelative) {
    const extMatch = clean.match(/\.([A-Za-z0-9]{1,6})$/);
    if (!extMatch || COMMON_TLDS.has(extMatch[1].toLowerCase())) return null;
  }

  const segments = `${getDirName(documentPath)}/${clean}`.split(/[\\/]/);
  const resolved: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      // Never climb above the filesystem root.
      if (resolved.length > 1 || (resolved.length === 1 && !/^[A-Za-z]:$/.test(resolved[0]))) {
        resolved.pop();
      }
      continue;
    }
    resolved.push(segment);
  }
  if (resolved.length === 0) return null;
  const prefix = documentPath.startsWith('/') ? '/' : '';
  return `${prefix}${resolved.join('/')}`;
};

const showToast = (message: string): void => {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

/**
 * Right-hand sidebar that renders a local document inside the app, so users
 * without a markdown-capable external editor (or to avoid leaving the chat)
 * can still read files the Agent produced. Markdown documents render with the
 * shared MarkdownContent component; .html/.htm files (the assistant's final
 * reports) render in a sandboxed iframe. Content is loaded through the main
 * process (`fs:readTextFile`, utf8, size-capped) either way.
 */
const MarkdownViewerPanel: React.FC<MarkdownViewerPanelProps> = ({ filePath, onClose, onOpenFile }) => {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const isHtmlFile = HTML_FILE_RE.test(filePath);
  const resolveLocalFilePath = useCallback(
    (href: string) => resolveRelativeToDocument(filePath, href),
    [filePath]
  );
  const handleOpenLocalFile = useCallback((path: string): boolean => {
    if (/\.(md|markdown|html?)$/i.test(path)) {
      onOpenFile(path);
      return true;
    }
    return false;
  }, [onOpenFile]);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const result = await window.electron.fs.readTextFile(filePath);
        if (cancelled) return;
        if (result?.success && typeof result.content === 'string') {
          // HTML reports: local <img> sources render blank under the app CSP
          // (no file: in img-src) — swap them for host-resolved data URIs.
          // Best effort; markdown documents are untouched.
          const content = isHtmlFile
            ? await inlineLocalHtmlImages(result.content, filePath)
            : result.content;
          if (cancelled) return;
          setState({ status: 'loaded', content });
        } else {
          setState({
            status: 'error',
            error: result?.error ?? 'unknown',
            size: result?.size,
            limit: result?.limit,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setState({ status: 'error', error: error instanceof Error ? error.message : String(error) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filePath, isHtmlFile]);

  // HTML reports render through srcdoc (Bot Browser precedent: the app CSP
  // already permits inline scripts/styles, and React attribute-escapes the
  // document). A <base> tag points relative assets at the file's directory.
  const htmlSrcDoc = useMemo(() => (
    state.status === 'loaded' && isHtmlFile ? injectHtmlBaseHref(state.content, filePath) : ''
  ), [state, isHtmlFile, filePath]);

  const openExternally = () => {
    void (async () => {
      try {
        const result = await window.electron.shell.openPath(filePath);
        if (!result?.success) {
          showToast(i18nService.t('openFileFailed'));
        }
      } catch {
        showToast(i18nService.t('openFileFailed'));
      }
    })();
  };

  const errorMessage = state.status === 'error'
    ? (() => {
        if (state.error === 'file_too_large' && typeof state.limit === 'number') {
          return i18nService.t('markdownViewerTooLarge').replace('{limit}', formatBytes(state.limit));
        }
        if (state.error === 'file_not_found' || state.error === 'not_a_file') {
          return i18nService.t('markdownViewerFileMissing');
        }
        return i18nService.t('markdownViewerLoadFailed');
      })()
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col dark:bg-claude-darkBg bg-claude-bg">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2 dark:border-claude-darkBorder border-claude-border">
        <DocumentIcon className="h-4 w-4 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
        <span
          className="min-w-0 flex-1 truncate text-xs font-medium dark:text-claude-darkText text-claude-text"
          title={filePath}
        >
          {getFileName(filePath)}
        </span>
        <button
          type="button"
          onClick={openExternally}
          className="h-6 w-6 inline-flex shrink-0 items-center justify-center rounded-md dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          aria-label={i18nService.t('markdownViewerOpenExternal')}
          title={i18nService.t('markdownViewerOpenExternal')}
        >
          <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="h-6 w-6 inline-flex shrink-0 items-center justify-center rounded-md dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          aria-label={i18nService.t('close')}
          title={i18nService.t('close')}
        >
          <XMarkIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {state.status === 'loading' ? (
        <div className="flex flex-1 items-center justify-center px-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('markdownViewerLoading')}
        </div>
      ) : state.status === 'error' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <p className="text-xs leading-5 dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {errorMessage}
          </p>
          <button
            type="button"
            onClick={openExternally}
            className="rounded-lg border px-2.5 py-1 text-xs dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          >
            {i18nService.t('markdownViewerOpenExternal')}
          </button>
        </div>
      ) : isHtmlFile ? (
        // Sandboxed preview: report scripts may run (charts, collapsibles)
        // but the document stays an opaque origin — no same-origin access, no
        // popups, no top navigation. The open-externally button above is the
        // escape hatch for anything the sandbox blocks.
        <iframe
          title={getFileName(filePath)}
          sandbox="allow-scripts"
          srcDoc={htmlSrcDoc}
          className="min-h-0 flex-1 border-0 bg-white"
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-2">
          <MarkdownContent
            content={state.content}
            compact
            resolveLocalFilePath={resolveLocalFilePath}
            onOpenLocalFile={handleOpenLocalFile}
          />
        </div>
      )}
    </div>
  );
};

export default MarkdownViewerPanel;
