// Settings > Models: right-click editing menu for the API-key and Base URL
// inputs. Electron ships no default editing context menu, so a user whose
// copy/paste keyboard shortcuts are broken could not paste an API key at all.
// SecretInput (every API-key field) bakes the menu in; the Base URL inputs
// wire it per field. The menu is the shared useTextInputContextMenu — the
// same cut/copy/paste/select-all the cowork composer already had.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  deriveTextInputContextMenuState,
  TextInputContextMenuView,
} from '../src/renderer/components/ui/useTextInputContextMenu';
import { i18nService } from '../src/renderer/services/i18n';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...segments: string[]) => fs.readFileSync(path.join(projectRoot, ...segments), 'utf8');

test('API-key and Base URL inputs on the models settings page carry the editing context menu', () => {
  const settings = readSource('src', 'renderer', 'components', 'Settings.tsx');
  const secretInput = readSource('src', 'renderer', 'components', 'ui', 'SecretInput.tsx');

  // Every API-key field (provider / cerebellum form) gets the
  // menu through SecretInput itself.
  assert.match(secretInput, /useTextInputContextMenu\(\)/);
  assert.match(secretInput, /onContextMenu=\{contextMenu\.onContextMenu\}/);

  // The two Base URL inputs each own a menu instance (custom/template
  // providers edit Base URL through the shared provider field).
  assert.equal((settings.match(/useTextInputContextMenu\(\)/g) ?? []).length, 2);
  assert.match(settings, /onContextMenu=\{providerBaseUrlContextMenu\.onContextMenu\}/);
  assert.match(settings, /onContextMenu=\{cerebellumBaseUrlContextMenu\.onContextMenu\}/);
  assert.equal((settings.match(/BaseUrlContextMenu\.menu\}/g) ?? []).length, 2);
});

test('the menu offers localized cut/copy/paste/select-all in both languages', () => {
  const renderMenu = () => renderToStaticMarkup(
    <TextInputContextMenuView
      x={10}
      y={10}
      isMac
      derived={{ canCut: true, canCopy: true, canSelectAll: true }}
      onCut={() => {}}
      onCopy={() => {}}
      onPaste={() => {}}
      onSelectAll={() => {}}
    />,
  );
  const original = i18nService.getLanguage();
  try {
    i18nService.setLanguage('zh', { persist: false });
    for (const label of ['剪切', '复制', '粘贴', '全选']) {
      assert.ok(renderMenu().includes(label), `zh menu shows ${label}`);
    }
    i18nService.setLanguage('en', { persist: false });
    for (const label of ['Cut', 'Copy', 'Paste', 'Select All']) {
      assert.ok(renderMenu().includes(label), `en menu shows ${label}`);
    }
    assert.ok(renderMenu().includes('role="menu"'), 'the panel is an ARIA menu');
  } finally {
    i18nService.setLanguage(original, { persist: false });
  }
  assert.equal(i18nService.getLanguage(), original);
});

test('deriveTextInputContextMenuState gates cut/copy/select-all on selection, value, and disabled', () => {
  assert.deepEqual(
    deriveTextInputContextMenuState({ valueLength: 12, selectionStart: 3, selectionEnd: 7, disabled: false }),
    { canCut: true, canCopy: true, canSelectAll: true },
  );
  // No selection: copy/cut off, select-all still on.
  assert.deepEqual(
    deriveTextInputContextMenuState({ valueLength: 12, selectionStart: 5, selectionEnd: 5, disabled: false }),
    { canCut: false, canCopy: false, canSelectAll: true },
  );
  // Disabled input: copy stays available (read-only), cut and select-all off.
  assert.deepEqual(
    deriveTextInputContextMenuState({ valueLength: 12, selectionStart: 3, selectionEnd: 7, disabled: true }),
    { canCut: false, canCopy: true, canSelectAll: false },
  );
  // Empty input: nothing to select.
  assert.deepEqual(
    deriveTextInputContextMenuState({ valueLength: 0, selectionStart: 0, selectionEnd: 0, disabled: false }),
    { canCut: false, canCopy: false, canSelectAll: false },
  );
});
