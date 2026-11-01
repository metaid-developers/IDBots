/**
 * IM session classification tests.
 *
 * Request (owner): direct AND group IM conversations belong in the LOCAL
 * session list, distinguished by a visible marker — not split across the
 * "online" (a2a) and "local" tabs.
 *
 * This suite pins three things:
 *   1. all IM sessions are created as 'standard' (local);
 *   2. the list row can still tell group from direct via the conversation
 *      mapping (which also classifies rows created before the change, with NO
 *      destructive data migration);
 *   3. the security model does not depend on session type — group/direct trust
 *      is decided by the entry gate and stays independent.
 *
 * Offline only. Run: `npx tsx --test tests/qqSessionClassification.test.ts`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import {
  getImSessionChannelInfo,
  isLegacyImSessionTitle,
} from '../src/renderer/components/cowork/coworkSessionPresentation.js';
import { resolveQQMessageGate } from '../src/main/im/qqTrust';
import type { QQInboundLike } from '../src/main/im/qqProtocol';
import type { QQConfig } from '../src/main/im/types';

const REPO_ROOT = path.resolve(__dirname, '..');
const readSource = (relativePath: string): string =>
  fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');

const OWNER = 'owner-openid-1';
const GROUP = 'group-openid-A1B2';

const config: Partial<QQConfig> = {
  enabled: true,
  appId: '102000001',
  ownerUserOpenid: OWNER,
  groupPolicy: 'allowlist',
  groupAllowlist: [GROUP],
  localToolsEnabled: false,
  localToolsAllowFrom: [],
};

function inbound(overrides: Partial<QQInboundLike> = {}): QQInboundLike {
  return {
    kind: 'c2c',
    senderId: OWNER,
    senderName: 'Owner',
    content: 'hi',
    messageId: 'm1',
    timestamp: new Date('2026-11-02T00:00:00Z').toISOString(),
    rawEventType: 'C2C_MESSAGE_CREATE',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Display classification
// ---------------------------------------------------------------------------

test('CLS-01 a group IM row is recognised from its channel mapping', () => {
  const info = getImSessionChannelInfo({
    imChannel: 'im:qq:group',
    imConversationId: `qq:group:${GROUP}`,
  });
  assert.ok(info);
  assert.equal(info.platform, 'qq');
  assert.equal(info.chatType, 'group');
  assert.equal(info.isGroup, true);
  assert.equal(info.suffix, 'A1B2', 'last 4 chars of the group id');
});

test('CLS-02 a direct IM row is recognised and carries no group suffix', () => {
  const info = getImSessionChannelInfo({
    imChannel: 'im:qq:direct',
    imConversationId: `qq:c2c:${OWNER}`,
  });
  assert.ok(info);
  assert.equal(info.isGroup, false);
  assert.equal(info.chatType, 'direct');
  assert.equal(info.suffix, '');
});

test('CLS-03 non-IM rows and malformed channels classify as null', () => {
  assert.equal(getImSessionChannelInfo({ title: 'local chat' }), null);
  assert.equal(getImSessionChannelInfo({ imChannel: null }), null);
  assert.equal(getImSessionChannelInfo({ imChannel: 'metaweb_private' }), null);
  assert.equal(getImSessionChannelInfo({ imChannel: 'im:qq:bogus' }), null);
  // Legacy rows carry only `im:<platform>`; without a conversation id the kind
  // is unknowable, so they degrade to null (no badge, no wrong claim).
  assert.equal(getImSessionChannelInfo({ imChannel: 'im:qq' }), null);
});

test('CLS-03b a legacy channel recovers its kind from the stored conversation id', () => {
  const legacyGroup = getImSessionChannelInfo({
    imChannel: 'im:qq',
    imConversationId: `qq:group:${GROUP}`,
  });
  assert.ok(legacyGroup);
  assert.equal(legacyGroup.isGroup, true);
  assert.equal(legacyGroup.suffix, 'A1B2');

  const legacyDirect = getImSessionChannelInfo({
    imChannel: 'im:qq',
    imConversationId: `qq:c2c:${OWNER}`,
  });
  assert.ok(legacyDirect);
  assert.equal(legacyDirect.isGroup, false);
});

test('CLS-04 legacy IM titles are detected; user titles are preserved', () => {
  assert.equal(isLegacyImSessionTitle('IM-qq-1700000000000'), true);
  assert.equal(isLegacyImSessionTitle('IM-weixin-1700000000001'), true);
  // New titles and user renames must never be overridden at render time.
  assert.equal(isLegacyImSessionTitle('QQ · 群聊 · A1B2'), false);
  assert.equal(isLegacyImSessionTitle('帮我写周报'), false);
  assert.equal(isLegacyImSessionTitle(''), false);
});

test('CLS-05 short/absent conversation ids degrade to an empty suffix', () => {
  const noId = getImSessionChannelInfo({ imChannel: 'im:qq:group' });
  assert.ok(noId);
  assert.equal(noId.suffix, '');

  const shortId = getImSessionChannelInfo({
    imChannel: 'im:qq:group',
    imConversationId: 'qq:group:ab',
  });
  assert.ok(shortId);
  assert.equal(shortId.suffix, 'ab');
});

// ---------------------------------------------------------------------------
// Classification change is display-only; permissions stay independent
// ---------------------------------------------------------------------------

test('CLS-06 every IM session is created as standard (local list), never a2a', () => {
  const handler = readSource('src/main/im/imCoworkHandler.ts');
  assert.doesNotMatch(
    handler,
    /chatType === 'direct' \? 'a2a' : 'standard'/,
    'the old direct=>a2a mapping must be gone'
  );
  assert.match(
    handler,
    /\/\/ ALL IM sessions are 'standard' \(local list\)/,
    'the intent must stay documented at the call site'
  );
  assert.doesNotMatch(
    handler,
    /setSessionHiddenFromList\(session\.id, true\)/,
    'group sessions must now be visible in the local list'
  );
});

test('CLS-07 group/direct restrictions do not depend on session type', () => {
  // The entry gate only sees the platform message + security config. A spoofed
  // session type on the payload changes nothing.
  const group = resolveQQMessageGate(
    { ...inbound({ kind: 'group', groupOpenid: GROUP, rawEventType: 'GROUP_AT_MESSAGE_CREATE' }), sessionType: 'a2a' } as QQInboundLike,
    config,
    1
  );
  assert.equal(group.trust.level, 'group');
  assert.equal(group.trust.toolScope, 'none');
  assert.equal(group.trust.memoryRead, false);

  const direct = resolveQQMessageGate(
    { ...inbound(), sessionType: 'standard' } as QQInboundLike,
    config,
    1
  );
  assert.equal(direct.trust.level, 'owner-dm');
  assert.equal(direct.trust.memoryRead, true);

  // Same sender, same config: only the chat kind changes the grant.
  assert.notEqual(group.trust.level, direct.trust.level);
});

test('CLS-08 the handler still threads the frozen trust into every turn', () => {
  const handler = readSource('src/main/im/imCoworkHandler.ts');
  assert.match(handler, /imTrust: trust/, 'start/continue must carry the trust');
  assert.match(handler, /buildGroupChatSystemPrompt\(\)/, 'group prompt stays minimal');
  assert.match(handler, /buildNoToolsChatSystemPrompt\(\)/, 'owner DM layer-3-off stays tool-free');
  assert.match(handler, /disableMemoryUpdates: true|memoryReadOnly: true/, 'memory gates stay');
});

test('CLS-09 list rows expose the IM channel for display without a data migration', () => {
  const store = readSource('src/main/coworkStore.ts');
  assert.match(store, /AS im_channel/, 'listSessions must expose im_channel');
  assert.match(store, /AS im_conversation_id/, 'listSessions must expose im_conversation_id');
  assert.match(
    store,
    /im\.channel LIKE 'im:%'/,
    'the classification is read from the mapping table (works for old rows)'
  );
});

test('CLS-10 group sessions stay out of the recent-session pulse', () => {
  const store = readSource('src/main/coworkStore.ts');
  assert.match(
    store,
    /recentSessionPulse\([\s\S]*?group_map\.channel LIKE 'im:%:group'/,
    'another session must never quote a group conversation'
  );
});
