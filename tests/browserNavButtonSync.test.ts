import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBrowserPageDefinition } from '@openagentinternet/agent-browser-ui/browser';

/**
 * ABC 0.5.3 only refreshed the shared toolbar's back/forward disabled state
 * from syncToolbarForActiveTab() on tab open/close/switch, so in-tab
 * navigation left the buttons dead; IDBots carried a local source patch
 * (patchBrowserNavButtonSync) that appended a toolbar sync to
 * applyActiveTabState(). ABC 0.5.4 ships the equivalent fix upstream, and the
 * local patch was retired. This sentinel pins the shipped bundle so an
 * upstream regression of the native fix fails loudly instead of silently
 * re-breaking Back/Forward.
 */
function extractFunctionBody(script: string, name: string): string {
  const start = script.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found in ABC bundle`);
  const bodyStart = script.indexOf('{', start) + 1;
  let depth = 1;
  for (let i = bodyStart; i < script.length; i += 1) {
    if (script[i] === '{') depth += 1;
    if (script[i] === '}') {
      depth -= 1;
      if (depth === 0) return script.slice(bodyStart, i);
    }
  }
  assert.fail(`function ${name} body is unbalanced in ABC bundle`);
}

test('shipped ABC page script re-syncs the toolbar after every history mutation', () => {
  const definition = buildBrowserPageDefinition();
  const script = definition.script || '';
  const body = extractFunctionBody(script, 'applyActiveTabState');
  assert.ok(
    body.includes('syncToolbarForActiveTab();'),
    'applyActiveTabState must call syncToolbarForActiveTab so Back/Forward ' +
      'stay correct after in-tab navigation (regressed upstream?)',
  );
});

test('shipped ABC background navigation repaints the cleared target pane on the next reveal', () => {
  const definition = buildBrowserPageDefinition();
  const body = extractFunctionBody(definition.script || '', 'resolveUri');
  assert.match(body, /resolvedTab\.loading = false;\s+resolvedTab\.painted = false;/);
  assert.match(body, /errorTab\.loading = false;\s+errorTab\.painted = false;/);
});
