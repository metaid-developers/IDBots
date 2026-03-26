import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const markdownContentPath = path.join(process.cwd(), 'src/renderer/components/MarkdownContent.tsx');
const markdownContentSource = fs.readFileSync(markdownContentPath, 'utf8');

test('plain fenced code blocks keep a readable light foreground on the fixed dark surface', () => {
  assert.match(markdownContentSource, /bg-\[#282c34\]/);
  assert.match(markdownContentSource, /text-slate-100/);
  assert.doesNotMatch(
    markdownContentSource,
    /<code className="block px-4 py-3 font-mono text-claude-darkText whitespace-pre">/,
  );
});

test('large language code block fallback uses the same readable foreground', () => {
  assert.match(markdownContentSource, /<code className="block px-4 py-3 font-mono text-slate-100 whitespace-pre">/);
  assert.doesNotMatch(
    markdownContentSource,
    /<code className="block px-4 py-3 font-mono text-claude-darkText whitespace-pre">/,
  );
});
