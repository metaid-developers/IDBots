import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  parsePreviewFileUri,
  parsePreviewMetaAppUri,
  preparePreviewHtml,
} from '@openagentinternet/agent-browser-core';
import { buildBrowserPageDefinition } from '@openagentinternet/agent-browser-ui';

import MarkdownContent, {
  linkifyAgentInternetUris,
  normalizeLocalPreviewMarkdownUri,
} from '../src/renderer/components/MarkdownContent';
import {
  encodeLocalPreviewPath,
  localFilesystemPathFromArtifactRef,
  normalizeLocalPreviewUri,
  previewFileUriForPath,
  previewMetaappUriForPath,
} from '../src/main/libs/localPreviewUri';
import { buildLocalPreviewUri } from '../src/renderer/features/botBrowser/localPreviewUri';
import { browserUrisMatch } from '../src/main/shared/browserUriMatch';
import { installLegacyWebViewUrlCompatibility } from '../src/renderer/features/botBrowser/legacyWebViewUrl';
import { buildBrowserIframeBridgeScript } from '../src/renderer/features/botBrowser/browserIframeBridge';
import Module from 'node:module';
import { buildStudioDecisionReportHtml } from '../src/main/libs/studioDecisionReportHtml';
import type { StudioDecisionQueueItem } from '../src/main/studioDecisionQueueStore';

// Allow running under ELECTRON_SKIP_BINARY_DOWNLOAD=1 CI checkouts where
// node_modules/electron/path.txt is absent.
const origLoad = (Module as unknown as { _load: (...args: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function patchedLoad(
  request: unknown,
  ...rest: unknown[]
) {
  if (request === 'electron') {
    try {
      return origLoad.call(this, request, ...rest);
    } catch {
      return {
        app: { getPath: () => os.tmpdir(), isPackaged: false },
        ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
        BrowserWindow: { getAllWindows: () => [] },
      };
    }
  }
  return origLoad.call(this, request, ...rest);
};

function tolerantRm(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup for Windows CI file-handle safety.
  }
}

test('core URI parsers handle triple-slash, spaces, CJK, parens, %, #, and ? idempotently', () => {
  const reportedStyle = parsePreviewFileUri(
    'preview-file:///Users/longge666/Desktop/Meta%20Project/立项报告 (1).md',
  );
  assert.equal(reportedStyle.host, 'localhost');
  assert.equal(reportedStyle.path, '/Users/longge666/Desktop/Meta Project/立项报告 (1).md');
  assert.equal(parsePreviewFileUri(reportedStyle.normalizedUri).path, reportedStyle.path);
  assert.equal(parsePreviewFileUri(reportedStyle.normalizedUri).normalizedUri, reportedStyle.normalizedUri);

  // Literal % (encoded %25 and raw unencoded % and truncated trailing %)
  const pctEncoded = parsePreviewFileUri('preview-file://localhost/Users/a/100%25完成.md');
  assert.equal(pctEncoded.path, '/Users/a/100%完成.md');
  assert.equal(parsePreviewFileUri(pctEncoded.normalizedUri).path, '/Users/a/100%完成.md');

  const pctRaw = parsePreviewFileUri('preview-file:///Users/a/100%完成.md');
  assert.equal(pctRaw.path, '/Users/a/100%完成.md');

  const pctTruncated = parsePreviewFileUri('preview-file:///Users/longge666/Desktop/Meta%');
  assert.equal(pctTruncated.path, '/Users/longge666/Desktop/Meta%');

  // Literal # and ? in filenames (encoded and raw)
  const hashQEncoded = parsePreviewFileUri('preview-file://localhost/Users/a/方案%231%3Fv2.md');
  assert.equal(hashQEncoded.path, '/Users/a/方案#1?v2.md');
  assert.equal(parsePreviewFileUri(hashQEncoded.normalizedUri).path, '/Users/a/方案#1?v2.md');

  const hashRaw = parsePreviewFileUri('preview-file:///Users/a/方案#1.md');
  assert.equal(hashRaw.path, '/Users/a/方案#1.md');

  // preview-metaapp triple-slash + Windows backslashes
  const metaTriple = parsePreviewMetaAppUri(
    'preview-metaapp:///Users/longge666/Desktop/Meta Project/index.html',
  );
  assert.equal(metaTriple.host, 'localhost');
  assert.equal(metaTriple.path, '/Users/longge666/Desktop/Meta Project/index.html');
  assert.equal(parsePreviewMetaAppUri(metaTriple.normalizedUri).path, metaTriple.path);

  const winUri = parsePreviewFileUri('preview-file:///C:\\Users\\longge666\\Desktop\\Meta Project\\报告.md');
  assert.equal(winUri.path, '/C:/Users/longge666/Desktop/Meta Project/报告.md');

  // Security boundaries stay intact
  assert.throws(() => parsePreviewFileUri('preview-file://evil.com/etc/passwd'), /only supports localhost/);
  assert.throws(() => parsePreviewFileUri('preview-file://user@localhost/etc/passwd'), /userinfo/);
  assert.throws(() => parsePreviewMetaAppUri('preview-metaapp://user@localhost/a.html'), /userinfo/);
});

test('host service + local preview server resolve special-char files end-to-end, including preview-metaapp markdown fallback', async () => {
  const { createBotBrowserMetaAppCacheService } = await import('../src/main/services/botBrowserMetaAppCacheService');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-uri-special-'));
  const cacheService = createBotBrowserMetaAppCacheService({
    cacheRoot: path.join(tmpRoot, 'cache'),
    resolveMetafileContentBaseUrl: () => 'http://127.0.0.1:9',
  });

  try {
    const specialDir = path.join(tmpRoot, 'Meta Project (2026)');
    fs.mkdirSync(specialDir, { recursive: true });

    const mdSpecialPath = path.join(specialDir, '100%完成 #1 (终版).md');
    fs.writeFileSync(mdSpecialPath, '# 特殊字符验收通过\n\n正文内容正常渲染。', 'utf8');

    const htmlSpecialPath = path.join(specialDir, '汇报详情 (A).html');
    fs.writeFileSync(
      htmlSpecialPath,
      '<!doctype html><html><head><meta charset="utf-8"><title>OK</title></head><body><h1>Studio HTML</h1></body></html>',
      'utf8',
    );

    const pdfPath = path.join(specialDir, 'paper (1).pdf');
    fs.writeFileSync(pdfPath, '%PDF-1.4\n', 'utf8');

    const { createBotBrowserHostService } = await import('../src/main/services/botBrowserHostService');
    const host = createBotBrowserHostService({
      createLocalPreviewSession: (opts) => cacheService.createLocalPreviewSession(opts),
    });

    // 1. Triple-slash + mixed %20 / raw space / CJK / parens / raw % / raw #
    const tripleRawUri = `preview-file:///${specialDir.replace(/^\//, '').replace(' ', '%20')}/100%完成 #1 (终版).md`;
    const res1 = await host.resolveResource({ uri: tripleRawUri });
    assert.equal(res1.ok, true, `expected ok for ${tripleRawUri}, got ${JSON.stringify(res1)}`);
    if (res1.ok) {
      assert.equal(res1.data.renderer.type, 'file-viewer');
      const viewerResp = await fetch(res1.data.renderer.url!);
      assert.equal(viewerResp.status, 200);
      const viewerHtml = await viewerResp.text();
      assert.match(viewerHtml, /特殊字符验收通过/);
    }

    // 2. Properly encoded URI via previewFileUriForPath (includes %25, %23, %28, %29)
    const encodedMdUri = previewFileUriForPath(mdSpecialPath);
    const res2 = await host.resolveResource({ uri: encodedMdUri });
    assert.equal(res2.ok, true);
    if (res2.ok) {
      assert.equal(res2.data.renderer.type, 'file-viewer');
    }

    // 3. Truncated trailing % returns structured browser_resolve_failed ("Local path not found") instead of throwing URIError
    const resTrunc = await host.resolveResource({ uri: 'preview-file:///Users/longge666/Desktop/Meta%' });
    assert.equal(resTrunc.ok, false);
    if (!resTrunc.ok) {
      assert.equal(resTrunc.code, 'browser_resolve_failed');
      assert.match(resTrunc.message, /Local path not found/);
    }

    // 4. TwinBot emits preview-metaapp:// on a .md deliverable -> renders in file-viewer instead of unsupported!
    const wrongSchemeMdUri = previewMetaappUriForPath(mdSpecialPath);
    const resMdViaMetaApp = await host.resolveResource({ uri: wrongSchemeMdUri });
    assert.equal(resMdViaMetaApp.ok, true);
    if (resMdViaMetaApp.ok) {
      assert.equal(resMdViaMetaApp.data.renderer.type, 'file-viewer');
      assert.match(resMdViaMetaApp.data.renderer.url ?? '', /\?abc-viewer=1$/);
    }

    // 5. HTML with spaces & parens via triple-slash preview-metaapp:///
    const tripleHtmlUri = `preview-metaapp:///${htmlSpecialPath.replace(/^\//, '')}`;
    const resHtml = await host.resolveResource({ uri: tripleHtmlUri });
    assert.equal(resHtml.ok, true);
    if (resHtml.ok) {
      assert.equal(resHtml.data.renderer.type, 'html-iframe');
      const htmlResp = await fetch(resHtml.data.renderer.url!);
      assert.equal(htmlResp.status, 200);
      assert.match(await htmlResp.text(), /Studio HTML/);
    }

    // 6. PDF under preview-metaapp:// still uses native 'pdf' renderer without ?abc-viewer=1
    const resPdf = await host.resolveResource({ uri: previewMetaappUriForPath(pdfPath) });
    assert.equal(resPdf.ok, true);
    if (resPdf.ok) {
      assert.equal(resPdf.data.renderer.type, 'pdf');
      assert.doesNotMatch(resPdf.data.renderer.url ?? '', /abc-viewer=1/);
    }
  } finally {
    await cacheService.stop();
    tolerantRm(tmpRoot);
  }
});

test('projected HTML internal-link bridge forwards preview-file/preview-metaapp only from local-preview tabs', () => {
  const prepared = preparePreviewHtml({
    contentType: 'text/html; charset=utf-8',
    body: Buffer.from(
      '<html><head></head><body><a href="preview-file:///Users/longge666/Desktop/Meta Project/报告 (1).md">Open</a></body></html>',
      'utf8',
    ),
  });
  assert.match(prepared, /preview-file\|preview-metaapp\|file/);

  const pageDef = buildBrowserPageDefinition() as unknown as Record<string, unknown>;
  const scriptSrc = Object.values(pageDef).find(
    (v): v is string => typeof v === 'string' && v.includes('function isLocalPreviewNavigateHref('),
  );
  assert.ok(scriptSrc, 'expected client script containing isLocalPreviewNavigateHref');

  // Extract and evaluate the exact gate functions from app.js
  const startIdx = scriptSrc.indexOf('function isBrowserInternalHref(value)');
  const endIdx = scriptSrc.indexOf('function currentBrowserHtmlFrameWindow()');
  assert.ok(startIdx !== -1 && endIdx > startIdx);
  const snippet = scriptSrc.slice(startIdx, endIdx);

  const makeHarness = (activeResolver: string, activeUri: string) => {
    const fn = new Function(
      'activeResolver',
      'activeUri',
      `
      function textValue(v) { return String(v == null ? '' : v).trim(); }
      function activeTab() {
        return { uri: activeUri, current: { uri: activeUri, normalizedUri: activeUri, source: { resolver: activeResolver } } };
      }
      ${snippet}
      return {
        isBrowserInternalHref,
        isLocalPreviewNavigateHref,
        activeResourceIsLocalPreview,
        canNavigate: function(uri) {
          return isBrowserInternalHref(uri) || (activeResourceIsLocalPreview() && isLocalPreviewNavigateHref(uri));
        }
      };
    `,
    );
    return fn(activeResolver, activeUri) as {
      isBrowserInternalHref: (u: string) => boolean;
      canNavigate: (u: string) => boolean;
    };
  };

  // Local Studio preview tab CAN navigate to preview-file://, preview-metaapp://, file:// (with spaces/CJK/parens) + pin://
  const localTab = makeHarness('preview-metaapp', 'preview-metaapp://localhost/tmp/briefing.html');
  assert.equal(
    localTab.canNavigate('preview-file:///Users/longge666/Desktop/Meta Project/立项报告 (1).md'),
    true,
  );
  assert.equal(
    localTab.canNavigate('preview-metaapp://localhost/Users/longge666/Desktop/App/index.html'),
    true,
  );
  assert.equal(localTab.canNavigate('pin://abc123i0'), true);
  assert.equal(localTab.canNavigate('javascript:alert(1)'), false);
  assert.equal(localTab.canNavigate('preview-file://'), false);

  // Untrusted on-chain MetaApp tab CANNOT navigate to local preview-file://, preview-metaapp://, or file://
  const chainTab = makeHarness('metaapp', 'metaapp://84b78cchi0');
  assert.equal(chainTab.canNavigate('preview-file://localhost/etc/passwd'), false);
  assert.equal(chainTab.canNavigate('preview-metaapp://localhost/tmp/app'), false);
  assert.equal(chainTab.canNavigate('file:///etc/passwd'), false);
  assert.equal(chainTab.canNavigate('pin://84b78cchi0'), true);
  // pinInspector uses isBrowserInternalHref directly and must NEVER linkify local schemes
  assert.equal(chainTab.isBrowserInternalHref('preview-file://localhost/etc/passwd'), false);
});

test('MarkdownContent renders clickable links for special-char, triple-slash, mixed-encoded, backticked, and bare CJK URIs', () => {
  // 1. Explicit Markdown link with triple-slash + raw spaces + CJK + parens + #
  const mdExplicit = renderToStaticMarkup(
    React.createElement(MarkdownContent, {
      content: '[查看立项报告](preview-file:///Users/longge666/Desktop/Meta Project/方案#1 (终版).md)',
    }),
  );
  assert.equal((mdExplicit.match(/<a /g) || []).length, 1);
  assert.match(
    mdExplicit,
    /href="preview-file:\/\/localhost\/Users\/longge666\/Desktop\/Meta%20Project\/%E6%96%B9%E6%A1%88%231%20%28%E7%BB%88%E7%89%88%29\.md"/,
  );

  // 2. Mixed %20 + raw space does NOT double-encode %20 into %2520
  assert.equal(
    normalizeLocalPreviewMarkdownUri(
      'preview-file:///Users/longge666/Desktop/Meta%20Project/子目录 B/报告.md',
    ),
    'preview-file://localhost/Users/longge666/Desktop/Meta%20Project/%E5%AD%90%E7%9B%AE%E5%BD%95%20B/%E6%8A%A5%E5%91%8A.md',
  );

  // 3. Unbalanced '(' inside filename in Markdown link still renders as <a>
  const mdUnbalanced = renderToStaticMarkup(
    React.createElement(MarkdownContent, {
      content: '[草稿](preview-file://localhost/Users/longge666/Desktop/报告 (草稿.md)',
    }),
  );
  assert.equal((mdUnbalanced.match(/<a /g) || []).length, 1);
  assert.match(mdUnbalanced, /%28%E8%8D%89%E7%A8%BF\.md"/);

  // 4. Inline backticks wrapping a local preview path with spaces
  const mdBacktick = renderToStaticMarkup(
    React.createElement(MarkdownContent, {
      content: '请查看 `preview-file:///Users/longge666/Desktop/Meta Project/立项报告 (1).md` 了解详情',
    }),
  );
  assert.equal((mdBacktick.match(/<a /g) || []).length, 1);
  assert.match(
    mdBacktick,
    /href="preview-file:\/\/localhost\/Users\/longge666\/Desktop\/Meta%20Project\/%E7%AB%8B%E9%A1%B9%E6%8A%A5%E5%91%8A%20%281%29\.md"/,
  );

  // 5. Bare URI in Chinese prose without spaces stops cleanly before '，' while keeping balanced '（终版）(1)'
  const linkedProse = linkifyAgentInternetUris(
    '请打开 preview-file:///Users/longge666/Desktop/Meta%20Project/立项报告（终版）(1).md，查看详情。',
  );
  assert.match(linkedProse, /\]\(preview-file:\/\/localhost\/Users\/longge666\/Desktop\/Meta%20Project\/[^)]+%281%29\.md\)，查看详情。/);

  // 6. Truncated 'Meta%' in prose or link does not crash and produces valid %25 URI
  const mdTruncated = renderToStaticMarkup(
    React.createElement(MarkdownContent, {
      content: '结果链接：preview-file:///Users/longge666/Desktop/Meta%',
    }),
  );
  assert.equal((mdTruncated.match(/<a /g) || []).length, 1);
  assert.match(mdTruncated, /href="preview-file:\/\/localhost\/Users\/longge666\/Desktop\/Meta%25"/);
});

test('Studio Chief-of-Staff prompts, Decision HTML, URI matchers, and legacy WebView polyfill handle special-char URIs', async () => {
  const { buildProactiveBriefingPrompt } = await import('../src/main/services/studioChiefOfStaffService');
  // 1. encodeLocalPreviewPath / buildLocalPreviewUri encode parentheses for CommonMark safety
  assert.equal(
    encodeLocalPreviewPath('/Users/alice/Meta Project/report (1).html'),
    '/Users/alice/Meta%20Project/report%20%281%29.html',
  );
  assert.equal(
    buildLocalPreviewUri('/Users/alice/Meta Project/note (1).md'),
    'preview-file://localhost/Users/alice/Meta%20Project/note%20%281%29.md',
  );

  // 2. localFilesystemPathFromArtifactRef handles paths, preview URIs, file URIs, and rejects chain URIs
  assert.equal(
    localFilesystemPathFromArtifactRef('preview-file:///Users/longge666/Desktop/Meta%20Project/%E6%8A%A5%E5%91%8A.md', 'darwin'),
    '/Users/longge666/Desktop/Meta Project/报告.md',
  );
  assert.equal(
    localFilesystemPathFromArtifactRef('preview-metaapp://localhost/C:/Users/Alice%20Smith/stage.html', 'win32'),
    'C:/Users/Alice Smith/stage.html',
  );
  assert.equal(localFilesystemPathFromArtifactRef('pin://abc123i0', 'darwin'), null);
  assert.equal(localFilesystemPathFromArtifactRef('metaapp://abc123i0', 'darwin'), null);

  // 3. buildProactiveBriefingPrompt encodes spaces & parens and normalizes URI-typed reportHtmlPath (no double slash!)
  const queueItem: StudioDecisionQueueItem = {
    id: 'dq-1',
    dedupeKey: 'k1',
    twinMetabotId: 1,
    originStudioSessionId: 's1',
    longtermTaskId: 't1',
    longtermSubtaskId: 'st1',
    kind: 'acceptance',
    priority: 50,
    status: 'presenting',
    title: '验收报告',
    backgroundSummary: 'bg',
    progressSummary: 'done',
    question: '确认？',
    options: [{ id: 'A', label: '通过', recommended: true }],
    recommendation: 'A',
    nextStep: '归档',
    reportHtmlPath: 'preview-metaapp:///Users/longge666/Desktop/Meta Project/汇报 (1).html',
    evidence: [
      {
        kind: 'file',
        uri: 'preview-file:///Users/longge666/Desktop/Meta Project/正文 (1).md',
        note: '全文',
      },
    ],
    resolutionNote: null,
    createdAt: 1,
    updatedAt: 1,
    presentedAt: 1,
    resolvedAt: null,
  };
  const promptZh = buildProactiveBriefingPrompt(queueItem, 0, 'zh');
  assert.match(
    promptZh,
    /\[查看核验详情页\]\(preview-metaapp:\/\/localhost\/Users\/longge666\/Desktop\/Meta%20Project\/%E6%B1%87%E6%8A%A5%20%281%29\.html\)/,
  );
  assert.doesNotMatch(promptZh, /localhost\/\/Users/);
  assert.doesNotMatch(promptZh, /localhost\/preview-metaapp:/);

  const reportHtml = buildStudioDecisionReportHtml({ item: queueItem, language: 'zh' });
  assert.match(
    reportHtml,
    /href="preview-file:\/\/localhost\/Users\/longge666\/Desktop\/Meta%20Project\/%E6%AD%A3%E6%96%87%20%281%29\.md"/,
  );
  assert.equal(
    normalizeLocalPreviewUri('file:///Users/longge666/Desktop/Meta Project/a.md'),
    'preview-file://localhost/Users/longge666/Desktop/Meta%20Project/a.md',
  );

  // 4. browserUrisMatch handles triple-slash vs localhost and encoded vs decoded
  assert.equal(
    browserUrisMatch(
      'preview-file:///Users/longge666/Desktop/Meta%20Project/%E6%8A%A5%E5%91%8A.md',
      'preview-file://localhost/Users/longge666/Desktop/Meta Project/报告.md',
    ),
    true,
  );

  // 5. Legacy WebView URL polyfill handles triple-slash empty authority
  class FakeLegacyURL {
    protocol = '';
    host = '';
    hostname = '';
    pathname = '';
    search = '';
    hash = '';
    port = '';
    username = '';
    password = '';
    href = '';
    constructor(input: string) {
      const m = String(input).match(/^([a-z0-9+.-]+:)(.*)$/i);
      this.protocol = m ? m[1].toLowerCase() : '';
      this.pathname = m ? m[2] : String(input);
      this.href = String(input);
    }
  }
  const fakeScope = { URL: FakeLegacyURL as unknown as typeof URL };
  installLegacyWebViewUrlCompatibility(fakeScope);
  const polyParsed = new fakeScope.URL('preview-file:///Users/longge666/Desktop/Meta%20Project/a.md');
  assert.equal(polyParsed.hostname, '');
  assert.equal(polyParsed.pathname, '/Users/longge666/Desktop/Meta%20Project/a.md');

  // 6. browserIframeBridge localPreviewPath accepts triple-slash and still rejects ..
  const bridgeScript = buildBrowserIframeBridgeScript();
  assert.match(bridgeScript, /value\.indexOf\('preview-metaapp:\/\/\/'\) === 0/);
});
