import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Server-mode mobile page hosting (`mobile_open_page`, plan A).
 *
 * Exercises the COMPILED seams the runtime uses:
 *  - gateway/tokens.ts        page token sign/verify (HMAC, tenant, expiry),
 *  - gateway/mobilePages.ts   hosting envelope (confinement, extension
 *                             allow-list, size/count caps, traversal,
 *                             symlink escape) and asset resolution,
 *  - gateway/server.ts        the real `/gateway/v1/pages/…` HTTP route over a
 *                             real socket (valid token 200, missing token 404,
 *                             expired token 404, traversal 404),
 *  - serverMode.ts            the server-mode tool filter does NOT drop the
 *                             new tool, and the desktop disabled list is
 *                             untouched,
 *  - libs/mobilePageAgentTools.ts  tool surface: refuses without a running
 *                             gateway, mints a card fence on success.
 *
 * Plain node: no electron, no real tenant. `node --test` after
 * `pnpm run compile:electron`.
 */

const require = createRequire(import.meta.url);

const server = require('../dist-electron/main/gateway/server.js');
const tokens = require('../dist-electron/main/gateway/tokens.js');
const mobilePages = require('../dist-electron/main/gateway/mobilePages.js');
const serverMode = require('../dist-electron/main/server/serverMode.js');
const pageTools = require('../dist-electron/main/libs/mobilePageAgentTools.js');

const SECRET = 'test-gateway-secret';
const TENANT = 't_testtenant0000000001';
const WRONG_SECRET = 'test-gateway-secreX';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTenant(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-pages-')));
  const paths = {
    dataRoot: path.join(base, 'data'),
    workspaceRoot: path.join(base, 'data', 'workspace'),
    uploadsRoot: path.join(base, 'data', 'workspace', 'uploads'),
  };
  fs.mkdirSync(paths.uploadsRoot, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, paths };
}

function writePage(root) {
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>page</title><script src="assets/app.js"></script>');
  fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log("ok")');
  fs.writeFileSync(path.join(root, 'assets', 'style.css'), 'body{color:#111}');
  return root;
}

function deps(paths, overrides = {}) {
  return {
    secret: SECRET,
    tenantId: TENANT,
    paths,
    realpathSync: fs.realpathSync,
    ...overrides,
  };
}

function readyState() {
  return {
    phase: 'ready',
    version: '0.0.0-test',
    commit: 'testcommit',
    contractVersion: '1.0.0',
    onboarding: {
      identity: 'done',
      llmProvider: 'done',
      twinMetabot: 'done',
      workspace: 'done',
      trafficAccount: 'done',
      redeemCode: 'skipped',
      globalMetaId: null,
      twinMetabotId: null,
    },
    error: null,
  };
}

async function startGateway(t, paths) {
  const gateway = {
    host: '127.0.0.1',
    port: 0,
    secret: SECRET,
    tenantId: TENANT,
    tier: 'P1',
    contractVersion: '1.0.0',
    appVersion: '0.0.0-test',
    commit: 'testcommit',
    paths,
    readiness: () => readyState(),
    invokeHandler: async () => ({ ok: true }),
    hasHandler: () => true,
    addBroadcastListener: () => () => undefined,
    storeGet: () => undefined,
    revealMnemonic: async () => 'word1 word2 word3',
    logger: () => undefined,
  };
  const handle = await server.startGateway(gateway);
  t.after(async () => {
    await handle.close();
  });
  return handle;
}

function get(port, pathname, secret = SECRET) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: secret ? { 'X-IDBots-Gateway-Secret': secret } : {},
  });
}

// ---------------------------------------------------------------------------
// Page tokens
// ---------------------------------------------------------------------------

test('page token: signed payload round-trips for the minting tenant', () => {
  const now = Date.now();
  const token = tokens.signPageToken(SECRET, TENANT, '/data/workspace/page', 'index.html', now + 60_000);
  const verified = tokens.verifyPageToken(SECRET, TENANT, token, now);
  assert.ok(verified);
  assert.equal(verified.p, '/data/workspace/page');
  assert.equal(verified.i, 'index.html');
  assert.equal(verified.t, TENANT);
});

test('page token: no token / wrong secret / wrong tenant / expired all refuse', () => {
  const now = Date.now();
  const token = tokens.signPageToken(SECRET, TENANT, '/data/workspace/page', 'index.html', now + 60_000);

  assert.equal(tokens.verifyPageToken(SECRET, TENANT, '', now), null);
  assert.equal(tokens.verifyPageToken(SECRET, TENANT, 'not-a-token', now), null);
  assert.equal(tokens.verifyPageToken(WRONG_SECRET, TENANT, token, now), null);
  assert.equal(tokens.verifyPageToken(SECRET, 't_othertenant000000001', token, now), null);

  const expired = tokens.signPageToken(SECRET, TENANT, '/data/workspace/page', 'index.html', now - 1);
  assert.equal(tokens.verifyPageToken(SECRET, TENANT, expired, now), null);
});

test('page token: a tampered signature is refused', () => {
  const now = Date.now();
  const token = tokens.signPageToken(SECRET, TENANT, '/data/workspace/page', 'index.html', now + 60_000);
  const [payload, signature] = token.split('.');
  const flipped = `${payload}.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(tokens.verifyPageToken(SECRET, TENANT, flipped, now), null);
});

// ---------------------------------------------------------------------------
// Hosting envelope
// ---------------------------------------------------------------------------

test('hostMobilePage: directory with index.html mints a /pages/<token>/ URL', (t) => {
  const { paths } = makeTenant(t);
  const root = writePage(path.join(paths.workspaceRoot, 'report'));
  const hosted = mobilePages.hostMobilePage(deps(paths), { path: root, ttlHours: 1 });
  assert.match(mobilePages.mobilePageMimeForPath('/x/index.html'), /text\/html/);
  assert.equal(mobilePages.mobilePageMimeForPath('/x/notes.docx'), null);
  assert.equal(typeof hosted.url, 'string');
  assert.match(hosted.url, /^\/pages\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\/$/);
  assert.equal(hosted.entry, 'index.html');
  assert.equal(hosted.fileCount, 3);
  assert.ok(hosted.expiresAt > Date.now());
});

test('hostMobilePage: single .html file is hosted from its directory', (t) => {
  const { paths } = makeTenant(t);
  const root = writePage(path.join(paths.workspaceRoot, 'single'));
  const hosted = mobilePages.hostMobilePage(deps(paths), { path: path.join(root, 'index.html') });
  assert.equal(hosted.entry, 'index.html');
  assert.equal(hosted.root, root);
});

test('hostMobilePage: a single .html file never exposes its siblings', (t) => {
  const { paths } = makeTenant(t);
  const root = writePage(path.join(paths.workspaceRoot, 'single-guard'));
  fs.writeFileSync(path.join(root, 'neighbour.html'), '<html>secret</html>');
  const hosted = mobilePages.hostMobilePage(deps(paths), { path: path.join(root, 'index.html') });
  assert.equal(hosted.singleFile, true);
  const ctx = { secret: SECRET, tenantId: TENANT, realpathSync: fs.realpathSync };
  assert.ok(mobilePages.resolveMobilePageAsset(ctx, hosted.token, ''));
  assert.equal(mobilePages.resolveMobilePageAsset(ctx, hosted.token, 'neighbour.html'), null);
  assert.equal(mobilePages.resolveMobilePageAsset(ctx, hosted.token, 'assets/app.js'), null);
});

test('hostMobilePage: refuses non-html entry, missing path and out-of-root paths', (t) => {
  const { base, paths } = makeTenant(t);
  const pageDir = path.join(paths.workspaceRoot, 'no-entry');
  fs.mkdirSync(pageDir, { recursive: true });
  fs.writeFileSync(path.join(pageDir, 'notes.txt'), 'hello');

  const noEntry = mobilePages.hostMobilePage(deps(paths), { path: pageDir });
  assert.equal(noEntry.code, 'INVALID_ARGS');

  const missing = mobilePages.hostMobilePage(deps(paths), { path: path.join(paths.workspaceRoot, 'nope.html') });
  assert.equal(missing.code, 'INVALID_ARGS');

  const outside = path.join(base, 'outside', 'index.html');
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, '<html></html>');
  const refused = mobilePages.hostMobilePage(deps(paths), { path: outside });
  assert.equal(refused.code, 'ARG_RESTRICTED');
});

test('hostMobilePage: TTL defaults to 24h and is capped at 7 days', (t) => {
  const { paths } = makeTenant(t);
  const root = writePage(path.join(paths.workspaceRoot, 'ttl'));
  const now = Date.now();
  const withDefault = mobilePages.hostMobilePage(deps(paths), { path: root }, now);
  assert.equal(withDefault.expiresAt - now, mobilePages.MOBILE_PAGE_DEFAULT_TTL_MS);
  const capped = mobilePages.hostMobilePage(deps(paths), { path: root, ttlHours: 999 }, now);
  assert.equal(capped.expiresAt - now, mobilePages.MOBILE_PAGE_MAX_TTL_MS);
});

test('hostMobilePage: size cap refuses an oversized asset', (t) => {
  const { paths } = makeTenant(t);
  const root = writePage(path.join(paths.workspaceRoot, 'big'));
  fs.writeFileSync(path.join(root, 'assets', 'huge.bin.js'), Buffer.alloc(mobilePages.MOBILE_PAGE_MAX_FILE_BYTES + 1, 0x20));
  const refused = mobilePages.hostMobilePage(deps(paths), { path: root });
  assert.equal(refused.code, 'INVALID_ARGS');
  assert.match(refused.message, /file cap/);
});

test('hostMobilePage: file-count cap refuses a tree over the limit', (t) => {
  const { paths } = makeTenant(t);
  const root = writePage(path.join(paths.workspaceRoot, 'many'));
  fs.mkdirSync(path.join(root, 'assets', 'bulk'), { recursive: true });
  for (let i = 0; i < mobilePages.MOBILE_PAGE_MAX_FILES; i += 1) {
    fs.writeFileSync(path.join(root, 'assets', 'bulk', `f${i}.js`), 'x');
  }
  const refused = mobilePages.hostMobilePage(deps(paths), { path: root });
  assert.equal(refused.code, 'INVALID_ARGS');
  assert.match(refused.message, /servable files/);
});

// ---------------------------------------------------------------------------
// Asset resolution: valid / traversal / extension / symlink
// ---------------------------------------------------------------------------

test('resolveMobilePageAsset: entry and assets resolve; unknown paths refuse', (t) => {
  const { paths } = makeTenant(t);
  const root = writePage(path.join(paths.workspaceRoot, 'resolve'));
  const hosted = mobilePages.hostMobilePage(deps(paths), { path: root });
  const ctx = { secret: SECRET, tenantId: TENANT, realpathSync: fs.realpathSync };

  const entry = mobilePages.resolveMobilePageAsset(ctx, hosted.token, '');
  assert.ok(entry);
  assert.equal(path.basename(entry.filePath), 'index.html');
  assert.match(entry.mime, /text\/html/);

  const css = mobilePages.resolveMobilePageAsset(ctx, hosted.token, 'assets/style.css');
  assert.ok(css);
  assert.match(css.mime, /text\/css/);

  assert.equal(mobilePages.resolveMobilePageAsset(ctx, hosted.token, 'assets/missing.css'), null);
});

test('resolveMobilePageAsset: traversal, absolute paths, backslash and NUL all refuse', (t) => {
  const { paths } = makeTenant(t);
  const root = writePage(path.join(paths.workspaceRoot, 'trav'));
  // A secret next to (outside) the page root — traversal must never reach it.
  fs.writeFileSync(path.join(paths.workspaceRoot, 'secret.txt'), 'top secret');
  const hosted = mobilePages.hostMobilePage(deps(paths), { path: root });
  const ctx = { secret: SECRET, tenantId: TENANT, realpathSync: fs.realpathSync };

  for (const attempt of [
    '../secret.txt',
    'assets/../../secret.txt',
    '/etc/passwd',
    'assets\\app.js',
    'assets/app.js\0.txt',
    './../secret.txt',
  ]) {
    assert.equal(mobilePages.resolveMobilePageAsset(ctx, hosted.token, attempt), null, `should refuse ${attempt}`);
  }
});

test('resolveMobilePageAsset: symlink escape and non-servable extension refuse', (t) => {
  const { base, paths } = makeTenant(t);
  const root = writePage(path.join(paths.workspaceRoot, 'sym'));
  const outside = path.join(base, 'outside-asset.css');
  fs.writeFileSync(outside, 'body{}');
  fs.writeFileSync(path.join(root, 'data.json.bak'), '{}');

  // Defense in depth: mint the token directly (a symlink can appear AFTER the
  // hosting scan). The route-level resolver must still refuse the escape.
  const token = tokens.signPageToken(SECRET, TENANT, root, 'index.html', Date.now() + 60_000);
  const ctx = { secret: SECRET, tenantId: TENANT, realpathSync: fs.realpathSync };
  assert.ok(mobilePages.resolveMobilePageAsset(ctx, token, 'assets/app.js'));
  assert.equal(mobilePages.resolveMobilePageAsset(ctx, token, 'data.json.bak'), null);

  fs.symlinkSync(outside, path.join(root, 'assets', 'leak.css'));
  assert.equal(mobilePages.resolveMobilePageAsset(ctx, token, 'assets/leak.css'), null);
});

test('hostMobilePage: an escaping symlink inside the page refuses the whole page', (t) => {
  const { base, paths } = makeTenant(t);
  const root = writePage(path.join(paths.workspaceRoot, 'sym-host'));
  const outside = path.join(base, 'outside-asset.css');
  fs.writeFileSync(outside, 'body{}');
  fs.symlinkSync(outside, path.join(root, 'assets', 'leak.css'));
  const refused = mobilePages.hostMobilePage(deps(paths), { path: root });
  assert.equal(refused.code, 'ARG_RESTRICTED');
});

test('resolveMobilePageAsset: expired token refuses even for the entry', (t) => {
  const { paths } = makeTenant(t);
  const root = writePage(path.join(paths.workspaceRoot, 'expired'));
  const now = Date.now();
  const hosted = mobilePages.hostMobilePage(deps(paths), { path: root, ttlHours: 1 }, now);
  const ctx = { secret: SECRET, tenantId: TENANT, realpathSync: fs.realpathSync };
  assert.ok(mobilePages.resolveMobilePageAsset(ctx, hosted.token, '', now + 1000));
  assert.equal(
    mobilePages.resolveMobilePageAsset(ctx, hosted.token, '', now + 60 * 60 * 1000 + 1),
    null,
  );
});

// ---------------------------------------------------------------------------
// HTTP route (real socket)
// ---------------------------------------------------------------------------

test('GET /gateway/v1/pages: valid token serves the entry and its assets', async (t) => {
  const { paths } = makeTenant(t);
  const root = writePage(path.join(paths.workspaceRoot, 'http-page'));
  const hosted = mobilePages.hostMobilePage(deps(paths), { path: root });
  const handle = await startGateway(t, paths);

  const entry = await get(handle.port, hosted.gatewayPath);
  assert.equal(entry.status, 200);
  assert.match(entry.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await entry.text(), /<title>page<\/title>/);

  const asset = await get(handle.port, `${hosted.gatewayPath}assets/app.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type') ?? '', /javascript/);
  assert.equal(await asset.text(), 'console.log("ok")');
});

test('GET /gateway/v1/pages: no token / bad token / expired token answer 404', async (t) => {
  const { paths } = makeTenant(t);
  const root = writePage(path.join(paths.workspaceRoot, 'http-refuse'));
  const handle = await startGateway(t, paths);

  assert.equal((await get(handle.port, '/gateway/v1/pages/')).status, 404);
  assert.equal((await get(handle.port, '/gateway/v1/pages/not-a-token/')).status, 404);
  assert.equal((await get(handle.port, '/gateway/v1/pages/a.b/')).status, 404);

  const expired = tokens.signPageToken(SECRET, TENANT, root, 'index.html', Date.now() - 1);
  assert.equal((await get(handle.port, `/gateway/v1/pages/${expired}/`)).status, 404);
});

test('GET /gateway/v1/pages: traversal, extension and symlink escapes answer 404', async (t) => {
  const { base, paths } = makeTenant(t);
  const root = writePage(path.join(paths.workspaceRoot, 'http-trav'));
  fs.writeFileSync(path.join(paths.workspaceRoot, 'secret.txt'), 'top secret');
  fs.writeFileSync(path.join(base, 'outside.css'), 'body{}');
  fs.symlinkSync(path.join(base, 'outside.css'), path.join(root, 'assets', 'leak.css'));
  const hosted = mobilePages.hostMobilePage(deps(paths), { path: root });
  const handle = await startGateway(t, paths);
  const basePath = `/gateway/v1/pages/${hosted.token}`;

  for (const attempt of [
    '/../secret.txt',
    '/assets/../../secret.txt',
    '/%2e%2e/secret.txt',
    '/assets/leak.css',
    '/data.json.bak',
  ]) {
    const res = await get(handle.port, `${basePath}${attempt}`);
    assert.equal(res.status, 404, `should 404: ${attempt}`);
  }
});

test('GET /gateway/v1/pages: malformed percent encoding in EITHER segment answers 404 and the server survives', async (t) => {
  const { paths } = makeTenant(t);
  const root = writePage(path.join(paths.workspaceRoot, 'http-bad-pct'));
  const hosted = mobilePages.hostMobilePage(deps(paths), { path: root });
  const handle = await startGateway(t, paths);

  // '%zz' throws URIError inside decodeURIComponent. Unguarded, it escapes the
  // handler into the http server's request emit as an uncaughtException (the
  // process dies) — so: 404, then the server must still answer.
  const targets = [
    '/gateway/v1/pages/%zz/',
    '/gateway/v1/pages/%zz/assets/app.js',
    `/gateway/v1/pages/${hosted.token}/%zz.css`,
    '/gateway/v1/pages/%E0%A4%A/',
  ];
  for (const target of targets) {
    const res = await get(handle.port, target);
    assert.equal(res.status, 404, `should 404: ${target}`);
  }
  const alive = await get(handle.port, '/healthz');
  assert.equal(alive.status, 200, 'the gateway must survive malformed percent encoding');
  // And a valid request still works afterwards.
  const ok = await get(handle.port, hosted.gatewayPath);
  assert.equal(ok.status, 200);
});

test('GET /gateway/v1/pages: without the gateway secret the route answers 401', async (t) => {
  const { paths } = makeTenant(t);
  const root = writePage(path.join(paths.workspaceRoot, 'http-auth'));
  const hosted = mobilePages.hostMobilePage(deps(paths), { path: root });
  const handle = await startGateway(t, paths);
  assert.equal((await get(handle.port, hosted.gatewayPath, null)).status, 401);
});

// ---------------------------------------------------------------------------
// Server-mode tool surface
// ---------------------------------------------------------------------------

test('server-mode filter keeps mobile_open_page and the desktop disabled list is untouched', (t) => {
  const previous = process.env.IDBOTS_SERVER_MODE;
  process.env.IDBOTS_SERVER_MODE = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.IDBOTS_SERVER_MODE;
    else process.env.IDBOTS_SERVER_MODE = previous;
  });
  const tools = [{ name: 'mobile_open_page' }, { name: 'bash' }, { name: 'bot_browser_screenshot' }];
  const filtered = serverMode.filterServerModeAgentTools(tools);
  const names = filtered.map((tool) => tool.name);
  assert.ok(names.includes('mobile_open_page'), 'the new tool must not be filtered out');
  assert.ok(names.includes('bash'));
  assert.ok(!names.includes('bot_browser_screenshot'));

  // REQ-A-5 list deliberately unchanged: the new tool is NOT a desktop
  // disable-list entry — it is mounted only in server mode.
  assert.equal(serverMode.SERVER_MODE_DISABLED_AGENT_TOOLS.has('mobile_open_page'), false);
});

test('desktop mount seam: mobile_open_page is registered only under isServerMode()', () => {
  const runner = fs.readFileSync(
    path.join(process.cwd(), 'src', 'main', 'libs', 'coworkRunner.ts'),
    'utf8',
  );
  // The mount must be doubly gated: the control is only wired by main.ts and
  // the seam itself re-checks the mode switch.
  assert.match(runner, /if \(this\.mobilePage && isServerMode\(\)\) \{\s*\n\s*memoryTools\.push\(\s*\n\s*\.\.\.buildMobilePageAgentTools/);
  // REQ-A-5 desktop disable list stays exactly as it was: the new tool is a
  // server-only MOUNT, never a desktop disable-list entry.
  const serverModeSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'main', 'server', 'serverMode.ts'),
    'utf8',
  );
  const listStart = serverModeSource.indexOf('SERVER_MODE_DISABLED_AGENT_TOOLS');
  const listEnd = serverModeSource.indexOf(']);', listStart);
  const disableList = serverModeSource.slice(listStart, listEnd);
  assert.doesNotMatch(disableList, /mobile_open_page/);
});

test('buildMobilePageAgentTools: refuses without a running gateway, mints a card with one', async (t) => {
  const { paths } = makeTenant(t);
  const root = writePage(path.join(paths.workspaceRoot, 'tool-page'));

  const calls = [];
  const tool = (name, description, schema, handler) => {
    calls.push({ name, description, schema, handler });
    return { name, description, schema, handler };
  };

  const withoutGateway = pageTools.buildMobilePageAgentTools({
    tool,
    control: { getGatewayContext: () => null },
  });
  assert.equal(withoutGateway.length, 1);
  assert.equal(withoutGateway[0].name, 'mobile_open_page');
  const refused = await withoutGateway[0].handler({ path: root, title: 'No gateway' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /gateway is not running/);

  const withGateway = pageTools.buildMobilePageAgentTools({
    tool,
    control: {
      getGatewayContext: () => ({ secret: SECRET, tenantId: TENANT, paths }),
      realpathSync: fs.realpathSync,
    },
  });
  const ok = await withGateway[0].handler({ path: root, title: 'Weekly report', description: 'W47' });
  assert.equal(ok.isError, undefined);
  const text = ok.content[0].text;
  assert.match(text, /```mobile-page-card/);
  assert.match(text, /"title":"Weekly report"/);
  assert.match(text, /\/pages\//);

  // The emitted fence must parse back through the renderer grammar (the
  // same-space contract: main emits, the card renderer consumes).
  const fence = text.slice(text.indexOf('```mobile-page-card'));
  const body = fence.split('\n')[1];
  const payload = JSON.parse(body);
  assert.match(payload.url, /^\/pages\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\/$/);
  assert.equal(payload.title, 'Weekly report');
  assert.equal(payload.description, 'W47');
  assert.ok(payload.expiresAt > Date.now());
});

test('buildMobilePageAgentTools: traversal-ish path and out-of-root path refuse', async (t) => {
  const { base, paths } = makeTenant(t);
  const outside = path.join(base, 'outside', 'index.html');
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, '<html></html>');

  const tools = pageTools.buildMobilePageAgentTools({
    tool: (name, _d, _s, handler) => ({ name, handler }),
    control: {
      getGatewayContext: () => ({ secret: SECRET, tenantId: TENANT, paths }),
      realpathSync: fs.realpathSync,
    },
  });
  const outsideResult = await tools[0].handler({ path: outside, title: 'outside' });
  assert.equal(outsideResult.isError, true);
  assert.match(outsideResult.content[0].text, /ARG_RESTRICTED/);

  const relative = await tools[0].handler({ path: '../etc/passwd', title: 'rel' });
  assert.equal(relative.isError, true);
});
