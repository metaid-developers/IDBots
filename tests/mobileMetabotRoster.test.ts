import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getMetabotRoster,
  setMetabotRoster,
  subscribeMetabotRoster,
} from '../src/mobile/app/metabotRosterStore.ts';
import type { MobileMetabot } from '../src/mobile/bridge/types.ts';

function bot(id: number, name: string): MobileMetabot {
  return { id, name, metabot_type: id === 1 ? 'twin' : 'worker' } as MobileMetabot;
}

test('all roster subscribers see creates and renames without a page reload', (t) => {
  const initial = getMetabotRoster();
  t.after(() => setMetabotRoster(initial));
  const chatSnapshots: string[][] = [];
  const managementSnapshots: string[][] = [];
  const unsubscribeChat = subscribeMetabotRoster(() => {
    chatSnapshots.push(getMetabotRoster().map((entry) => entry.name));
  });
  const unsubscribeManagement = subscribeMetabotRoster(() => {
    managementSnapshots.push(getMetabotRoster().map((entry) => entry.name));
  });
  t.after(() => {
    unsubscribeChat();
    unsubscribeManagement();
  });

  setMetabotRoster([bot(1, 'Comet')]);
  setMetabotRoster([bot(1, 'Nova'), bot(2, 'Muse')]);

  assert.deepEqual(chatSnapshots, [['Comet'], ['Nova', 'Muse']]);
  assert.deepEqual(managementSnapshots, [['Comet'], ['Nova', 'Muse']]);
});

test('an unmounted roster consumer is not notified again', (t) => {
  const initial = getMetabotRoster();
  t.after(() => setMetabotRoster(initial));
  let calls = 0;
  const unsubscribe = subscribeMetabotRoster(() => { calls += 1; });
  setMetabotRoster([bot(1, 'Nova')]);
  unsubscribe();
  setMetabotRoster([bot(1, 'Nova'), bot(2, 'Muse')]);
  assert.equal(calls, 1);
});
