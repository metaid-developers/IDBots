import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IM_PLATFORM_LIST,
  getPlatformConfigAction,
} from '../src/renderer/components/im/platformConfigActions';
import type { IMPlatform } from '../src/renderer/types/im';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMSETTINGS_PATH = path.resolve(
  HERE,
  '../src/renderer/components/im/IMSettings.tsx'
);

const EXPECTED_ACTION_TYPE: Record<IMPlatform, string> = {
  dingtalk: 'im/setDingTalkConfig',
  feishu: 'im/setFeishuConfig',
  telegram: 'im/setTelegramConfig',
  discord: 'im/setDiscordConfig',
  weixin: 'im/setWeixinConfig',
  qq: 'im/setQQConfig',
};

// Regression for the shipped crash:
//   TypeError: setConfigAction is not a function
//   at toggleGateway (.../IMSettings.tsx)
// The inline platform map had no `qq` key, so the lookup returned undefined and
// dispatch(undefined(...)) threw on click — the gateway never started. Every
// platform must now resolve to a callable action creator.
test('every IM platform resolves to a callable config action creator', () => {
  for (const platform of IM_PLATFORM_LIST) {
    const actionCreator = getPlatformConfigAction(platform);
    assert.equal(
      typeof actionCreator,
      'function',
      `${platform} must map to an action creator, got ${typeof actionCreator}`
    );
  }
});

test('qq enable toggle produces the QQ config action instead of undefined', () => {
  const actionCreator = getPlatformConfigAction('qq');
  assert.equal(typeof actionCreator, 'function');

  const action = actionCreator({ enabled: true });
  assert.deepEqual(action, {
    type: 'im/setQQConfig',
    payload: { enabled: true },
  });
});

test('platform config actions are wired one-to-one (no fallback to a neighbour)', () => {
  for (const platform of IM_PLATFORM_LIST) {
    const action = getPlatformConfigAction(platform)({ enabled: true });
    assert.equal(
      action.type,
      EXPECTED_ACTION_TYPE[platform],
      `${platform} dispatched ${String(action.type)}`
    );
  }
});

test('metabot selection payload reaches the same platform action', () => {
  for (const platform of IM_PLATFORM_LIST) {
    const action = getPlatformConfigAction(platform)({ metabotId: 7 });
    assert.equal(action.type, EXPECTED_ACTION_TYPE[platform]);
    assert.deepEqual(action.payload, { metabotId: 7 });
  }
});

// Structural guard: the component must consume the exhaustive registry rather
// than rebuild a partial map inline (which is what dropped `qq`).
test('IMSettings.tsx has no inline platform action map left', () => {
  const source = readFileSync(IMSETTINGS_PATH, 'utf8');

  assert.doesNotMatch(
    source,
    /const\s+setConfigAction\s*=/,
    'IMSettings.tsx still declares a local setConfigAction map'
  );
  assert.match(
    source,
    /getPlatformConfigAction\(platform\)/,
    'IMSettings.tsx must resolve platform actions through getPlatformConfigAction'
  );
});
