import assert from 'node:assert/strict';
import test from 'node:test';
import {
  artifactBrowserUri,
  artifactFilename,
  artifactKind,
  fetchArtifactText,
  shareArtifactUrl,
} from '../src/mobile/app/artifacts';
import {
  createMockArtifactImage,
  createMockArtifactPdf,
  getMockArtifact,
  MOCK_ARTIFACT_PATHS,
} from '../src/mobile/bridge/mockArtifacts';

test('artifact names and preview types are derived from tenant paths', () => {
  assert.equal(artifactFilename('C:\\work\\report.PDF'), 'report.PDF');
  assert.equal(artifactFilename('/data/workspace/'), 'file');
  assert.equal(artifactKind('/data/chart.PNG'), 'image');
  assert.equal(artifactKind('/data/report.pdf'), 'pdf');
  assert.equal(artifactKind('/data/notes.markdown'), 'markdown');
  assert.equal(artifactKind('/data/readme.txt'), 'markdown');
  assert.equal(artifactKind('/data/archive.zip'), 'other');
  assert.equal(artifactKind('/data/no-extension'), 'other');
  assert.equal(artifactKind('/data/app.HTML'), 'html');
  assert.equal(artifactKind('/data/index.htm'), 'html');
});

test('HTML artifacts open through ABC preview-file while other kinds keep their native preview', () => {
  assert.equal(
    artifactBrowserUri('/data/workspace/today-inspiration.html'),
    'preview-file://localhost/data/workspace/today-inspiration.html',
  );
  assert.equal(
    artifactBrowserUri('C:\\work\\report.html'),
    'preview-file://localhost/C:/work/report.html',
  );
  assert.equal(artifactBrowserUri('/data/chart.png'), null);
  assert.equal(artifactBrowserUri('/data/notes.md'), null);
});

test('signed text requests use credentials and expose failures honestly', async () => {
  const controller = new AbortController();
  const text = await fetchArtifactText('/files/signed', {
    signal: controller.signal,
    fetchImpl: async (input, init) => {
      assert.equal(input, '/files/signed');
      assert.equal(init?.credentials, 'include');
      assert.equal(init?.signal, controller.signal);
      return new Response('# Real markdown', { status: 200 });
    },
  });
  assert.equal(text, '# Real markdown');
  await assert.rejects(
    fetchArtifactText('/files/missing', { fetchImpl: async () => new Response('missing', { status: 404 }) }),
      /404/,
  );
});

test('native share uses an absolute signed URL and clipboard remains a fallback', async () => {
  let shared: { title: string; url: string } | null = null;
  const native = await shareArtifactUrl('/files/token', 'report.pdf', 'https://app.example', {
    share: async (data) => { shared = data; },
    copy: async () => assert.fail('native share must not copy'),
  });
  assert.equal(native, 'shared');
  assert.deepEqual(shared, { title: 'report.pdf', url: 'https://app.example/files/token' });

  let copied = '';
  const fallback = await shareArtifactUrl('/files/token', 'report.pdf', 'https://app.example', {
    copy: async (text) => { copied = text; },
  });
  assert.equal(fallback, 'copied');
  assert.equal(copied, 'https://app.example/files/token');
});

test('share cancellation and native failure never masquerade as success', async () => {
  let copies = 0;
  const cancelled = await shareArtifactUrl('/files/token', 'report.pdf', 'https://app.example', {
    share: async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); },
    copy: async () => { copies += 1; },
  });
  assert.equal(cancelled, 'cancelled');
  assert.equal(copies, 0);
  const fallback = await shareArtifactUrl('/files/token', 'report.pdf', 'https://app.example', {
    share: async () => { throw new Error('unavailable'); },
    copy: async () => { copies += 1; },
  });
  assert.equal(fallback, 'copied');
  assert.equal(copies, 1);
});

test('mock fixtures contain a real PNG signature, Markdown and a parseable PDF', async () => {
  assert.deepEqual(Array.from(createMockArtifactImage().slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  const markdown = getMockArtifact(MOCK_ARTIFACT_PATHS.markdown);
  assert.equal(markdown?.mime, 'text/markdown');
  assert.match(new TextDecoder().decode(markdown?.bytes()), /This \*\*Markdown\*\* came from the signed file/);
  const pdf = createMockArtifactPdf();
  assert.match(new TextDecoder().decode(pdf.slice(0, 8)), /^%PDF-/);
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = getDocument({
    data: pdf,
    disableWorker: true,
    standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).href,
  });
  const document = await loadingTask.promise;
  assert.equal(document.numPages, 1);
  const page = await document.getPage(1);
  const content = await page.getTextContent();
  assert.ok(content.items.some((item) => 'str' in item && item.str === 'Mobile artifact preview'));
  await loadingTask.destroy();
});
