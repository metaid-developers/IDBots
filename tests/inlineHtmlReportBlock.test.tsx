// InlineHtmlReportBlock — assistant-mode HTML report rendered in place.
//
// Covers the block's testable surface without a DOM (this repo's renderer
// tests are server-rendered, no jsdom):
//   (a) the SSR-loading shell renders the header + placeholder and never an
//       empty iframe;
//   (b) buildInlineHtmlSrcDoc keeps the original document, injects the
//       file-directory <base href>, and installs the ResizeObserver
//       height-reporter before </body> (or at the end when there is no body);
//   (c) parseInlineHtmlHeightMessage enforces the per-instance contract —
//       marked payload, finite numeric height, source must be exactly this
//       block's iframe contentWindow — and clamps the result;
//   (d) source wiring pins: the export action goes through the new
//       cowork:htmlReport:exportImage IPC (preload + allowlist + main-process
//       hidden-window capture), the source view uses the prism 'markup'
//       grammar, and the right-click menu carries the file actions;
//   (e) the in-frame link bridge intercepts idbots:// anchor clicks, the nav
//       message contract mirrors the height contract, and session deep links
//       route through the shared sessionDeepLink helper both here and in
//       MarkdownContent (strict parse, case-insensitive scheme, no-ops for
//       foreign shapes).
//
// The live postMessage -> setHeight round-trip needs a DOM MessageEvent and
// is intentionally covered by (c)'s parser contract plus the wiring pin in
// tests/markdownContentHtmlReportCard.test.tsx.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import InlineHtmlReportBlock, {
  INLINE_HTML_HEIGHT_MESSAGE_KEY,
  buildInlineHtmlReporterScript,
  buildInlineHtmlSrcDoc,
  clampInlineHtmlHeight,
  parseInlineHtmlHeightMessage,
  parseInlineHtmlHeightReport,
  parseInlineHtmlNavMessage,
} from '../src/renderer/components/cowork/InlineHtmlReportBlock';
import { parseIdbotsSessionUri } from '../src/renderer/utils/sessionDeepLink';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const blockSource = fs.readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'cowork', 'InlineHtmlReportBlock.tsx'),
  'utf8',
);
const preloadSource = fs.readFileSync(
  path.join(projectRoot, 'src', 'main', 'preload.ts'),
  'utf8',
);
const allowlistSource = fs.readFileSync(
  path.join(projectRoot, 'src', 'main', 'gateway', 'allowlist.ts'),
  'utf8',
);
const mainSource = fs.readFileSync(
  path.join(projectRoot, 'src', 'main', 'main.ts'),
  'utf8',
);
const markdownContentSource = fs.readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'MarkdownContent.tsx'),
  'utf8',
);
const i18nSource = fs.readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'services', 'i18n.ts'),
  'utf8',
);

const REPORT_PATH = '/tmp/out/report.html';

const withWindowStub = (fn: () => void): void => {
  globalThis.window = { electron: { platform: 'darwin' } } as never;
  try {
    fn();
  } finally {
    delete (globalThis as Record<string, unknown>).window;
  }
};

test('the loading shell renders the title and placeholder without an iframe', () => {
  withWindowStub(() => {
    const markup = renderToStaticMarkup(
      <InlineHtmlReportBlock
        filePath={REPORT_PATH}
        displayName="Quarterly Research Report"
        onOpenInSidePanel={() => undefined}
      />,
    );
    assert.match(markup, /Quarterly Research Report/);
    assert.match(markup, /HTML report/);
    assert.match(markup, /Loading report/);
    assert.doesNotMatch(markup, /<iframe/);
  });
});

test('the toolbar is a hover-revealed overlay that takes no layout space', () => {
  withWindowStub(() => {
    const markup = renderToStaticMarkup(
      <InlineHtmlReportBlock
        filePath={REPORT_PATH}
        displayName="Quarterly Research Report"
        onOpenInSidePanel={() => undefined}
      />,
    );
    // Default state (no context menu open): the toolbar floats over the
    // report's top edge, hidden and click-transparent; hovering the block
    // reveals it. Absolutely positioned, so the report sits flush against
    // the surrounding chat text with no permanent chrome.
    assert.match(markup, /absolute inset-x-0 top-0/);
    assert.match(markup, /opacity-0/);
    assert.match(markup, /group-hover:opacity-100/);
    assert.match(markup, /pointer-events-none/);
    assert.match(markup, /group-hover:pointer-events-auto/);
    // The toolbar title reads in the accent color, same as its icon and badge.
    assert.match(markup, /truncate text-xs font-medium text-claude-accent/);
  });
  // An open right-click menu forces the toolbar visible even off-hover.
  assert.match(blockSource, /menuPosition\s*\?\s*'pointer-events-auto opacity-100'/);
});

test('srcdoc keeps the document and injects base href plus the reporter script before </body>', () => {
  const html = '<!doctype html><html><head><title>t</title></head><body><h1>Report</h1></body></html>';
  const srcDoc = buildInlineHtmlSrcDoc(html, REPORT_PATH);
  assert.ok(srcDoc.includes('<h1>Report</h1>'));
  assert.match(srcDoc, /<base href="file:\/\/\/tmp\/out\/">/);
  const reporterAt = srcDoc.indexOf('parent.postMessage');
  const bodyCloseAt = srcDoc.indexOf('</body>');
  assert.ok(reporterAt !== -1, 'reporter script must be present');
  assert.ok(bodyCloseAt !== -1 && reporterAt < bodyCloseAt, 'reporter must be injected before </body>');
  assert.match(srcDoc, new RegExp(INLINE_HTML_HEIGHT_MESSAGE_KEY));
});

test('srcdoc appends the reporter at the end when the document has no body close tag', () => {
  const html = '<html><body><p>fragment';
  const srcDoc = buildInlineHtmlSrcDoc(html, REPORT_PATH);
  assert.ok(srcDoc.startsWith('<base href="file:///tmp/out/">'));
  assert.ok(srcDoc.includes('<p>fragment'));
  const reporterAt = srcDoc.indexOf('parent.postMessage');
  assert.ok(reporterAt > srcDoc.indexOf('<p>fragment'), 'reporter appended after the content');
});

test('the reporter script observes resize, load and delayed settle reports', () => {
  const script = buildInlineHtmlReporterScript();
  assert.match(script, /ResizeObserver/);
  assert.match(script, /observe\(document\.documentElement\)/);
  assert.match(script, /window\.addEventListener\("load", reportHeight\)/);
  assert.match(script, /setTimeout\(reportHeight, 300\)/);
  assert.match(script, /setTimeout\(reportHeight, 1000\)/);
  assert.match(script, /parent\.postMessage\(\{ \[KEY\]: true, h: h \}, "\*"\)/);
  assert.ok(!script.includes('</script>'), 'the inline script must not break the srcdoc script tag');
});

test('the injected script bridges idbots:// link clicks to the parent', () => {
  const script = buildInlineHtmlReporterScript();
  // Capture-phase click listener resolving the enclosing anchor.
  assert.match(script, /document\.addEventListener\("click", function \(event\) \{/);
  assert.match(script, /node\.closest\("a\[href\]"\)/);
  // Only idbots:// hrefs are intercepted (case-insensitive scheme), the
  // in-frame navigation is suppressed, and the href is posted to the parent.
  assert.match(script, /\^idbots:\\\/\\\//);
  assert.match(script, /event\.preventDefault\(\)/);
  assert.match(script, /parent\.postMessage\(\{ \[KEY\]: true, nav: href \}, "\*"\)/);
});

test('nav messages are accepted only from this block iframe with a marked string href', () => {
  const iframeWindow = { name: 'frame-a' };
  const otherWindow = { name: 'frame-b' };
  const nav = 'idbots://session/abc-123_456';

  assert.equal(
    parseInlineHtmlNavMessage({ [INLINE_HTML_HEIGHT_MESSAGE_KEY]: true, nav }, iframeWindow, iframeWindow),
    nav,
  );
  // Another block's frame must not drive this block's navigation.
  assert.equal(
    parseInlineHtmlNavMessage({ [INLINE_HTML_HEIGHT_MESSAGE_KEY]: true, nav }, otherWindow, iframeWindow),
    null,
  );
  // Missing marker, wrong marker value, empty/non-string href: all ignored.
  assert.equal(parseInlineHtmlNavMessage({ nav }, iframeWindow, iframeWindow), null);
  assert.equal(
    parseInlineHtmlNavMessage({ [INLINE_HTML_HEIGHT_MESSAGE_KEY]: false, nav }, iframeWindow, iframeWindow),
    null,
  );
  assert.equal(
    parseInlineHtmlNavMessage({ [INLINE_HTML_HEIGHT_MESSAGE_KEY]: true, nav: '' }, iframeWindow, iframeWindow),
    null,
  );
  assert.equal(
    parseInlineHtmlNavMessage({ [INLINE_HTML_HEIGHT_MESSAGE_KEY]: true, nav: 42 }, iframeWindow, iframeWindow),
    null,
  );
});

test('session deep links parse strictly; other idbots:// or foreign shapes stay no-ops', () => {
  assert.equal(parseIdbotsSessionUri('idbots://session/abc-123_456'), 'abc-123_456');
  // URL schemes are case-insensitive (the daily report has emitted IDBOTS://).
  assert.equal(
    parseIdbotsSessionUri('IDBOTS://session/89125bf0-1e4b-45b0-b432-c93f5bea2e40'),
    '89125bf0-1e4b-45b0-b432-c93f5bea2e40',
  );
  // The bare IDBots://<id> form the app itself emits (copy-session-link menu,
  // cross-session refs, bot instructions telling bots to link conversations
  // to the owner this way) parses too — this is the shape that regressed into
  // the "Unsupported idbots:// link" console warning.
  assert.equal(
    parseIdbotsSessionUri('IDBots://2799a548-f81c-4cf0-a664-eaebe5236c1b'),
    '2799a548-f81c-4cf0-a664-eaebe5236c1b',
  );
  assert.equal(parseIdbotsSessionUri('idbots://other/abc'), null);
  assert.equal(parseIdbotsSessionUri('idbots://session'), null, 'bare "session" authority is the path keyword, not an id');
  assert.equal(parseIdbotsSessionUri('idbots://session/'), null);
  assert.equal(parseIdbotsSessionUri('idbots://session/abc/def'), null);
  assert.equal(parseIdbotsSessionUri('https://example.com/session/abc'), null);
  assert.equal(parseIdbotsSessionUri('javascript:alert(1)'), null);
});

test('the block routes in-frame nav clicks through the shared session deep-link path', () => {
  // Renderer wiring: the block and MarkdownContent share one parser +
  // dispatcher so report links behave exactly like markdown links.
  assert.match(blockSource, /import \{ dispatchViewSession, parseIdbotsSessionUri \} from '\.\.\/\.\.\/utils\/sessionDeepLink'/);
  assert.match(blockSource, /dispatchViewSession\(sessionId\)/);
  assert.match(markdownContentSource, /import \{ dispatchViewSession, parseIdbotsSessionUri \} from '\.\.\/utils\/sessionDeepLink'/);
  assert.match(markdownContentSource, /dispatchViewSession\(sessionId\)/);
});

test('height messages are accepted only from this block iframe and clamped', () => {
  const iframeWindow = { name: 'frame-a' };
  const otherWindow = { name: 'frame-b' };

  assert.equal(
    parseInlineHtmlHeightMessage({ [INLINE_HTML_HEIGHT_MESSAGE_KEY]: true, h: 520 }, iframeWindow, iframeWindow),
    520,
  );
  // Another block's frame (or any window) must not drive this height.
  assert.equal(
    parseInlineHtmlHeightMessage({ [INLINE_HTML_HEIGHT_MESSAGE_KEY]: true, h: 520 }, otherWindow, iframeWindow),
    null,
  );
  // Missing marker, wrong marker value, non-number height: all ignored.
  assert.equal(parseInlineHtmlHeightMessage({ h: 520 }, iframeWindow, iframeWindow), null);
  assert.equal(
    parseInlineHtmlHeightMessage({ [INLINE_HTML_HEIGHT_MESSAGE_KEY]: false, h: 520 }, iframeWindow, iframeWindow),
    null,
  );
  assert.equal(
    parseInlineHtmlHeightMessage({ [INLINE_HTML_HEIGHT_MESSAGE_KEY]: true, h: '520' }, iframeWindow, iframeWindow),
    null,
  );
  // Bounds: never below 40, never above 10000.
  assert.equal(clampInlineHtmlHeight(5), 40);
  assert.equal(clampInlineHtmlHeight(999999), 10000);
  assert.equal(
    parseInlineHtmlHeightMessage({ [INLINE_HTML_HEIGHT_MESSAGE_KEY]: true, h: 5 }, iframeWindow, iframeWindow),
    40,
  );
});

test('height reports flag truncation when the raw height tops the frame cap', () => {
  const iframeWindow = { name: 'frame-a' };
  const otherWindow = { name: 'frame-b' };

  // Over the cap: clamped to 10000 and flagged truncated.
  assert.deepEqual(
    parseInlineHtmlHeightReport({ [INLINE_HTML_HEIGHT_MESSAGE_KEY]: true, h: 42000 }, iframeWindow, iframeWindow),
    { height: 10000, truncated: true },
  );
  // Exactly at the cap is not truncated — the whole document fits.
  assert.deepEqual(
    parseInlineHtmlHeightReport({ [INLINE_HTML_HEIGHT_MESSAGE_KEY]: true, h: 10000 }, iframeWindow, iframeWindow),
    { height: 10000, truncated: false },
  );
  // Ordinary heights: not truncated.
  assert.deepEqual(
    parseInlineHtmlHeightReport({ [INLINE_HTML_HEIGHT_MESSAGE_KEY]: true, h: 520 }, iframeWindow, iframeWindow),
    { height: 520, truncated: false },
  );
  // Same per-instance contract as the height-only view: foreign sources and
  // malformed payloads are ignored.
  assert.equal(
    parseInlineHtmlHeightReport({ [INLINE_HTML_HEIGHT_MESSAGE_KEY]: true, h: 42000 }, otherWindow, iframeWindow),
    null,
  );
  assert.equal(parseInlineHtmlHeightReport({ h: 42000 }, iframeWindow, iframeWindow), null);
  assert.equal(
    parseInlineHtmlHeightReport({ [INLINE_HTML_HEIGHT_MESSAGE_KEY]: true, h: '42000' }, iframeWindow, iframeWindow),
    null,
  );
  // The height-only view stays a clamped number regardless of truncation.
  assert.equal(
    parseInlineHtmlHeightMessage({ [INLINE_HTML_HEIGHT_MESSAGE_KEY]: true, h: 42000 }, iframeWindow, iframeWindow),
    10000,
  );
});

test('a truncated report shows a footer notice with an open-full-report action', () => {
  // The block tracks truncation separately from the height and resets it when
  // the file reloads.
  assert.match(blockSource, /const \[heightTruncated, setHeightTruncated\] = useState\(false\)/);
  assert.match(blockSource, /setHeightTruncated\(false\)/);
  // Height reports drive both the frame height and the truncation flag through
  // the report parser, never the height-only view.
  assert.match(blockSource, /parseInlineHtmlHeightReport\(event\.data, event\.source, iframeWindow\)/);
  assert.match(blockSource, /setHeightTruncated\(heightReport\.truncated\)/);
  // The footer renders only for a truncated, ready, render-mode block, and
  // carries the notice plus the localized open-full-report button.
  assert.match(
    blockSource,
    /status === 'ready' && view === 'render' && heightTruncated[\s\S]*?i18nService\.t\('htmlReportTruncated'\)[\s\S]*?onClick=\{openFullReport\}[\s\S]*?i18nService\.t\('htmlReportOpenFullReport'\)/,
  );
  // The action prefers the side panel and falls back to the OS default app.
  assert.match(blockSource, /const openFullReport = useCallback\([\s\S]*?if \(onOpenInSidePanel\) \{\s*onOpenInSidePanel\(filePath, event\);\s*return;\s*\}/);
  assert.match(blockSource, /const openFullReport = useCallback\([\s\S]*?window\.electron\.shell\.openPath\(filePath\)/);
  // Both locales carry the new strings.
  assert.match(i18nSource, /htmlReportTruncated: '报告内容过长，预览已截断'/);
  assert.match(i18nSource, /htmlReportOpenFullReport: '打开完整报告'/);
  assert.match(i18nSource, /htmlReportTruncated: 'This report is very tall — the preview is truncated'/);
  assert.match(i18nSource, /htmlReportOpenFullReport: 'Open full report'/);
});

test('the export action goes through the hidden-window capture IPC end to end', () => {
  // Renderer bridge.
  assert.match(
    preloadSource,
    /exportHtmlReportImage: \(options: \{ filePath: string; width\?: number; suggestedName\?: string \}\) =>\s*ipcRenderer\.invoke\('cowork:htmlReport:exportImage', options\)/,
  );
  // Gateway allowlist (invoke channels are default-deny).
  assert.match(
    allowlistSource,
    /'cowork:htmlReport:exportImage': \{ tier: 'N', note: '[^']*' \}/,
  );
  // Main process: hidden sandboxed window, content-height sizing, PNG capture,
  // save dialog, and the window is always destroyed.
  assert.match(mainSource, /registerIpcHandler\('cowork:htmlReport:exportImage'/);
  assert.match(mainSource, /new BrowserWindow\(\{\s*show: false,[\s\S]*webPreferences: \{ sandbox: true, disableDialogs: true \}[\s\S]*\}\)/);
  assert.match(mainSource, /hiddenWindow\.setContentSize\(width, contentHeight\)/);
  assert.match(mainSource, /hiddenWindow\.webContents\.capturePage\(\)/);
  assert.match(mainSource, /dialog\.showSaveDialog/);
  assert.match(mainSource, /hiddenWindow\.destroy\(\)/);
  // Width is sanitized into the capture-safe range.
  assert.match(mainSource, /Math\.min\(2000, Math\.max\(320, Math\.round\(requestedWidth\)\)\)/);
});

test('the hidden-window load is bounded by a timeout and a render-process-gone watch', () => {
  // A wedged report (dead-loop script or never-settling resource) must surface
  // as a { success: false } result through a bounded load — never a hung IPC
  // invoke or a leaked hidden window.
  const loaderSource = mainSource.slice(
    mainSource.indexOf('HTML_REPORT_WINDOW_LOAD_TIMEOUT_MS'),
    mainSource.indexOf('loadHtmlReportWindow(hiddenWindow, filePath)'),
  );
  // Clearly named, ~15s budget.
  assert.match(mainSource, /const HTML_REPORT_WINDOW_LOAD_TIMEOUT_MS = 15_000;/);
  // The handler goes through the bounded loader instead of a raw loadFile.
  assert.match(mainSource, /await loadHtmlReportWindow\(hiddenWindow, filePath\)/);
  assert.doesNotMatch(mainSource, /await hiddenWindow\.loadFile\(filePath\)/);
  // Both failure signals are wired into the load race.
  assert.match(loaderSource, /setTimeout\([\s\S]*?HTML_REPORT_WINDOW_LOAD_TIMEOUT_MS\)/);
  assert.match(loaderSource, /webContents\.on\('render-process-gone', onRenderProcessGone\)/);
  assert.match(loaderSource, /window\.loadFile\(filePath\)/);
  // Whichever settles first rejects and tears the other signal down, so a
  // wedged load leaves no dangling listener or timer behind.
  assert.match(loaderSource, /clearTimeout\(timer\)/);
  assert.match(loaderSource, /removeListener\('render-process-gone', onRenderProcessGone\)/);
  assert.match(loaderSource, /reject\(error\)/);
  // The rejection lands in the handler's catch ({ success: false, error }) and
  // the finally block still destroys the hidden window.
  const handlerSource = mainSource.slice(mainSource.indexOf("registerIpcHandler('cowork:htmlReport:exportImage'"));
  assert.match(handlerSource, /catch \(error\) \{\s*return \{\s*success: false,/);
  assert.match(handlerSource, /finally \{\s*if \(hiddenWindow && !hiddenWindow\.isDestroyed\(\)\) \{\s*hiddenWindow\.destroy\(\);/);
});

test('the source view highlights as markup and the menu carries the file actions', () => {
  assert.match(blockSource, /SyntaxHighlighter/);
  assert.match(blockSource, /language="markup"/);
  assert.match(blockSource, /window\.electron\.shell\.showItemInFolder\(filePath\)/);
  assert.match(blockSource, /window\.electron\.shell\.openPath\(filePath\)/);
  assert.match(blockSource, /navigator\.clipboard\.writeText\(filePath\)/);
  assert.match(blockSource, /i18nService\.t\('htmlReportViewSource'\)/);
  assert.match(blockSource, /i18nService\.t\('htmlReportViewRendered'\)/);
  assert.match(blockSource, /i18nService\.t\('htmlReportDownloadImage'\)/);
  assert.match(blockSource, /i18nService\.t\('htmlReportOpenWithDefault'\)/);
  assert.match(blockSource, /i18nService\.t\('htmlReportOpenInPanel'\)/);
});
