import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

function skillFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return skillFiles(entryPath);
    return entry.name === 'SKILL.md' ? [entryPath] : [];
  });
}

test('every official skill has parseable YAML frontmatter', () => {
  const failures = [];
  for (const file of skillFiles('SKILLs')) {
    const source = fs.readFileSync(file, 'utf8');
    const match = source.match(/^---\n([\s\S]*?)\n---/);
    if (!match) {
      failures.push(`${file}: missing frontmatter`);
      continue;
    }
    try {
      const frontmatter = yaml.load(match[1]);
      assert.equal(typeof frontmatter.name, 'string');
      assert.equal(typeof frontmatter.description, 'string');
    } catch (error) {
      failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  assert.deepEqual(failures, []);
});
