import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SURFACE_MODE_CHANGE_EVENT,
  SURFACE_MODE_STORAGE_KEY_MIRROR,
  chatExperienceModeForSurface,
  readActiveSurfaceMode,
} from '../src/renderer/hooks/chatExperienceModeSource';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shellSource = fs.readFileSync(
  path.join(root, 'src/renderer/features/botBrowser/useBotBrowserShell.ts'),
  'utf8',
);

test('the mirrored storage-key literal matches the shell that owns the slot', () => {
  // chatExperienceModeSource keeps a literal copy of the shell's
  // SURFACE_MODE_STORAGE_KEY (no React import chain in Node tests). The two
  // MUST NOT drift: the face slot is the mode's source of truth.
  const shellKey = shellSource.match(/const SURFACE_MODE_STORAGE_KEY = '([^']+)'/);
  assert.ok(shellKey, 'useBotBrowserShell defines SURFACE_MODE_STORAGE_KEY');
  assert.equal(SURFACE_MODE_STORAGE_KEY_MIRROR, shellKey[1]);
  assert.equal(SURFACE_MODE_STORAGE_KEY_MIRROR, 'idbots.botBrowser.surfaceMode');
});

test('the shell dispatches the face-change event from this module', () => {
  // The shell imports the constant (no second literal) and fires it on every
  // face write; the hook re-derives the mode from it.
  assert.match(
    shellSource,
    /import \{ SURFACE_MODE_CHANGE_EVENT \} from '\.\.\/\.\.\/hooks\/chatExperienceModeSource'/,
  );
  assert.match(shellSource, /new CustomEvent\(SURFACE_MODE_CHANGE_EVENT/);
});

test('chatExperienceModeForSurface maps the faces per the 2026-11-09 ruling', () => {
  // Studio (surface 'browser') -> assistant; BotWorks (surface 'home') ->
  // professional.
  assert.equal(chatExperienceModeForSurface('browser'), 'assistant');
  assert.equal(chatExperienceModeForSurface('home'), 'professional');
});

test('unreadable faces fall back to assistant, matching the shell landing default', () => {
  // Missing/garbage stored faces must not flip the default Studio landing
  // onto the professional presentation.
  assert.equal(chatExperienceModeForSurface(null), 'assistant');
  assert.equal(chatExperienceModeForSurface(undefined), 'assistant');
  assert.equal(chatExperienceModeForSurface('nope' as never), 'assistant');
});

test('readActiveSurfaceMode degrades to the browser default without a window', () => {
  // Node has no window: the guarded read must catch and fall back instead of
  // throwing, and never return a value outside the two faces.
  const surface = readActiveSurfaceMode();
  assert.ok(surface === 'browser' || surface === 'home');
  assert.equal(surface, 'browser');
});
