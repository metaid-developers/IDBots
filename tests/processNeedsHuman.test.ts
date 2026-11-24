// 浮窗化 · 第 4 步 写端 (owner approval 2026-11-24 17:23; M6=A / M7=A / N1-N3 / N7 / N8).
//
// Order matters and this suite pins it: the WRITE side is fixed BEFORE the UI.
// What must not silently regress:
//   1. the gate — a normal completion writes NOTHING; only a human-next-step
//      completion writes ONE process.needs_human row;
//   2. the verdict — the authoring bot's declaration decides, objective wait
//      states are the only host fallback (M7=A);
//   3. the digest — <userData>/process-digest/<taskId>/<stamp>.html with
//      结论 / 证据 / 建议下一步, and its preview-metaapp URI rides the payload;
//   4. the click route — artifact → session + showcase tab + composer focus;
//   5. the waiting-state hook — waiting_external had no exit before N7.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROCESS_NEEDS_HUMAN_REASONS,
  buildProcessDigestHtml,
  parseFollowUpDeclarationWithReason,
  processDigestFilePath,
  resolveProcessNeedsHuman,
  writeProcessDigest,
} from '../src/main/services/processNeedsHuman';
import {
  classifyNotification,
  resolveNotificationJump,
} from '../src/renderer/utils/notificationCenter';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/* ═════════════ 1. the declaration parser (the bot's own words) ═════════════ */

test('declaration: the LAST tag wins, and the reason tail is extracted', () => {
  assert.deepEqual(parseFollowUpDeclarationWithReason('done [FOLLOW_UP: none]'), { verdict: 'none', reason: null });
  assert.deepEqual(
    parseFollowUpDeclarationWithReason('report\n[FOLLOW_UP: owner — approve the 3 candidate covers]'),
    { verdict: 'owner', reason: 'approve the 3 candidate covers' },
  );
  assert.deepEqual(
    parseFollowUpDeclarationWithReason('[FOLLOW_UP: none] then [FOLLOW_UP: owner: pick A or B]'),
    { verdict: 'owner', reason: 'pick A or B' },
    'a later tag supersedes the earlier one (the contract says so)',
  );
  assert.equal(parseFollowUpDeclarationWithReason('no tag here'), null);
  assert.equal(parseFollowUpDeclarationWithReason(null), null);
});

/* ═════════════ 2. the verdict (M7=A) ═════════════ */

const baseFacts = {
  outcome: 'completed' as const,
  declaration: null,
  declarationReason: null,
  followUpState: null,
  pendingPermission: false,
  openDecision: false,
  overrun: false,
};

test('gate: a normal completion owes nothing — needsHuman=false (N8 no-spam branch)', () => {
  assert.deepEqual(resolveProcessNeedsHuman({ ...baseFacts }), { needsHuman: false, reason: null, nextStep: null });
  assert.deepEqual(
    resolveProcessNeedsHuman({ ...baseFacts, declaration: 'none' }),
    { needsHuman: false, reason: null, nextStep: null },
    'an explicit none is authoritative when no objective blocker exists',
  );
});

test('gate: the bot declaring owner → decision, carrying its own next step', () => {
  const verdict = resolveProcessNeedsHuman({
    ...baseFacts,
    declaration: 'owner',
    declarationReason: 'approve the cover',
  });
  assert.deepEqual(verdict, { needsHuman: true, reason: 'decision', nextStep: 'approve the cover' });
});

test('gate: objective wait states outrank the bot’s words (host fallback only)', () => {
  assert.equal(resolveProcessNeedsHuman({ ...baseFacts, pendingPermission: true }).reason, 'permission');
  assert.equal(resolveProcessNeedsHuman({ ...baseFacts, openDecision: true }).reason, 'decision');
  assert.equal(resolveProcessNeedsHuman({ ...baseFacts, followUpState: 'pending' }).reason, 'waiting_owner');
  assert.equal(resolveProcessNeedsHuman({ ...baseFacts, overrun: true }).reason, 'overrun');
  // A declared `none` cannot suppress a live approval prompt.
  assert.equal(
    resolveProcessNeedsHuman({ ...baseFacts, declaration: 'none', pendingPermission: true }).reason,
    'permission',
  );
});

test('gate: failures never pass through the resolver (they keep work.failed)', () => {
  assert.deepEqual(
    resolveProcessNeedsHuman({ ...baseFacts, outcome: 'failed', declaration: 'owner' }),
    { needsHuman: false, reason: null, nextStep: null },
  );
  assert.deepEqual([...PROCESS_NEEDS_HUMAN_REASONS], [
    'overrun',
    'waiting_owner',
    'waiting_external',
    'permission',
    'decision',
  ]);
});

/* ═════════════ 3. the digest (N3 / M6=A) ═════════════ */

test('digest: three sections in the owner’s order, escaped, self-contained', () => {
  const html = buildProcessDigestHtml({
    title: 'Cover candidates <A&B>',
    conclusion: 'Three candidates ready.\nRecommend B.',
    evidence: ['pin://abc', 'metafile://def'],
    nextSteps: ['pick A or B'],
    language: 'zh',
    meta: { sessionId: 's-1', taskId: 'ltt_1', reason: 'decision', generatedAt: 1_700_000_000_000 },
  });
  assert.match(html, /data-digest-section="conclusion"/);
  assert.match(html, /data-digest-section="evidence"/);
  assert.match(html, /data-digest-section="next"/);
  assert.ok(html.indexOf('data-digest-section="conclusion"') < html.indexOf('data-digest-section="evidence"'));
  assert.ok(html.indexOf('data-digest-section="evidence"') < html.indexOf('data-digest-section="next"'));
  assert.match(html, /Cover candidates &lt;A&amp;B&gt;/, 'the title is escaped');
  assert.match(html, /pin:\/\/abc/);
  assert.match(html, /需要你决定/, 'the reason is rendered in the owner language');
  assert.doesNotMatch(html, /<script/i, 'no script — a digest is a document, not an app');
  assert.doesNotMatch(html, /https?:\/\//, 'no external asset — it must render offline');
});

test('digest: missing evidence / next step is said honestly, never padded', () => {
  const html = buildProcessDigestHtml({
    title: 'T',
    conclusion: 'Done.',
    evidence: [],
    nextSteps: [],
    language: 'en',
    meta: { sessionId: 's' },
  });
  assert.match(html, /The authoring bot recorded no evidence entry/);
  assert.match(html, /No extra action declared/);
});

test('digest: lands at <userData>/process-digest/<taskId>/<stamp>.html with a preview URI', () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'process-digest-'));
  try {
    const result = writeProcessDigest({
      userDataDir,
      taskKey: 'ltt_abc-123',
      stamp: '1700000000000',
      html: '<html>digest</html>',
    });
    assert.equal(
      result.filePath,
      path.join(userDataDir, 'process-digest', 'ltt_abc-123', '1700000000000.html'),
    );
    assert.equal(fs.readFileSync(result.filePath, 'utf8'), '<html>digest</html>');
    assert.match(result.artifactUri, /^preview-metaapp:\/\/localhost\//);
    assert.ok(result.artifactUri.includes('process-digest'));
    // The path builder is the same one the writer uses.
    assert.equal(
      processDigestFilePath(userDataDir, 'ltt_abc-123', '1700000000000'),
      result.filePath,
    );
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('digest: unsafe task keys are folded into one path segment', () => {
  const filePath = processDigestFilePath('/tmp/u', '../../etc/passwd', 'a/b');
  // Everything folds into ONE segment under process-digest — no separator from
  // the caller survives, so the write can never leave the digest directory.
  const digestRoot = path.join('/tmp/u', 'process-digest') + path.sep;
  assert.ok(path.resolve(filePath).startsWith(path.resolve(digestRoot)), 'stays under process-digest');
  assert.equal(path.relative(digestRoot, filePath).split(path.sep).length, 2, 'task segment + stamp file');
  assert.ok(filePath.endsWith('.html'));
});

/* ═════════════ 4. the write-side wiring (N8 → N1 → N7) ═════════════ */

test('N8: main.ts gates the completed terminal BEFORE writing any notification', () => {
  const main = readSource('src/main/main.ts');
  const fn = main.slice(
    main.indexOf('const recordCoworkTerminalNotification'),
    main.indexOf('const getDailyReportStore'),
  );
  // failed keeps its own row…
  assert.match(fn, /if \(outcome === 'failed'\) \{[\s\S]{0,300}recordCoworkTerminal\(/);
  // …completed resolves the verdict, and the no-human branch RETURNS (ledger only).
  assert.match(fn, /const verdict = resolveProcessNeedsHuman\(\{/);
  assert.match(fn, /if \(!verdict\.needsHuman\) \{[\s\S]{0,220}return;/);
  // The surviving row is the new type, carrying the digest when one was written.
  assert.match(fn, /getNotificationService\(\)\.recordProcessNeedsHuman\(\{/);
  assert.match(fn, /artifactUri,/);
  // The conclusion is the BOT's own closing message (host never authors it).
  assert.match(fn, /const conclusion = lastAssistantText/);
  assert.match(fn, /replace\(\/\\\[FOLLOW_UP:\[\^\\\]\]\*\\\]\/gi, ''\)/);
});

test('N1: the notification type + reason enum + artifact target are declared', () => {
  const service = readSource('src/main/services/notificationService.ts');
  assert.match(service, /type: 'process\.needs_human'/);
  assert.match(service, /reason: ProcessNeedsHumanReason/);
  assert.match(service, /kind: 'artifact'/);
  const types = readSource('src/renderer/types/notification.ts');
  assert.match(types, /\{ kind: 'artifact'; artifactUri: string; sessionId: string \| null; taskId\?: string \| null \}/);
});

test('N7: waiting_external now has a notification exit (single writer, no duplicate)', () => {
  const main = readSource('src/main/main.ts');
  const hook = main.slice(main.indexOf("change.status === 'waiting_external'"), main.indexOf("change.status === 'waiting_owner'"));
  assert.match(hook, /recordProcessNeedsHuman\(\{/);
  assert.match(hook, /reason: 'waiting_external'/);
  // The waiting_owner row stays on recordLongTermTask — no second row for it.
  const after = main.slice(main.indexOf("change.status === 'waiting_owner'"));
  assert.match(after, /recordLongTermTask\(\{/);
});

/* ═════════════ 5. the click route (N2 / 态3) ═════════════ */

test('classify: process.needs_human is a decision row, not a completion row', () => {
  assert.equal(classifyNotification('process.needs_human'), 'decision');
  assert.equal(classifyNotification('work.completed'), 'completed');
});

test('jump: an artifact target maps to session + artifactUri; a sessionless one degrades to null', () => {
  assert.deepEqual(
    resolveNotificationJump({ kind: 'artifact', artifactUri: 'preview-metaapp://localhost/x', sessionId: 's-1' }),
    { kind: 'artifact', sessionId: 's-1', artifactUri: 'preview-metaapp://localhost/x' },
  );
  assert.equal(
    resolveNotificationJump({ kind: 'artifact', artifactUri: 'preview-metaapp://localhost/x', sessionId: null }),
    null,
  );
});

test('the click route opens the session, navigates the SHOWCASE tab, then focuses the composer', () => {
  const center = readSource('src/renderer/components/notifications/NotificationCenter.tsx');
  const branch = center.slice(center.indexOf("jump.kind === 'artifact'"), center.indexOf('} else {'));
  assert.match(branch, /cowork:viewSession/);
  assert.match(branch, /sessionTabBinding\.controlSessionTab\(\{[\s\S]{0,200}action: 'navigate-tab'[\s\S]{0,120}role: 'showcase'/);
  assert.match(branch, /cowork:focusComposer/);
  // The composer listens on the SAME event and matches the session scope.
  const composer = readSource('src/renderer/components/cowork/CoworkPromptInput.tsx');
  assert.match(composer, /window\.addEventListener\('cowork:focusComposer', onFocusComposer\)/);
  assert.match(composer, /requestAnimationFrame\(\(\) => textareaRef\.current\?\.focus\(\)\)/);
});

test('mobile: an artifact notification lands on its conversation (no showcase there)', () => {
  const routes = readSource('src/mobile/app/notifications/notificationRoutes.ts');
  assert.match(routes, /if \(target\.kind === 'artifact'\) \{[\s\S]{0,200}\/app\/sessions\//);
  const app = readSource('src/mobile/app/MobileApp.tsx');
  assert.match(app, /if \(target\.kind === 'artifact'\) \{[\s\S]{0,400}openWorkSession/);
});

/* ═════════════ 6. i18n parity for the new notification copy ═════════════ */

test('i18n: the needs_human copy exists in both languages', () => {
  const service = readSource('src/main/services/notificationService.ts');
  const zh = service.slice(service.indexOf('  zh: {'));
  const en = service.slice(service.indexOf('  en: {'), service.indexOf('  zh: {'));
  for (const key of ['needsHuman:', 'needsHumanBody:']) {
    assert.ok(zh.includes(key), `zh has ${key}`);
    assert.ok(en.includes(key), `en has ${key}`);
  }
});
