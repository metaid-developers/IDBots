import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const managerPath = path.join(projectRoot, 'src', 'renderer', 'components', 'metabots', 'MetabotsManager.tsx');
const formPath = path.join(projectRoot, 'src', 'renderer', 'components', 'metabots', 'MetaBotForm.tsx');

test('MetaBot form uses an empty boss id by default', () => {
  const source = fs.readFileSync(formPath, 'utf8');

  assert.match(source, /const defaultValues:[\s\S]*boss_id:\s*''/);
  assert.doesNotMatch(source, /const defaultValues:[\s\S]*boss_id:\s*'1'/);
});

test('MetaBot edit form preserves a null boss id as an empty field', () => {
  const source = fs.readFileSync(managerPath, 'utf8');

  assert.match(source, /boss_id:\s*editMetabot\.boss_id != null \? String\(editMetabot\.boss_id\) : ''/);
  assert.doesNotMatch(source, /boss_id:\s*editMetabot\.boss_id != null \? String\(editMetabot\.boss_id\) : '1'/);
});
