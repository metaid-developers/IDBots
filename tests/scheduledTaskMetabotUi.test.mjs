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

test('scheduled task form lets the user choose the execution MetaBot', () => {
  const source = fs.readFileSync(taskFormPath, 'utf8');

  assert.match(source, /window\.electron\?\.metabot\?\.list\?\.\(\)/);
  assert.match(source, /setSelectedMetabotId/);
  assert.match(source, /scheduledTasksFormMetabot/);
  assert.match(source, /metabotId:\s*selectedMetabotId/);
  assert.doesNotMatch(source, /metabotId:\s*defaultMetabotId/);
});

test('scheduled task detail displays the configured execution MetaBot', () => {
  const source = fs.readFileSync(taskDetailPath, 'utf8');

  assert.match(source, /scheduledTasksDetailMetabot/);
  assert.match(source, /metabotNameById/);
  assert.match(source, /task\.metabotId/);
});
