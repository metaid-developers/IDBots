// Local-image inlining for rendered HTML reports (inline block + side panel).
//
// The app CSP has no `file:` in img-src, so `<img src="source/a.jpg">` in a
// bot-written report rendered blank (2026-11-08 NFT issue preview). The host
// now resolves local images to data URIs. These tests pin:
//   (a) main-side boundary: only real images (magic bytes) inside the
//       document's own directory tree — symlinks resolved first — are read;
//       remote/data/fragment sources are never touched; size and budget caps
//       hold; the thumbnailer is used for PNG/JPEG and passthrough is capped;
//   (b) renderer helpers: local src collection and data-URI substitution keep
//       every other attribute and every non-resolved src byte-identical;
//   (c) wiring: both render paths (InlineHtmlReportBlock, MarkdownViewerPanel)
//       inline before rendering, view-source keeps the document as written,
//       and the new channel is preload-exposed and denied (N) on the gateway.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  applyInlineHtmlImageMap,
  collectLocalInlineHtmlImageSrcs,
  isLocalInlineHtmlImageSrc,
} from '../src/renderer/components/cowork/inlineHtmlImages';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = require(path.join(projectRoot, 'dist-electron', 'main', 'libs', 'inlineHtmlLocalImages.js')) as {
  inlineHtmlLocalImages: (deps: unknown, input: { htmlPath: string; srcs: string[] }) => Promise<{ images: Record<string, string>; skipped: Record<string, string> }>;
  sniffInlineHtmlImageMime: (buffer: Buffer) => string | null;
  resolveInlineHtmlImagePath: (dir: string, src: string) => string | null;
  INLINE_HTML_IMAGE_MAX_PASSTHROUGH_BYTES: number;
};

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'binary');
const SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>');

const realDeps = (thumbnail?: unknown) => ({
  realpath: (target: string) => fs.promises.realpath(target),
  stat: (target: string) => fs.promises.stat(target),
  readFile: (target: string) => fs.promises.readFile(target),
  ...(thumbnail ? { thumbnail } : {}),
});

function makeIssueFolder() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inline-html-'));
  const issue = path.join(root, 'nft-issue');
  fs.mkdirSync(path.join(issue, 'source'), { recursive: true });
  fs.writeFileSync(path.join(issue, 'preview.html'), '<html></html>');
  fs.writeFileSync(path.join(issue, 'source', 'frame_1.jpg'), JPEG);
  fs.writeFileSync(path.join(issue, 'source', 'frame 2.png'), PNG);
  fs.writeFileSync(path.join(issue, 'source', 'anim.gif'), GIF);
  fs.writeFileSync(path.join(issue, 'source', 'logo.svg'), SVG);
  fs.writeFileSync(path.join(issue, 'source', 'notes.txt'), 'not an image');
  fs.writeFileSync(path.join(issue, 'source', 'fake.jpg'), 'plain text with a jpg name');
  fs.writeFileSync(path.join(root, 'secret.png'), PNG);
  return { root, issue, htmlPath: path.join(issue, 'preview.html') };
}

const cleanup = (root: string) => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
};

test('sniffInlineHtmlImageMime trusts magic bytes, never the extension', () => {
  assert.equal(lib.sniffInlineHtmlImageMime(PNG), 'image/png');
  assert.equal(lib.sniffInlineHtmlImageMime(JPEG), 'image/jpeg');
  assert.equal(lib.sniffInlineHtmlImageMime(GIF), 'image/gif');
  assert.equal(lib.sniffInlineHtmlImageMime(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'binary')), 'image/webp');
  assert.equal(lib.sniffInlineHtmlImageMime(SVG), 'image/svg+xml');
  assert.equal(lib.sniffInlineHtmlImageMime(Buffer.from('plain text')), null);
  assert.equal(lib.sniffInlineHtmlImageMime(Buffer.from('<html><svg></svg></html>')), null);
});

test('resolveInlineHtmlImagePath maps relative, absolute and file:// sources; rejects remote ones', () => {
  const dir = '/tmp/issue';
  assert.equal(lib.resolveInlineHtmlImagePath(dir, 'source/a.jpg'), path.normalize('/tmp/issue/source/a.jpg'));
  assert.equal(lib.resolveInlineHtmlImagePath(dir, './source/frame%202.png?v=1#x'), path.normalize('/tmp/issue/source/frame 2.png'));
  assert.equal(lib.resolveInlineHtmlImagePath(dir, 'file:///tmp/issue/a.png'), path.normalize('/tmp/issue/a.png'));
  for (const remote of ['https://x.io/a.png', 'http://x/a.png', 'data:image/png;base64,AA', 'blob:abc', '//cdn/a.png', '#frag', 'metafile://abc']) {
    assert.equal(lib.resolveInlineHtmlImagePath(dir, remote), null, remote);
  }
});

test('inlineHtmlLocalImages inlines real images in the document tree and refuses everything else', async () => {
  const { root, issue, htmlPath } = makeIssueFolder();
  try {
    fs.symlinkSync(path.join(root, 'secret.png'), path.join(issue, 'source', 'link.png'));
    const srcs = [
      'source/frame_1.jpg',
      'source/frame%202.png',
      'source/anim.gif',
      'source/logo.svg',
      'source/notes.txt',
      'source/fake.jpg',
      '../secret.png',
      path.join(root, 'secret.png'),
      'source/link.png',
      'source/missing.png',
      'source',
      'https://example.com/a.png',
    ];
    const result = await lib.inlineHtmlLocalImages(realDeps(), { htmlPath, srcs });
    assert.match(result.images['source/frame_1.jpg'], /^data:image\/jpeg;base64,/);
    assert.match(result.images['source/frame%202.png'], /^data:image\/png;base64,/);
    assert.match(result.images['source/anim.gif'], /^data:image\/gif;base64,/);
    assert.match(result.images['source/logo.svg'], /^data:image\/svg\+xml;base64,/);
    assert.equal(result.skipped['source/notes.txt'], 'not_an_image');
    assert.equal(result.skipped['source/fake.jpg'], 'not_an_image');
    assert.equal(result.skipped['../secret.png'], 'outside_document_dir');
    assert.equal(result.skipped[path.join(root, 'secret.png')], 'outside_document_dir');
    assert.equal(result.skipped['source/link.png'], 'outside_document_dir', 'symlinks are resolved before the boundary check');
    assert.equal(result.skipped['source/missing.png'], 'not_found');
    assert.equal(result.skipped.source, 'not_a_file');
    assert.equal(result.skipped['https://example.com/a.png'], 'unsupported_src');
  } finally {
    cleanup(root);
  }
});

test('inlineHtmlLocalImages thumbnails PNG/JPEG and caps passthrough of formats it cannot re-encode', async () => {
  const { root, issue, htmlPath } = makeIssueFolder();
  try {
    const big = Buffer.concat([JPEG, Buffer.alloc(lib.INLINE_HTML_IMAGE_MAX_PASSTHROUGH_BYTES + 10)]);
    fs.writeFileSync(path.join(issue, 'source', 'big.jpg'), big);
    const bigGif = Buffer.concat([GIF, Buffer.alloc(lib.INLINE_HTML_IMAGE_MAX_PASSTHROUGH_BYTES + 10)]);
    fs.writeFileSync(path.join(issue, 'source', 'big.gif'), bigGif);
    const calls: Array<{ mime: string; maxEdge: number }> = [];
    const thumbnail = async (_buffer: Buffer, mime: string, maxEdge: number) => {
      calls.push({ mime, maxEdge });
      return { data: Buffer.from([0xff, 0xd8, 0xff, 0x01]), mime: 'image/jpeg' };
    };
    const result = await lib.inlineHtmlLocalImages(realDeps(thumbnail), {
      htmlPath,
      srcs: ['source/big.jpg', 'source/big.gif'],
    });
    assert.equal(result.images['source/big.jpg'], `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0x01]).toString('base64')}`);
    assert.deepEqual(calls, [{ mime: 'image/jpeg', maxEdge: 720 }]);
    assert.equal(result.skipped['source/big.gif'], 'too_large', 'a GIF over the passthrough cap is never inlined whole');

    // Thumbnailer unavailable → the same big JPEG is refused instead of
    // shipping megabytes of base64 into the frame.
    const noThumb = await lib.inlineHtmlLocalImages(realDeps(async () => null), { htmlPath, srcs: ['source/big.jpg'] });
    assert.equal(noThumb.skipped['source/big.jpg'], 'too_large');
  } finally {
    cleanup(root);
  }
});

test('renderer helpers collect local <img> sources and substitute only resolved ones', () => {
  const html = [
    '<img src="source/frame_1.jpg" alt="cover">',
    "<img class='t' src='source/frame 2.png'>",
    '<img src=source/bare.jpg width=10>',
    '<img src="https://cdn.example/a.png">',
    '<img src="data:image/png;base64,AA">',
    '<IMG SRC="source/frame_1.jpg">',
    '<div style="background:url(source/bg.jpg)"></div>',
  ].join('\n');
  assert.deepEqual(collectLocalInlineHtmlImageSrcs(html), ['source/frame_1.jpg', 'source/frame 2.png', 'source/bare.jpg']);
  assert.equal(isLocalInlineHtmlImageSrc('file:///tmp/a.png'), true);
  assert.equal(isLocalInlineHtmlImageSrc('C:\\shots\\a.png'), true);
  assert.equal(isLocalInlineHtmlImageSrc('mailto:x@y.z'), false);

  const out = applyInlineHtmlImageMap(html, {
    'source/frame_1.jpg': 'data:image/jpeg;base64,QUJD',
    'source/bare.jpg': 'data:image/jpeg;base64,REVG',
    'source/frame 2.png': 'javascript:alert(1)',
  });
  assert.match(out, /<img src="data:image\/jpeg;base64,QUJD" alt="cover">/);
  assert.match(out, /<IMG SRC="data:image\/jpeg;base64,QUJD">/);
  assert.match(out, /<img src="data:image\/jpeg;base64,REVG" width=10>/);
  assert.match(out, /<img class='t' src='source\/frame 2\.png'>/, 'non-image data never replaces a src');
  assert.match(out, /https:\/\/cdn\.example\/a\.png/);
  assert.match(out, /url\(source\/bg\.jpg\)/, 'CSS url() is left as written');
  assert.equal(applyInlineHtmlImageMap(html, {}), html);
});

test('wiring: both render paths inline before rendering; view-source keeps the original; channel is desktop-only', () => {
  const read = (...segments: string[]) => fs.readFileSync(path.join(projectRoot, ...segments), 'utf8');
  const block = read('src', 'renderer', 'components', 'cowork', 'InlineHtmlReportBlock.tsx');
  assert.match(block, /await inlineLocalHtmlImages\(content, filePath\)/);
  assert.match(block, /buildInlineHtmlSrcDoc\(renderHtml, filePath\)/, 'the frame renders the inlined document');
  assert.match(block, /setHtml\(content\);\s*setRenderHtml\(withImages\);/, 'view-source keeps the document as written');

  const panel = read('src', 'renderer', 'components', 'cowork', 'MarkdownViewerPanel.tsx');
  assert.match(panel, /isHtmlFile\s*\?\s*await inlineLocalHtmlImages\(result\.content, filePath\)/);

  const preload = read('src', 'main', 'preload.ts');
  assert.match(preload, /inlineHtmlImages: \(htmlPath: string, srcs: string\[\]\) => ipcRenderer\.invoke\('fs:inlineHtmlImages'/);

  const main = read('src', 'main', 'main.ts');
  assert.match(main, /registerIpcHandler\('fs:inlineHtmlImages'/);

  const { INVOKE_ALLOWLIST } = require(path.join(projectRoot, 'dist-electron', 'main', 'gateway', 'allowlist.js')) as {
    INVOKE_ALLOWLIST: Record<string, { tier: string }>;
  };
  assert.equal(INVOKE_ALLOWLIST['fs:inlineHtmlImages']?.tier, 'N', 'denied on the mobile gateway');
});
