// Static guard for the accent-fill legibility rule: NO element may render
// white text/icons on the yellow accent fill (bg-claude-accent). White on
// #FFDC51 is nearly illegible; content on the accent fill must use the
// near-black accentInk token (#303133, matching .btn-idchat-primary-filled).
// The old composer send/stop deep-orange-on-yellow exception was retired on
// 2026-10-23: those buttons are now neutral gray with dark-gray ink, and as of
// the 2026-11-14 flat-shape sweep (feat/flat-buttons-sweep) they are flat
// rounded-[var(--shape-radius-md)] rectangles with no shadow.
// Semantic error fills (red/green) keep their white text and are out of scope.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const rendererRoot = join(here, '../src/renderer');

const collectSourceFiles = (dir) => {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (/\.(tsx|ts)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
};

test('no white text shares a className line with the yellow accent fill', () => {
  const offenders = [];
  for (const file of collectSourceFiles(rendererRoot)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (line.includes('bg-claude-accent') && /\btext-white\b/.test(line)) {
        offenders.push(`${file.replace(rendererRoot + '/', '')}:${index + 1}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    'yellow-fill lines must use text-claude-accentInk, not text-white (white on #FFDC51 is illegible)',
  );
});

test('accentInk token is defined and is the shared near-black on yellow', () => {
  const tailwind = readFileSync(join(here, '../tailwind.config.js'), 'utf8');
  assert.match(tailwind, /accentInk: '#303133'/);
  // The shared filled-button class keeps the same ink color.
  const css = readFileSync(join(here, '../src/renderer/index.css'), 'utf8');
  const filled = css.slice(css.indexOf('.btn-idchat-primary-filled'));
  assert.match(filled.slice(0, 200), /color: #303133/);
});

test('composer send/stop buttons use the neutral flat rectangle with dark-gray ink', () => {
  const composer = readFileSync(
    join(here, '../src/renderer/components/cowork/CoworkPromptInput.tsx'),
    'utf8',
  );
  // Every composer send/stop className pins the flat radius-token rectangle + dark-ink style.
  assert.equal(
    (composer.match(/rounded-\[var\(--shape-radius-md\)\] bg-claude-surfaceHover hover:bg-claude-border text-claude-text/g) || []).length,
    4,
  );
  // ...and the retired capsule shape never comes back on those buttons.
  assert.equal(
    (composer.match(/p-2 rounded-full bg-claude-surfaceHover/g) || []).length,
    0,
  );
  // ...and the retired yellow fill + deep-orange ink never comes back.
  assert.doesNotMatch(composer, /bg-claude-accent hover:bg-claude-accentHover text-\[#9A3412\]/);
});
