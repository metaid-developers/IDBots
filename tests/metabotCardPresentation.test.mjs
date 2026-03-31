import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMetaBotToggleViewModel } from '../src/renderer/components/metabots/metaBotCardPresentation.js';

test('heartbeat toggle uses a smaller green-on style than the main enable toggle', () => {
  const enableToggle = buildMetaBotToggleViewModel({ enabled: true, variant: 'enable' });
  const heartbeatToggle = buildMetaBotToggleViewModel({ enabled: true, variant: 'heartbeat' });

  assert.match(enableToggle.trackClass, /\bw-9\b/);
  assert.match(enableToggle.trackClass, /\bh-5\b/);
  assert.match(enableToggle.trackClass, /\bbg-claude-accent\b/);

  assert.match(heartbeatToggle.trackClass, /\bw-8\b/);
  assert.match(heartbeatToggle.trackClass, /\bh-4\b/);
  assert.match(heartbeatToggle.trackClass, /\bbg-emerald-500\b/);
  assert.doesNotMatch(heartbeatToggle.trackClass, /\bbg-claude-accent\b/);
});

test('heartbeat toggle uses the compact knob sizing and translation', () => {
  const heartbeatToggle = buildMetaBotToggleViewModel({ enabled: true, variant: 'heartbeat' });
  const heartbeatToggleOff = buildMetaBotToggleViewModel({ enabled: false, variant: 'heartbeat' });

  assert.match(heartbeatToggle.knobClass, /\bw-3\b/);
  assert.match(heartbeatToggle.knobClass, /\bh-3\b/);
  assert.match(heartbeatToggle.knobClass, /translate-x-\[17px\]/);
  assert.match(heartbeatToggleOff.knobClass, /translate-x-\[2px\]/);
});
