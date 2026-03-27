import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const packageJsonPath = path.join(process.cwd(), 'package.json');
const skillManagerPath = path.join(process.cwd(), 'src', 'main', 'skillManager.ts');

test('skillManager runtime YAML parser must be declared as production dependency', () => {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const skillManagerSource = fs.readFileSync(skillManagerPath, 'utf8');

  assert.match(
    skillManagerSource,
    /from 'js-yaml'/,
    'Expected skillManager to import js-yaml for frontmatter parsing',
  );

  assert.ok(
    packageJson.dependencies && packageJson.dependencies['js-yaml'],
    'js-yaml must be in dependencies so packaged app can load skillManager at runtime',
  );
});
