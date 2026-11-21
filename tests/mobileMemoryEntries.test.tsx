import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMobileMockBridge } from '../src/mobile/bridge/mockBridge';
import { MemoryPage } from '../src/mobile/app/screens/me/MemoryPage.tsx';
import { mobileI18n } from '../src/mobile/i18n';

/**
 * CM5 memory-entry management: mock-bridge behavior pins for the P2
 * cowork:memory:* channels plus a structural SSR pin for the MemoryPage
 * entries section. Live-data flows are covered by the Playwright suite
 * (renderToStaticMarkup never runs effects).
 */

function makeBridge() {
  return createMobileMockBridge({
    streamTokenIntervalMs: 1,
    orderCompleteDelayMs: 10,
    reconnectBlackoutMs: 10,
    scheduledRunDelayMs: 10,
    manualRunDelayMs: 10,
  });
}

const here = path.dirname(fileURLToPath(import.meta.url));
const readSource = (relative: string): string =>
  fs.readFileSync(path.join(here, relative), 'utf8');

describe('ChatScreen drawer archived section source pins', () => {
  it('drawer wires the archived toggle, restore action, and listArchivedSessions', () => {
    const source = readSource('../src/mobile/app/screens/ChatScreen.tsx');
    assert.ok(source.includes('data-testid="session-archived-toggle"'));
    assert.ok(source.includes('data-testid="session-archived-list"'));
    assert.ok(source.includes("t('mobile.chat.archivedRestore')"));
    assert.ok(source.includes('chat.unarchiveSession'));
  });
  it('drawer restore goes through the same unarchive channel the allowlist exposes', () => {
    const hook = readSource('../src/mobile/app/hooks/useChat.ts');
    assert.ok(hook.includes('cowork.unarchiveSession'));
    assert.ok(hook.includes('cowork.listArchivedSessions'));
  });
});

describe('mock bridge memory entry channels', () => {
  it('default list returns active entries only and seeded fixtures', async () => {
    const bridge = makeBridge();
    const result = await bridge.electron.cowork.listMemoryEntries({});
    assert.equal(result.success, true);
    const entries = result.entries ?? [];
    assert.ok(entries.length >= 4, `expected seeded fixtures, got ${entries.length}`);
    for (const entry of entries) {
      assert.equal(entry.status, 'created');
    }
  });

  it('query filters entries by substring on text', async () => {
    const bridge = makeBridge();
    const result = await bridge.electron.cowork.listMemoryEntries({ query: 'Sunny' });
    const entries = result.entries ?? [];
    assert.ok(entries.length >= 1);
    for (const entry of entries) {
      assert.ok(entry.text.toLowerCase().includes('sunny'));
    }
  });

  it('create appends an explicit conversation entry with the chosen usage class', async () => {
    const bridge = makeBridge();
    const created = await bridge.electron.cowork.createMemoryEntry({
      text: '  喜欢简洁的回复  ',
      usageClass: 'preference',
    });
    assert.equal(created.success, true);
    assert.equal(created.entry?.text, '喜欢简洁的回复');
    assert.equal(created.entry?.usageClass, 'preference');
    assert.equal(created.entry?.origin, 'conversation');
    assert.equal(created.entry?.isExplicit, true);

    const list = await bridge.electron.cowork.listMemoryEntries({ query: '简洁' });
    assert.equal(list.entries?.length, 1);
  });

  it('create rejects empty text', async () => {
    const bridge = makeBridge();
    const result = await bridge.electron.cowork.createMemoryEntry({ text: '   ' });
    assert.equal(result.success, false);
  });

  it('update edits text; archive (stale) hides from default list; unarchive restores', async () => {
    const bridge = makeBridge();
    const created = await bridge.electron.cowork.createMemoryEntry({
      text: '临时条目',
      usageClass: 'work_review',
    });
    const id = created.entry?.id as string;

    const edited = await bridge.electron.cowork.updateMemoryEntry({ id, text: '改名后的条目' });
    assert.equal(edited.success, true);
    assert.equal(edited.entry?.text, '改名后的条目');

    const archived = await bridge.electron.cowork.updateMemoryEntry({ id, status: 'stale' });
    assert.equal(archived.success, true);
    const active = await bridge.electron.cowork.listMemoryEntries({ query: '改名后' });
    assert.equal(active.entries?.length, 0);
    const stale = await bridge.electron.cowork.listMemoryEntries({ status: 'stale', query: '改名后' });
    assert.equal(stale.entries?.length, 1);

    const restored = await bridge.electron.cowork.unarchiveMemoryEntry({ id });
    assert.equal(restored.success, true);
    assert.equal(restored.entry?.status, 'created');
  });

  it('delete is soft: the row leaves every default view', async () => {
    const bridge = makeBridge();
    const created = await bridge.electron.cowork.createMemoryEntry({
      text: '将被删除的条目',
      usageClass: 'profile_fact',
    });
    const id = created.entry?.id as string;
    const removed = await bridge.electron.cowork.deleteMemoryEntry({ id });
    assert.equal(removed.success, true);
    const active = await bridge.electron.cowork.listMemoryEntries({ query: '将被删除' });
    assert.equal(active.entries?.length, 0);
    const stale = await bridge.electron.cowork.listMemoryEntries({ status: 'stale' });
    for (const entry of stale.entries ?? []) {
      assert.notEqual(entry.id, id);
    }
  });

  it('self_identity entries are protected from edit and delete', async () => {
    const bridge = makeBridge();
    const list = await bridge.electron.cowork.listMemoryEntries({ query: 'Self intro' });
    const entry = (list.entries ?? [])[0];
    assert.ok(entry, 'self_identity fixture missing');
    assert.equal(entry.usageClass, 'self_identity');

    const edited = await bridge.electron.cowork.updateMemoryEntry({ id: entry.id, text: '篡改' });
    assert.equal(edited.success, false);
    const deleted = await bridge.electron.cowork.deleteMemoryEntry({ id: entry.id });
    assert.equal(deleted.success, false);
  });
});

describe('MemoryPage structural pins (CM5 entries section)', () => {
  it('renders the entries section: title, create button, search, switches intact', () => {
    mobileI18n.initFromDeviceLocale?.();
    const html = renderToStaticMarkup(React.createElement(MemoryPage, { onBack: () => undefined }));
    assert.ok(html.includes('data-testid="memory-entry-create"'));
    assert.ok(html.includes('data-testid="memory-search-input"'));
    // the three global switches from IA-PLAN §4.7 stay in place
    assert.ok(html.includes('data-testid="memory-row-memoryEnabled"'));
    assert.ok(html.includes('data-testid="memory-row-memoryImplicitUpdateEnabled"'));
    assert.ok(html.includes('data-testid="memory-row-memoryLlmJudgeEnabled"'));
  });
});
