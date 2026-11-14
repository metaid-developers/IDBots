import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { createMobileBrowserHost } from '../src/mobile/app/browser/mobileBrowserHost.ts';
import { clearLocalFileUrlCache } from '../src/renderer/services/localFileUrl.ts';
import {
  createMobileMetaAppPreviewSession,
  rewriteMobileMetaAppHtml,
  rewriteMobileMetaAppJavaScript,
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
    '<script src="./assets/app.js"></script><img srcset="assets/cover.png 2x"><a href="pin://abc">Open</a><a href="https://example.com">Web</a>',
    'index.html',
    urls,
  );
  assert.ok(html.includes('src="https://preview.test/app.js"'));
  assert.ok(html.includes('srcset="https://preview.test/cover.png 2x"'));
  assert.ok(html.includes('href="pin://abc"'));
  assert.ok(html.includes('href="https://example.com"'));
});

test('JavaScript module and fetch references resolve against the publishing package path', () => {
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
  assert.ok(source.includes('from "https://preview.test/content.js"'));
  assert.ok(source.includes('import "https://preview.test/particles.js"'));
  assert.ok(source.includes('import("https://preview.test/original.js")'));
  assert.ok(source.includes('fetch("https://preview.test/01.md")'));
  assert.ok(source.includes('fetch(`https://preview.test/${chapter.source}`)'));
});

test('single-file MetaApp previews inject the ABC bridge and localize external scripts', async () => {
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
    assert.ok(published.some((name) => name.endsWith('external-0.js')));
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

test('ZIP MetaApp previews publish HTML, CSS and JavaScript as HTTP resources', async () => {
  const zip = new JSZip();
  zip.file('index.html', '<html><head><link href="assets/app.css" rel="stylesheet"></head><body><script src="assets/app.js"></script><h1>ZIP app</h1></body></html>');
  zip.file('assets/app.css', 'body { background: url("./cover.png"); }');
  zip.file('assets/app.js', 'console.log("running");');
  zip.file('assets/cover.png', new Uint8Array([137, 80, 78, 71]));
  const bytes = await zip.generateAsync({ type: 'arraybuffer' });
  const published: string[] = [];
  const session = createMobileMetaAppPreviewSession(async () => new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'application/zip' },
  }), async (file) => {
    published.push(file.name);
    return previewPublisher(file);
  });
  try {
    const result = await session.createPreviewSession(previewInput('https://example.com/app.zip'));
    assert.ok(result.localPreviewUrl.startsWith('https://preview.test/'));
    assert.ok(published.some((name) => name.endsWith('assets-app.css')));
    assert.ok(published.some((name) => name.endsWith('assets-app.js')));
    assert.ok(published.some((name) => name.endsWith('assets-cover.png')));
    assert.ok(published.some((name) => name.endsWith('index.html')));
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
