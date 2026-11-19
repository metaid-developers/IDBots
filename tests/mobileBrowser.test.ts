import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import JSZip from 'jszip';
import { parseMapUri, parsePinUri, parsePreviewFileUri } from '@openagentinternet/agent-browser-core';
import { createMobileBrowserHost } from '../src/mobile/app/browser/mobileBrowserHost.ts';
import { clearLocalFileUrlCache } from '../src/renderer/services/localFileUrl.ts';
import {
  buildLegacyWebViewUrlCompatibilityScript,
  injectLegacyWebViewUrlCompatibilityHtml,
  installLegacyWebViewUrlCompatibility,
} from '../src/renderer/features/botBrowser/legacyWebViewUrl.ts';
import {
  buildMobileMetaAppResourceScripts,
  createMobileMetaAppPreviewSession,
  rewriteMobileMetaAppHtml,
  rewriteMobileMetaAppJavaScript,
  rewriteMobileMetaAppMarkdown,
} from '../src/mobile/app/browser/mobileMetaAppPreview.ts';

const previewInput = (contentReference: string, contentType = 'application/zip') => ({
  pinId: `${'a'.repeat(64)}i0`,
  contentReference,
  contentType,
  indexFile: 'index.html',
  protocol: {},
  pinRecord: {},
});
const previewPublisher = async (file: { name: string }): Promise<string> => `https://preview.test/${file.name}`;

test('MetaApp HTML resource rewriting preserves internal URIs and resolves package assets', () => {
  const urls = new Map([
    ['assets/app.js', 'https://preview.test/app.js'],
    ['assets/cover.png', 'https://preview.test/cover.png'],
  ]);
  const html = rewriteMobileMetaAppHtml(
    '<script src="./assets/app.js"></script><script type="module" src="./assets/app.js"></script><img srcset="assets/cover.png 2x"><a href="pin://abc">Open</a><a href="https://example.com">Web</a>',
    'index.html',
    urls,
  );
  assert.ok(html.includes('src="https://preview.test/app.js"'));
  assert.ok(html.includes('type="module" src="https://preview.test/app.js"'));
  assert.ok(html.includes('srcset="https://preview.test/cover.png 2x"'));
  assert.ok(html.includes('href="pin://abc"'));
  assert.ok(html.includes('href="https://example.com"'));
});

test('Markdown images resolve against the HTML document rather than the Markdown directory', () => {
  const markdown = rewriteMobileMetaAppMarkdown(
    '![Cover](assets/cover.png)<img src="/assets/other.png">',
    'index.html',
    new Map([
      ['assets/cover.png', '/files/opaque-cover-token'],
      ['assets/other.png', '/files/opaque-other-token'],
    ]),
  );
  assert.ok(markdown.includes('![Cover](/files/opaque-cover-token)'));
  assert.ok(markdown.includes('src="/files/opaque-other-token"'));
});

test('JavaScript rewrites modules, document fetches and dynamic resources without guessing signed URLs', () => {
  const source = rewriteMobileMetaAppJavaScript(
    'import { chapters } from "./content.js"; import "./particles.js"; const panel = import("./original.js"); fetch("../originals/01.md"); fetch(`originals/${chapter.source}`);',
    'js/app.js',
    new Map([
      ['js/content.js', 'https://preview.test/content.js'],
      ['js/particles.js', 'https://preview.test/particles.js'],
      ['js/original.js', 'https://preview.test/original.js'],
      ['originals/01.md', 'https://preview.test/01.md'],
    ]),
  );
  assert.ok(source.includes('from "https://metaapp.local/js/content.js"'));
  assert.ok(source.includes('import "https://metaapp.local/js/particles.js"'));
  assert.ok(source.includes('import("https://metaapp.local/js/original.js")'));
  assert.ok(source.includes('fetch(__idbotsMobileMetaAppResolveUrl("../originals/01.md", "index.html", false))'));
  assert.ok(source.includes('fetch(__idbotsMobileMetaAppResolveUrl(`originals/${chapter.source}`, "index.html", false))'));
  assert.ok(source.includes('globalThis.__idbotsMobileMetaAppResourcesV1'));
  const resourceScripts = buildMobileMetaAppResourceScripts(new Map([['js/content.js', 'data:text/javascript,export%20default%201']]));
  assert.ok(resourceScripts.includes('"https://metaapp.local/js/content.js":"data:text/javascript,export%20default%201"'));
});

test('single-file MetaApp previews inject the ABC bridge and inline small external scripts', async () => {
  const published: string[] = [];
  const session = createMobileMetaAppPreviewSession(async (url) => new Response(
    String(url).includes('cdn.example')
      ? 'globalThis.library = true;'
      : `<html><head><script src="https://cdn.example/lib.js"></script></head><body><img src="metafile://${'a'.repeat(64)}i0.png"><h1>Preview</h1></body></html>`,
    { status: 200, headers: { 'content-type': 'text/html' } },
  ), async (file) => {
    published.push(file.name);
    return previewPublisher(file);
  });
  try {
    const result = await session.createPreviewSession(previewInput('https://example.com/index.html', 'text/html'));
    assert.ok(result.localPreviewUrl.startsWith('https://preview.test/'));
    assert.ok(!result.localPreviewUrl.startsWith('blob:'));
    assert.ok(!published.some((name) => name.endsWith('external-0.js')));
  } finally {
    session.dispose();
  }
});

test('direct content is preferred and accelerate is only a fallback', async () => {
  const requested: string[] = [];
  const session = createMobileMetaAppPreviewSession(async (url) => {
    requested.push(String(url));
    if (requested.length === 1) throw new TypeError('CORS redirect failed');
    return new Response('<html><body>Fallback works</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  }, previewPublisher);
  try {
    await session.createPreviewSession(previewInput(`metafile://${'a'.repeat(64)}i0.zip`, 'text/html'));
    assert.equal(requested.length, 2);
    assert.ok(requested[0].includes('/files/content/'));
    assert.ok(requested[1].includes('/files/accelerate/content/'));
  } finally {
    session.dispose();
  }
});

test('ZIP MetaApp previews inline portable code and publish binary assets plus the HTML entry', async () => {
  const zip = new JSZip();
  zip.file('index.html', '<html><head><link href="assets/app.css" rel="stylesheet"></head><body><script type="module" src="assets/app.js"></script><h1>ZIP app</h1></body></html>');
  zip.file('assets/app.css', 'body { background: url("./cover.png"); }');
  zip.file('assets/app.js', 'console.log("running");');
  zip.file('assets/cover.png', new Uint8Array([137, 80, 78, 71]));
  const bytes = await zip.generateAsync({ type: 'arraybuffer' });
  const published: string[] = [];
  let entryHtml = '';
  const session = createMobileMetaAppPreviewSession(async () => new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'application/zip' },
  }), async (file) => {
    published.push(file.name);
    if (file.name.endsWith('index.html')) entryHtml = new TextDecoder().decode(file.data);
    return previewPublisher(file);
  });
  try {
    const result = await session.createPreviewSession(previewInput('https://example.com/app.zip'));
    assert.ok(result.localPreviewUrl.startsWith('https://preview.test/'));
    assert.ok(!published.some((name) => name.endsWith('assets-app.css')));
    assert.ok(!published.some((name) => name.endsWith('assets-app.js')));
    assert.ok(published.some((name) => name.endsWith('assets-cover.png')));
    assert.ok(published.some((name) => name.endsWith('index.html')));
    assert.ok(entryHtml.includes('type="importmap"'));
    assert.ok(entryHtml.includes('type="module" src="data:text/javascript'));
    assert.ok(entryHtml.includes('globalThis.__idbotsMobileMetaAppResourcesV1'));
  } finally {
    session.dispose();
  }
});

test('mobile Browser advertises read-only features and rejects trusted NFT actions', async () => {
  const host = globalThis as unknown as { window?: unknown };
  const previous = host.window;
  host.window = {
    electron: {
      metabot: { list: async () => ({ success: true, list: [] }) },
      userIdentity: { get: async () => ({ success: true, identity: null }) },
    },
  };
  try {
    const browser = createMobileBrowserHost();
    const runtime = await browser.handle({ url: '/api/browser/runtime' });
    assert.equal(runtime.status, 200);
    const runtimeData = (runtime.body as { data: { features: Record<string, boolean> } }).data;
    assert.equal(runtimeData.features.nftBuy, false);
    assert.equal(runtimeData.features.mrc721Buy, false);
    assert.equal(runtimeData.features.privateChat, false);
    const action = await browser.handle({
      url: '/api/browser/actions',
      method: 'POST',
      body: { kind: 'nft-buy', resourceUri: 'pin://example' },
    });
    assert.equal(action.body.ok, false);
    assert.equal((action.body as { code: string }).code, 'unsupported_method');
    browser.dispose();
  } finally {
    if (previous) host.window = previous;
    else delete host.window;
  }
});


test('mobile Browser resolves tenant HTML artifacts through a signed preview-file URL', async () => {
  const host = globalThis as unknown as { window?: unknown };
  const previous = host.window;
  host.window = {
    idbotsMobile: { isMobile: true },
    electron: {
      gateway: {
        fileSign: async ({ path, disposition }: { path: string; disposition: string }) => ({
          url: `/gateway/v1/files/${path.endsWith('.html') ? 'signed-html' : 'unexpected'}`,
          expiresAt: 0,
          size: 128,
          mime: disposition === 'inline' ? 'text/html' : 'application/octet-stream',
        }),
      },
      metabot: { list: async () => ({ success: true, list: [] }) },
      userIdentity: { get: async () => ({ success: true, identity: null }) },
    },
  };
  try {
    const browser = createMobileBrowserHost();
    const resolved = await browser.handle({
      url: `/api/browser/resolve?uri=${encodeURIComponent('preview-file://localhost/data/workspace/today-inspiration.html')}`,
    });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.ok, true);
    const data = resolved.body.data as {
      renderer: { type: string; url: string; contentType: string };
    };
    assert.equal(data.renderer.type, 'html-iframe');
    assert.equal(data.renderer.url, '/files/signed-html');
    assert.equal(data.renderer.contentType, 'text/html; charset=utf-8');
    browser.dispose();
  } finally {
    clearLocalFileUrlCache();
    if (previous) host.window = previous;
    else delete host.window;
  }
});


class LegacyWebViewURL extends URL {
  constructor(input: string | URL, base?: string | URL) {
    super(input, base);
    const match = String(input).match(/^(?:map|metaapp|metafile|metaid|pin|preview-file|preview-metaapp):\/\/(.*)$/i);
    if (!match) return;
    const remainder = match[1].split(/[?#]/, 1)[0];
    for (const [name, value] of Object.entries({
      host: '',
      hostname: '',
      password: '',
      pathname: `//${remainder}`,
      port: '',
      username: '',
    })) {
      Object.defineProperty(this, name, { configurable: true, value, writable: true });
    }
  }
}

test('legacy WebView URL compatibility restores MetaWeb URI parsing end to end', () => {
  const OriginalURL = globalThis.URL;
  const pinId = 'f26e03d04868fa86ec633577e6e8958785b872561d96bb84f0cc9d273ce162f0i0';
  try {
    globalThis.URL = LegacyWebViewURL;
    assert.equal(new URL(`pin://${pinId}`).hostname, '');
    installLegacyWebViewUrlCompatibility();
    assert.equal(parsePinUri(`pin://${pinId}`).pinId, pinId);
    assert.equal(parsePinUri(`pin://${pinId}?version=3`).historyIndex, 3);
    assert.equal(parseMapUri(`map://simplebuzz/pin/${pinId}`).pinId, pinId);
    assert.equal(parsePreviewFileUri('preview-file://localhost/data/report.html').path, '/data/report.html');
    assert.throws(() => parsePinUri(`pin://${pinId}/unexpected`), /path component/u);
    const parsed = new URL(`pin://user:password@${pinId}:99/path`);
    assert.equal(parsed.username, 'user');
    assert.equal(parsed.password, 'password');
    assert.equal(parsed.port, '99');
    assert.equal(parsed.pathname, '/path');
    assert.equal(new URL('https://example.com/a').hostname, 'example.com');
  } finally {
    globalThis.URL = OriginalURL;
  }
});

test('legacy WebView compatibility script is self-contained and injects before app scripts', () => {
  const sandbox = { URL: LegacyWebViewURL } as { URL: typeof URL };
  vm.createContext(sandbox);
  vm.runInContext(buildLegacyWebViewUrlCompatibilityScript(), sandbox);
  const pinId = `${'b'.repeat(64)}i0`;
  const parsed = vm.runInContext(`new URL('metaapp://${pinId}')`, sandbox) as URL;
  assert.equal(parsed.hostname, pinId);
  assert.equal(parsed.pathname, '');
  const html = injectLegacyWebViewUrlCompatibilityHtml('<html><head><script src="app.js"></script></head></html>');
  assert.ok(html.indexOf('__idbotsLegacyWebViewUrlCompatibility') < html.indexOf('src="app.js"'));
  assert.equal(injectLegacyWebViewUrlCompatibilityHtml(html), html);
});


test('dynamic document fetches execute against opaque resource maps from a nested JS directory', async () => {
  const runtime = globalThis as typeof globalThis & { __idbotsMobileMetaAppResourcesV1?: Map<string, string> };
  const previous = runtime.__idbotsMobileMetaAppResourcesV1;
  runtime.__idbotsMobileMetaAppResourcesV1 = new Map([
    ['originals/01.md', `data:text/markdown;charset=utf-8,${encodeURIComponent('# Chapter one')}`],
  ]);
  try {
    const source = rewriteMobileMetaAppJavaScript(
      'export async function load(chapter) { const response = await fetch(`originals/${chapter.source}`); return response.text(); }',
      'js/original.js',
      runtime.__idbotsMobileMetaAppResourcesV1,
    );
    const module = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`);
    assert.equal(await module.load({ source: '01.md' }), '# Chapter one');
  } finally {
    if (previous) runtime.__idbotsMobileMetaAppResourcesV1 = previous;
    else delete runtime.__idbotsMobileMetaAppResourcesV1;
  }
});
