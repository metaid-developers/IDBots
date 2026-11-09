import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const taskFormPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'scheduledTasks',
  'TaskForm.tsx'
);

const taskDetailPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'scheduledTasks',
  'TaskDetail.tsx'
);

const i18nPath = path.join(projectRoot, 'src', 'renderer', 'services', 'i18n.ts');

const SESSION_KEYS = [
  'scheduledTasksFormSession',
  'scheduledTasksFormSessionSeries',
  'scheduledTasksFormSessionSeriesHint',
  'scheduledTasksFormSessionNew',
  'scheduledTasksFormSessionNewHint',
  'scheduledTasksFormSessionCurrent',
  'scheduledTasksFormSessionCustom',
  'scheduledTasksFormSessionIdPlaceholder',
  'scheduledTasksFormSessionFallbackHint',
  'scheduledTasksDetailSessionSeries',
  'scheduledTasksDetailSessionFresh',
];

test('scheduled task form lets the user bind the task to a conversation', () => {
  const source = fs.readFileSync(taskFormPath, 'utf8');

  assert.match(source, /type SessionMode = 'series' \| 'new' \| 'current' \| 'custom'/);
  assert.match(source, /useState<SessionMode>\(initialSessionMode\)/);
  assert.match(source, /setSessionMode\(e\.target\.value as SessionMode\)/);
  assert.match(source, /scheduledTasksFormSessionSeries/);
  assert.match(source, /scheduledTasksFormSessionNew/);
  assert.match(source, /scheduledTasksFormSessionCurrent/);
  assert.match(source, /scheduledTasksFormSessionCustom/);
  assert.match(source, /disabled=\{currentSessionId == null\}/);
  assert.match(source, /state\.cowork\.currentSessionId/);
});

test('scheduled task form shows the custom session input with the fallback hint', () => {
  const source = fs.readFileSync(taskFormPath, 'utf8');

  assert.match(source, /const \[customSessionId, setCustomSessionId\] = useState/);
  assert.match(source, /sessionMode === 'custom' &&/);
  assert.match(source, /scheduledTasksFormSessionIdPlaceholder/);
  assert.match(source, /scheduledTasksFormSessionFallbackHint/);
});

test('scheduled task form submits the resolved targetSessionId and session mode', () => {
  const source = fs.readFileSync(taskFormPath, 'utf8');

  assert.match(source, /resolveTargetSessionId/);
  assert.match(source, /sessionMode === 'current'\)\s*return currentSessionId \?\? null/);
  assert.match(source, /sessionMode === 'custom'\)\s*return customSessionId\.trim\(\) \|\| null/);
  assert.match(source, /targetSessionId:\s*resolveTargetSessionId\(\)/);
  // 'new' maps to the stored 'fresh' opt-out; every other choice is 'series'.
  assert.match(source, /resolveSessionMode/);
  assert.match(source, /sessionMode === 'new' \? 'fresh' : 'series'/);
  assert.match(source, /sessionMode:\s*resolveSessionMode\(\)/);
});

test('scheduled task detail displays the bound conversation, the standing conversation, or the fresh mode', () => {
  const source = fs.readFileSync(taskDetailPath, 'utf8');

  assert.match(source, /boundSessionTitle/);
  assert.match(source, /state\.cowork\.sessions/);
  assert.match(source, /session\.id === task\.targetSessionId/);
  assert.match(source, /task\.targetSessionId/);
  assert.match(source, /scheduledTasksDetailSessionFresh/);
  assert.match(source, /scheduledTasksDetailSessionSeries/);
  assert.match(source, /task\.seriesSessionId/);
});

test('i18n defines the conversation binding keys in both languages', () => {
  const source = fs.readFileSync(i18nPath, 'utf8');
  const enBlockStart = source.indexOf('\n  en: {');
  assert.ok(enBlockStart > 0, 'expected an en translation block');

  const zhBlock = source.slice(0, enBlockStart);
  const enBlock = source.slice(enBlockStart);

  for (const key of SESSION_KEYS) {
    assert.match(zhBlock, new RegExp(`\\b${key}:\\s*'`), `missing zh translation for ${key}`);
    assert.match(enBlock, new RegExp(`\\b${key}:\\s*'`), `missing en translation for ${key}`);
  }

  assert.match(zhBlock, /scheduledTasksFormSessionFallbackHint: '[^']*归档/);
  assert.match(enBlock, /scheduledTasksFormSessionFallbackHint: '[^']*archived/);
});
