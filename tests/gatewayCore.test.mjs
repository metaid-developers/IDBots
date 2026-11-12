import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * REQ-A-29 — gateway core unit tests. Covers the pure, node-testable halves
 * of the C2 gateway protocol: frame codec, HMAC tokens + nonce store,
 * R-rule restrictions, file-sign core, upload helpers, readiness mapping,
 * and the extracted IPC payload sanitizer.
 */

const require = createRequire(import.meta.url);

const protocol = require('../dist-electron/main/gateway/protocol.js');
const tokens = require('../dist-electron/main/gateway/tokens.js');
const restrictions = require('../dist-electron/main/gateway/restrictions.js');
const fileSign = require('../dist-electron/main/gateway/fileSign.js');
const upload = require('../dist-electron/main/gateway/upload.js');
const readiness = require('../dist-electron/main/gateway/readiness.js');
const sanitize = require('../dist-electron/main/ipc/sanitize.js');

const SECRET = 'test-gateway-secret';
const TENANT = 't_testtenant0000000001';

// ---------------------------------------------------------------------------
// Fixture: a tenant-like directory tree under a realpath'd temp dir (macOS
// /var → /private/var symlink makes realpath'd roots necessary).
// ---------------------------------------------------------------------------

function makeTenantTree(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-core-')));
  const paths = {
    dataRoot: path.join(base, 'data'),
    workspaceRoot: path.join(base, 'data', 'workspace'),
    uploadsRoot: path.join(base, 'data', 'workspace', 'uploads'),
  };
  fs.mkdirSync(paths.uploadsRoot, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, paths };
}

// ---------------------------------------------------------------------------
// protocol.ts — frame codec
// ---------------------------------------------------------------------------

test('protocol: invoke frame round-trips through encode/parse', () => {
  const frame = { v: 1, type: 'invoke', id: 'abc-1', channel: 'cowork:session:list', args: [{ limit: 5 }] };
  const parsed = protocol.parseInboundFrame(protocol.encodeFrame(frame));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.frame, frame);
});

test('protocol: ping frame parses', () => {
  const parsed = protocol.parseInboundFrame(JSON.stringify({ v: 1, type: 'ping', ts: 1234 }));
  assert.deepEqual(parsed, { ok: true, frame: { v: 1, type: 'ping', ts: 1234 } });
});

test('protocol: every malformed inbound frame yields INVALID_FRAME', () => {
  const bad = (text) => {
    const parsed = protocol.parseInboundFrame(text);
    assert.equal(parsed.ok, false, `expected failure for: ${text}`);
    assert.equal(parsed.error.code, 'INVALID_FRAME');
    assert.equal(parsed.error.retryable, false);
  };
  bad('not json at all');
  bad('[1,2,3]');
  bad('"hello"');
  bad('123');
  bad('{}');
  bad(JSON.stringify({ v: 2, type: 'invoke', id: 'x', channel: 'c', args: [] }));
  bad(JSON.stringify({ v: 1 }));
  bad(JSON.stringify({ v: 1, type: 'pong', ts: 1 })); // server → client only
  bad(JSON.stringify({ v: 1, type: 'invoke', channel: 'c', args: [] })); // missing id
  bad(JSON.stringify({ v: 1, type: 'invoke', id: '', channel: 'c', args: [] })); // empty id
  bad(JSON.stringify({ v: 1, type: 'invoke', id: 'x'.repeat(65), channel: 'c', args: [] })); // id too long
  bad(JSON.stringify({ v: 1, type: 'invoke', id: 'x', args: [] })); // missing channel
  bad(JSON.stringify({ v: 1, type: 'invoke', id: 'x', channel: 42, args: [] })); // non-string channel
  bad(JSON.stringify({ v: 1, type: 'invoke', id: 'x', channel: 'c' })); // missing args
  bad(JSON.stringify({ v: 1, type: 'invoke', id: 'x', channel: 'c', args: {} })); // non-array args
  bad(JSON.stringify({ v: 1, type: 'ping' })); // ping without ts
});

test('protocol: id of exactly 64 chars is accepted', () => {
  const parsed = protocol.parseInboundFrame(JSON.stringify({ v: 1, type: 'invoke', id: 'x'.repeat(64), channel: 'c', args: [] }));
  assert.equal(parsed.ok, true);
});

test('protocol: every ErrorCode constructs with the C2 retryable default', () => {
  const expected = {
    CHANNEL_NOT_ALLOWED: false,
    CHANNEL_NOT_FOUND: false,
    INVALID_FRAME: false,
    INVALID_ARGS: false,
    ARG_RESTRICTED: false,
    HANDLER_ERROR: false,
    TIMEOUT: true,
    PAYLOAD_TOO_LARGE: false,
    RATE_LIMITED: true,
    TENANT_NOT_READY: true,
    UPGRADING: true,
  };
  for (const [code, retryable] of Object.entries(expected)) {
    const error = protocol.makeError(code, `m-${code}`);
    assert.deepEqual(error, { code, message: `m-${code}`, retryable });
    assert.equal(protocol.ERROR_RETRYABLE[code], retryable);
  }
  // Explicit override wins (HANDLER_ERROR is "depends; false by default").
  assert.equal(protocol.makeError('HANDLER_ERROR', 'boom', true).retryable, true);
});

test('protocol: result constructors and limits constants', () => {
  assert.deepEqual(protocol.makeResultOk('id1', { a: 1 }), { v: 1, type: 'result', id: 'id1', ok: true, value: { a: 1 } });
  const error = protocol.makeError('TIMEOUT', 'slow');
  assert.deepEqual(protocol.makeResultError('id1', error), { v: 1, type: 'result', id: 'id1', ok: false, error });
  assert.equal(protocol.INBOUND_FRAME_MAX_BYTES, 1024 * 1024);
  assert.equal(protocol.OUTBOUND_FRAME_MAX_BYTES, 8 * 1024 * 1024);
  assert.equal(protocol.MAX_IN_FLIGHT_INVOKES, 32);
  assert.equal(protocol.INVOKE_RATE_PER_SEC, 50);
  assert.equal(protocol.INVOKE_RATE_BURST, 100);
  assert.equal(protocol.DEFAULT_INVOKE_TIMEOUT_MS, 120_000);
});

// ---------------------------------------------------------------------------
// tokens.ts — file tokens
// ---------------------------------------------------------------------------

test('tokens: file token signs and verifies', () => {
  const now = 1_800_000_000_000;
  const token = tokens.signFileToken(SECRET, TENANT, '/data/workspace/report.md', 'attachment', now + 60_000);
  const payload = tokens.verifyFileToken(SECRET, TENANT, token, now);
  assert.deepEqual(payload, { p: '/data/workspace/report.md', d: 'attachment', e: now + 60_000, t: TENANT });
});

test('tokens: file token rejects tampered signature, wrong tenant, expiry, garbage', () => {
  const now = 1_800_000_000_000;
  const token = tokens.signFileToken(SECRET, TENANT, '/data/workspace/report.md', 'inline', now + 60_000);
  assert.equal(tokens.verifyFileToken(SECRET, TENANT, `${token}x`, now), null, 'garbage signature');
  const [payload, sig] = token.split('.');
  const flippedSig = sig.startsWith('A') ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
  assert.equal(tokens.verifyFileToken(SECRET, TENANT, `${payload}.${flippedSig}`, now), null, 'tampered signature');
  assert.equal(tokens.verifyFileToken(SECRET, 't_other', token, now), null, 'wrong tenant');
  assert.equal(tokens.verifyFileToken(SECRET, TENANT, token, now + 60_001), null, 'expired');
  assert.equal(tokens.verifyFileToken(SECRET, TENANT, 'no-dot-here', now), null, 'malformed token');
});

// ---------------------------------------------------------------------------
// tokens.ts — reverify tokens + nonce store
// ---------------------------------------------------------------------------

test('tokens: reverify token verifies with purpose and single-use nonce', () => {
  const now = 1_800_000_000_000;
  const store = new tokens.NonceStore(() => now);
  const token = tokens.signReverifyToken(SECRET, TENANT, 'reveal-mnemonic', now + 120_000, 'nonce-1');
  const options = { nonceStore: store, expectedPurpose: 'reveal-mnemonic', now };
  const payload = tokens.verifyReverifyToken(SECRET, TENANT, token, options);
  assert.deepEqual(payload, { t: TENANT, p: 'reveal-mnemonic', e: now + 120_000, n: 'nonce-1' });
  // Second verification with the same nonce fails (single use).
  assert.equal(tokens.verifyReverifyToken(SECRET, TENANT, token, options), null);
});

test('tokens: reverify token rejects wrong purpose and expiry before claiming nonce', () => {
  const now = 1_800_000_000_000;
  const store = new tokens.NonceStore(() => now);
  const otherPurpose = tokens.signReverifyToken(SECRET, TENANT, 'some-other-purpose', now + 120_000, 'nonce-p');
  assert.equal(
    tokens.verifyReverifyToken(SECRET, TENANT, otherPurpose, { nonceStore: store, expectedPurpose: 'reveal-mnemonic', now }),
    null,
  );
  // A wrong-purpose attempt must not consume the nonce either.
  const good = tokens.signReverifyToken(SECRET, TENANT, 'reveal-mnemonic', now + 120_000, 'nonce-p');
  assert.notEqual(tokens.verifyReverifyToken(SECRET, TENANT, good, { nonceStore: store, expectedPurpose: 'reveal-mnemonic', now }), null);
  const expired = tokens.signReverifyToken(SECRET, TENANT, 'reveal-mnemonic', now - 1, 'nonce-e');
  assert.equal(tokens.verifyReverifyToken(SECRET, TENANT, expired, { now }), null);
});

test('tokens: NonceStore claim semantics and lazy expiry sweep', () => {
  let now = 1_000;
  const store = new tokens.NonceStore(() => now);
  assert.equal(store.claim('n1', 2_000), true);
  assert.equal(store.claim('n1', 2_000), false, 'unexpired reuse rejected');
  now = 2_001; // past expiry
  assert.equal(store.claim('n1', 3_000), true, 'expired entry swept and reclaimable');
  assert.equal(store.size, 1);
});

// ---------------------------------------------------------------------------
// restrictions.ts — R-cwd / R-exec / R-cfg
// ---------------------------------------------------------------------------

test('restrictions: R-cwd rejects cwd outside the workspace root', (t) => {
  const { paths } = makeTenantTree(t);
  const entry = { tier: 'P1', restrictions: ['R-cwd'] };
  const check = (args) => restrictions.validateInvokeRestrictions('cowork:session:start', args, entry, paths);

  assert.equal(check([{ prompt: 'hi', cwd: '/etc' }]).code, 'ARG_RESTRICTED');
  assert.equal(check([{ prompt: 'hi', cwd: '../../escape' }]).code, 'ARG_RESTRICTED');
  assert.equal(check(['/etc']).code, 'ARG_RESTRICTED', 'bare positional string treated as cwd');

  const outside = path.join(path.dirname(paths.workspaceRoot), 'elsewhere', 'deep');
  const error = check([{ cwd: outside }]);
  assert.equal(error.code, 'ARG_RESTRICTED');
  assert.match(error.message, /workspace root/);
});

test('restrictions: R-cwd accepts cwd inside the workspace root, missing, and empty', (t) => {
  const { paths } = makeTenantTree(t);
  fs.mkdirSync(path.join(paths.workspaceRoot, 'project-a'), { recursive: true });
  const entry = { tier: 'P1', restrictions: ['R-cwd'] };
  const check = (args) => restrictions.validateInvokeRestrictions('cowork:session:start', args, entry, paths);

  assert.equal(check([{ prompt: 'hi', cwd: path.join(paths.workspaceRoot, 'project-a') }]), null);
  assert.equal(check([{ prompt: 'hi' }]), null, 'missing cwd defaults to workspace root');
  assert.equal(check([{ prompt: 'hi', cwd: '' }]), null, 'empty cwd defaults to workspace root');
  assert.equal(check([{ prompt: 'hi', cwd: null }]), null, 'null cwd defaults to workspace root');
  assert.equal(check([{ prompt: 'hi', cwd: paths.workspaceRoot }]), null, 'workspace root itself allowed');
  // scheduledTask:create/update: workingDirectory nested in the input object.
  const taskEntry = { tier: 'P1', restrictions: ['R-cwd', 'R-exec'] };
  assert.equal(
    restrictions.validateInvokeRestrictions('scheduledTask:create', [{ name: 'n', workingDirectory: paths.workspaceRoot }], taskEntry, paths),
    null,
  );
});

test('restrictions: scheduledTask:update checks its input, not the task ID, as cwd', (t) => {
  const { paths } = makeTenantTree(t);
  const entry = { tier: 'P1', restrictions: ['R-cwd', 'R-exec'] };
  const partialUpdate = { name: 'Edited task', prompt: 'Continue the work', schedule: { type: 'cron', expression: '0 9 * * *' } };
  assert.equal(
    restrictions.validateInvokeRestrictions('scheduledTask:update', ['gw-task-2', partialUpdate], entry, paths),
    null,
    'an opaque relative task ID is not a workspace path',
  );
  const outside = path.join(path.dirname(paths.workspaceRoot), 'outside-workspace');
  assert.equal(
    restrictions.validateInvokeRestrictions(
      'scheduledTask:update',
      ['gw-task-2', { ...partialUpdate, workingDirectory: outside }],
      entry,
      paths,
    ).code,
    'ARG_RESTRICTED',
    'the update payload still cannot escape the tenant workspace',
  );
});

test('restrictions: R-exec rejects sandbox execution mode', (t) => {
  const { paths } = makeTenantTree(t);
  const entry = { tier: 'P1', restrictions: ['R-exec'] };
  assert.equal(restrictions.validateInvokeRestrictions('scheduledTask:create', [{ executionMode: 'sandbox' }], entry, paths).code, 'ARG_RESTRICTED');
  assert.equal(restrictions.validateInvokeRestrictions('scheduledTask:create', [{ executionMode: 'auto' }], entry, paths), null);
  assert.equal(restrictions.validateInvokeRestrictions('scheduledTask:update', [{ executionMode: 'local' }], entry, paths), null);
});

test('restrictions: R-cfg allows only the 02 key set and applies R-cwd/R-exec to it', (t) => {
  const { paths } = makeTenantTree(t);
  const entry = { tier: 'P1', restrictions: ['R-cfg'] };
  const check = (args) => restrictions.validateInvokeRestrictions('cowork:config:set', args, entry, paths);

  assert.equal(check([{ memoryEnabled: false, memoryGuardLevel: 'strict', memoryUserMemoriesMaxItems: 10 }]), null);
  assert.equal(check([{ workingDirectory: paths.workspaceRoot }]), null);
  assert.equal(check([{ executionMode: 'auto' }]), null);
  assert.equal(check([{ lastWorkspaceSelection: null }]).code, 'ARG_RESTRICTED', 'unlisted key rejected');
  assert.equal(check([{ workingDirectory: '/etc' }]).code, 'ARG_RESTRICTED', 'workingDirectory under R-cwd');
  assert.equal(check([{ executionMode: 'sandbox' }]).code, 'ARG_RESTRICTED', 'executionMode under R-exec');
});

// ---------------------------------------------------------------------------
// restrictions.ts — R-path / R-upload with symlink escape
// ---------------------------------------------------------------------------

test('restrictions: R-path rejects paths outside dataRoot, including symlink escape', (t) => {
  const { base, paths } = makeTenantTree(t);
  const secretFile = path.join(base, 'secret.txt');
  fs.writeFileSync(secretFile, 'top secret');
  const symlink = path.join(paths.dataRoot, 'link.txt');
  fs.symlinkSync(secretFile, symlink);
  const insideFile = path.join(paths.dataRoot, 'ok.txt');
  fs.writeFileSync(insideFile, 'fine');

  const entry = { tier: 'P1', restrictions: ['R-path'] };
  const check = (args) => restrictions.validateInvokeRestrictions('fs:readTextFile', args, entry, paths);

  assert.equal(check([{ filePath: insideFile }]), null);
  assert.equal(check([{ filePath: '/etc/passwd' }]).code, 'ARG_RESTRICTED');
  assert.equal(check([{ filePath: symlink }]).code, 'ARG_RESTRICTED', 'symlink escape rejected via realpath');
  assert.equal(check([insideFile]), null, 'bare positional path allowed when inside');
  assert.equal(check(['relative/thing.txt']), null, 'relative paths are not absolute-looking, left to the handler');
});

test('restrictions: R-upload restricts to the uploads root', (t) => {
  const { paths } = makeTenantTree(t);
  const entry = { tier: 'P2', restrictions: ['R-upload'] };
  const dayDir = path.join(paths.uploadsRoot, '2026-10-20');
  const check = (args) => restrictions.validateInvokeRestrictions('knowledgeBase:importFiles', args, entry, paths);

  assert.equal(check([1, 'kb-1', [path.join(dayDir, 'note.txt')]]), null, 'nonexistent in-root path passes lexically');
  assert.equal(check([1, 'kb-1', [path.join(paths.dataRoot, 'outside-uploads.txt')]]).code, 'ARG_RESTRICTED');
  assert.equal(check([1, 'kb-1', ['/etc/passwd']]).code, 'ARG_RESTRICTED');
});

// ---------------------------------------------------------------------------
// restrictions.ts — R-store
// ---------------------------------------------------------------------------

test('restrictions: R-store accepts only app_config and always rejects remove', (t) => {
  const { paths } = makeTenantTree(t);
  const entry = { tier: 'P1', restrictions: ['R-store'] };
  assert.equal(restrictions.validateInvokeRestrictions('store:get', ['app_config'], entry, paths), null);
  assert.equal(restrictions.validateInvokeRestrictions('store:set', ['app_config', {}], entry, paths), null);
  assert.equal(restrictions.validateInvokeRestrictions('store:get', ['other_key'], entry, paths).code, 'ARG_RESTRICTED');
  assert.equal(restrictions.validateInvokeRestrictions('store:get', [], entry, paths).code, 'ARG_RESTRICTED', 'missing key rejected');
  assert.equal(restrictions.validateInvokeRestrictions('store:remove', ['app_config'], entry, paths).code, 'ARG_RESTRICTED');
  assert.equal(restrictions.validateInvokeRestrictions('store:remove', ['anything'], entry, paths).code, 'ARG_RESTRICTED');
});

test('restrictions: redactAppConfig replaces every providers.*.apiKey and clones deeply', () => {
  const stored = {
    providers: {
      deepseek: { apiKey: 'sk-real-secret', baseUrl: 'https://api.deepseek.com', apiFormat: 'openai' },
      anthropic: { apiKey: 'sk-ant-secret', baseUrl: 'https://api.anthropic.com', apiFormat: 'anthropic' },
    },
    theme: 'dark',
  };
  const redacted = restrictions.redactAppConfig(stored);
  assert.equal(redacted.providers.deepseek.apiKey, '__redacted__');
  assert.equal(redacted.providers.anthropic.apiKey, '__redacted__');
  assert.equal(redacted.providers.deepseek.baseUrl, 'https://api.deepseek.com');
  assert.equal(redacted.theme, 'dark');
  assert.equal(stored.providers.deepseek.apiKey, 'sk-real-secret', 'input must not be mutated');
  assert.notEqual(redacted.providers, stored.providers, 'deep clone, no shared references');
  assert.equal(restrictions.redactAppConfig(null), null);
});

test('restrictions: mergeAppConfigSet pins apiKey/baseUrl/apiFormat and rejects provider add/remove', () => {
  const stored = {
    providers: {
      deepseek: { apiKey: 'stored-key', baseUrl: 'https://stored.example', apiFormat: 'openai', enabled: true },
    },
    theme: 'dark',
  };
  const incoming = {
    providers: {
      deepseek: { apiKey: 'hacked-key', baseUrl: 'https://evil.example', apiFormat: 'anthropic', enabled: false },
    },
    theme: 'light',
  };
  const merged = restrictions.mergeAppConfigSet(stored, incoming);
  assert.deepEqual(merged, {
    providers: {
      deepseek: { apiKey: 'stored-key', baseUrl: 'https://stored.example', apiFormat: 'openai', enabled: false },
    },
    theme: 'light',
  });

  // Added provider.
  assert.equal(
    restrictions.mergeAppConfigSet(stored, { providers: { ...incoming.providers, newp: { apiKey: 'x' } } }),
    null,
  );
  // Removed provider.
  assert.equal(restrictions.mergeAppConfigSet(stored, { providers: {} }), null);
  // Incoming providers not an object.
  assert.equal(restrictions.mergeAppConfigSet(stored, { providers: 'nope' }), null);
  // Incoming not an object at all.
  assert.equal(restrictions.mergeAppConfigSet(stored, 'nope'), null);
  // Providers omitted in incoming: stored providers kept verbatim.
  const partial = restrictions.mergeAppConfigSet(stored, { theme: 'light' });
  assert.deepEqual(partial.providers, stored.providers);
});

// ---------------------------------------------------------------------------
// fileSign.ts
// ---------------------------------------------------------------------------

test('fileSign: signs a confined file with size, mime, and 10-minute expiry', (t) => {
  const { paths } = makeTenantTree(t);
  const reportPath = path.join(paths.dataRoot, 'docs', 'report.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, '# hello\n');

  const now = 1_800_000_000_000;
  const result = fileSign.signFileDownload(
    { secret: SECRET, tenantId: TENANT, paths, realpathSync: fs.realpathSync },
    { path: reportPath },
    now,
  );
  assert.equal(fileSign.isSignedFileDownload(result), true);
  assert.ok(result.url.startsWith(`${fileSign.FILE_ROUTE_PATH_PREFIX}/`));
  assert.equal(result.size, 8);
  assert.equal(result.mime, 'text/markdown');
  assert.equal(result.expiresAt, now + 10 * 60 * 1000);

  const token = result.url.slice(fileSign.FILE_ROUTE_PATH_PREFIX.length + 1);
  const payload = tokens.verifyFileToken(SECRET, TENANT, token, now + 1);
  assert.equal(payload.p, fs.realpathSync(reportPath));
  assert.equal(payload.d, 'attachment');
  assert.equal(payload.t, TENANT);
});

test('fileSign: inline disposition, extension map, and octet-stream default', (t) => {
  const { paths } = makeTenantTree(t);
  fs.writeFileSync(path.join(paths.dataRoot, 'a.png'), 'png-bytes');
  fs.writeFileSync(path.join(paths.dataRoot, 'b.weird'), 'mystery');

  const now = 1_800_000_000_000;
  const deps = { secret: SECRET, tenantId: TENANT, paths, realpathSync: fs.realpathSync };
  const inline = fileSign.signFileDownload(deps, { path: path.join(paths.dataRoot, 'a.png'), disposition: 'inline' }, now);
  assert.equal(inline.mime, 'image/png');
  const token = inline.url.slice(fileSign.FILE_ROUTE_PATH_PREFIX.length + 1);
  assert.equal(tokens.verifyFileToken(SECRET, TENANT, token, now + 1).d, 'inline');

  const unknown = fileSign.signFileDownload(deps, { path: path.join(paths.dataRoot, 'b.weird') }, now);
  assert.equal(unknown.mime, 'application/octet-stream');

  const htmlPath = path.join(paths.dataRoot, 'index.html');
  fs.writeFileSync(htmlPath, '<html><body>MetaApp</body></html>');
  const inlineHtml = fileSign.signFileDownload(deps, { path: htmlPath, disposition: 'inline' }, now);
  assert.equal(inlineHtml.mime, 'text/html; charset=utf-8');
  const attachmentHtml = fileSign.signFileDownload(deps, { path: htmlPath }, now);
  assert.equal(attachmentHtml.mime, 'application/octet-stream');
});

test('fileSign: ARG_RESTRICTED on symlink escape, outside path, and unresolvable path', (t) => {
  const { base, paths } = makeTenantTree(t);
  const outside = path.join(base, 'outside.md');
  fs.writeFileSync(outside, 'nope');
  const symlink = path.join(paths.dataRoot, 'escape.md');
  fs.symlinkSync(outside, symlink);

  const deps = { secret: SECRET, tenantId: TENANT, paths, realpathSync: fs.realpathSync };
  const escape = fileSign.signFileDownload(deps, { path: symlink });
  assert.equal(escape.code, 'ARG_RESTRICTED');
  const outsideResult = fileSign.signFileDownload(deps, { path: outside });
  assert.equal(outsideResult.code, 'ARG_RESTRICTED');
  const missing = fileSign.signFileDownload(deps, { path: path.join(paths.dataRoot, 'gone.md') });
  assert.equal(missing.code, 'ARG_RESTRICTED');
  const empty = fileSign.signFileDownload(deps, { path: '   ' });
  assert.equal(empty.code, 'INVALID_ARGS');
});

// ---------------------------------------------------------------------------
// upload.ts
// ---------------------------------------------------------------------------

test('upload: sanitizeUploadName strips traversal and control chars, keeps unicode', () => {
  assert.equal(upload.sanitizeUploadName('../../x.txt'), 'x.txt');
  assert.equal(upload.sanitizeUploadName('a/b/c.png'), 'c.png');
  assert.equal(upload.sanitizeUploadName('a\\b\\c.png'), 'c.png', 'backslash traversal stripped');
  assert.equal(upload.sanitizeUploadName('  '), 'file');
  assert.equal(upload.sanitizeUploadName(''), 'file');
  assert.equal(upload.sanitizeUploadName(String.fromCharCode(0) + String.fromCharCode(31)), 'file', 'control chars');
  assert.equal(upload.sanitizeUploadName('tab\tname.txt'), 'tabname.txt', 'control chars stripped inside');
  assert.equal(upload.sanitizeUploadName('résumé 照片.pdf'), 'résumé 照片.pdf', 'unicode kept');
  assert.equal(upload.sanitizeUploadName('normal name.jpg'), 'normal name.jpg');
});

test('upload: isBlockedUploadType blocks executables by extension and MIME', () => {
  assert.equal(upload.isBlockedUploadType('evil.exe'), true);
  assert.equal(upload.isBlockedUploadType('evil.EXE'), true);
  assert.equal(upload.isBlockedUploadType('run.sh'), true);
  assert.equal(upload.isBlockedUploadType('script.ps1'), true);
  assert.equal(upload.isBlockedUploadType('app.app'), true);
  assert.equal(upload.isBlockedUploadType('notes.txt'), false);
  assert.equal(upload.isBlockedUploadType('archive.zip'), false);
  assert.equal(upload.isBlockedUploadType('data.bin', 'application/x-executable'), true);
  assert.equal(upload.isBlockedUploadType('data.bin', 'application/x-msdownload; charset=binary'), true);
  assert.equal(upload.isBlockedUploadType('data.bin', 'application/octet-stream'), false);
  assert.equal(upload.isBlockedUploadType('photo.png', 'image/png'), false);
});

test('upload: target path layout and size limit', () => {
  const target = upload.uploadTargetPath('/data/workspace/uploads', 'photo.jpg', new Date(2026, 9, 20, 8, 30), 'uuid-1');
  assert.equal(target, path.join('/data/workspace/uploads', '2026-10-20', 'uuid-1-photo.jpg'));
  const weird = upload.uploadTargetPath('/data/workspace/uploads', '../../evil.exe', new Date(2026, 0, 5), 'u2');
  assert.equal(weird, path.join('/data/workspace/uploads', '2026-01-05', 'u2-evil.exe'), 'name sanitized in layout');
  assert.equal(upload.UPLOAD_MAX_BYTES, 25 * 1024 * 1024);
});

// ---------------------------------------------------------------------------
// readiness.ts
// ---------------------------------------------------------------------------

function readinessState(overrides = {}) {
  return {
    phase: 'ready',
    version: '0.12.0',
    commit: '1a2b3c4',
    contractVersion: '1.0.0',
    onboarding: {
      identity: 'done',
      llmProvider: 'done',
      twinMetabot: 'done',
      workspace: 'done',
      trafficAccount: 'done',
      redeemCode: 'skipped',
      globalMetaId: 'idq1abc',
      twinMetabotId: 1,
    },
    error: null,
    ...overrides,
  };
}

test('readiness: ready and degraded map to 200, everything else to 503', () => {
  const ready = readiness.buildReadinessResponse(readinessState());
  assert.equal(ready.status, 200);
  assert.equal(ready.body.ready, true);
  assert.equal(ready.body.error, null);
  assert.equal(ready.body.phase, 'ready');

  const degraded = readiness.buildReadinessResponse(readinessState({
    phase: 'degraded',
    error: { step: 'redeemCode', message: 'invalid code' },
  }));
  assert.equal(degraded.status, 200);
  assert.equal(degraded.body.ready, true);
  assert.deepEqual(degraded.body.error, { step: 'redeemCode', message: 'invalid code' });

  for (const phase of ['starting', 'migrating', 'bootstrapping', 'stopping', 'failed']) {
    const response = readiness.buildReadinessResponse(readinessState({ phase }));
    assert.equal(response.status, 503, `${phase} must be 503`);
    assert.equal(response.body.ready, false, `${phase} must report ready:false`);
    assert.equal(response.body.phase, phase);
  }

  assert.deepEqual(Object.keys(ready.body), ['ready', 'phase', 'version', 'commit', 'contractVersion', 'onboarding', 'error']);
});

// ---------------------------------------------------------------------------
// sanitize.ts — extraction smoke test (REQ-A-29: gateway shares the limits)
// ---------------------------------------------------------------------------

test('sanitize: extracted module keeps the IPC payload limits', () => {
  assert.equal(sanitize.IPC_UPDATE_CONTENT_MAX_CHARS, 120_000);
  assert.equal(sanitize.IPC_STRING_MAX_CHARS, 4_000);
  const long = 'x'.repeat(5_000);
  const out = sanitize.sanitizeIpcPayload({ content: long, n: 7, ok: true });
  assert.equal(out.n, 7);
  assert.equal(out.ok, true);
  assert.equal(out.content.length, 4_000 + '\n...[truncated in main IPC forwarding]'.length);
  assert.ok(out.content.endsWith('[truncated in main IPC forwarding]'));
  assert.equal(sanitize.truncateIpcString('short', 10), 'short');
});
