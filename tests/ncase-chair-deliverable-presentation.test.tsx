/**
 * P0-b (task #149) — presentation regression for the chair-close deliverable
 * semantics. After the acceptGroupTask actor gate, a CHAIR-closed task leaves
 * its deliverable rows in 'delivered' — the detail view must render the
 * delivered tier for those rows and NEVER the acceptance tier, while an owner
 * accepted row keeps rendering the acceptance tier.
 *
 * House style: module shims + seeded row sets + react-test-renderer (the same
 * approach as the ncase presentation tests). Plus static source guards that
 * keep the statusKey/statusHintKey tier mapping honest in BOTH deliverable
 * renderers: the accepted label may only sit behind an explicit
 * `status === 'accepted'` check, and unknown statuses fall through to the
 * pending label (never the accepted one) — no default branch may masquerade
 * as owner acceptance.
 *
 * Note: tsx compiles .tsx to CJS, so the renderer module graph is imported
 * dynamically inside `initRenderHarness()` AFTER the shims are installed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Shims — installed BEFORE any renderer module is imported (the dynamic
// imports inside initRenderHarness run after this module body).
// ---------------------------------------------------------------------------

const noop = () => undefined;

const state: { detail: Record<string, unknown> | null } = { detail: null };

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: noop,
  removeItem: noop,
  clear: noop,
  key: () => null,
  length: 0,
};

(globalThis as Record<string, unknown>).document = {
  visibilityState: 'hidden', // the 5s poll skips its body entirely
  addEventListener: noop,
  removeEventListener: noop,
  createElement: () => ({
    style: {},
    setAttribute: noop,
    appendChild: noop,
    remove: noop,
    click: noop,
    href: '',
    download: '',
  }),
  body: { appendChild: noop, removeChild: noop, contains: () => false },
  documentElement: { style: {}, setAttribute: noop },
};

(globalThis as Record<string, unknown>).window = {
  electron: {
    platform: 'darwin',
    groupTask: {
      get: async () => ({ success: true, task: state.detail }),
      listMessages: async () => ({ success: true, messages: [] }),
      onStatusChanged: () => () => undefined,
      onCheckpointChanged: () => () => undefined,
    },
    userIdentity: {
      get: async () => ({ success: true, identity: { globalmetaid: 'idq1owner0000000000000000000000000000000' } }),
    },
    window: {
      isMaximized: async () => false,
      onStateChanged: () => () => undefined,
      minimize: noop,
      toggleMaximize: noop,
      close: noop,
      showSystemMenu: noop,
      on: () => () => undefined,
    },
    app: { getVersion: async () => '0.0.0-test' },
  },
  setInterval: () => 0,
  clearInterval: noop,
  addEventListener: noop,
  removeEventListener: noop,
  matchMedia: () => ({
    matches: false,
    addListener: noop,
    removeListener: noop,
    addEventListener: noop,
    removeEventListener: noop,
  }),
  requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
  location: { href: 'http://localhost/', origin: 'http://localhost', pathname: '/' },
  navigator: (globalThis as { navigator?: unknown }).navigator,
  open: noop,
  isSecureContext: true,
};

// ---------------------------------------------------------------------------
// Deferred renderer import graph (after shims) + pinned tier labels
// ---------------------------------------------------------------------------

type RenderDetail = (deliverableStatuses: string[]) => Promise<string>;

let harness: Promise<RenderDetail> | null = null;

const initRenderHarness = (): Promise<RenderDetail> => {
  if (harness) return harness;
  harness = (async (): Promise<RenderDetail> => {
    const React = (await import('react')).default;
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { i18nService } = await import('../src/renderer/services/i18n');
    const GroupTaskDetailViewModule = await import('../src/renderer/components/groupTasks/GroupTaskDetailView');
    const GroupTaskDetailView = GroupTaskDetailViewModule.default;

    // Pin the tier labels to the real zh copy from src/renderer/services/i18n.ts
    // so the assertions read against actual UI strings, not raw keys. Unknown
    // keys pass through as the key itself (harmless in the serialized tree).
    const STRINGS: Record<string, string> = {
      groupTasksDeliverableStatusPending: '待验收',
      groupTasksDeliverableStatusDelivered: '已交付',
      groupTasksDeliverableStatusAccepted: '已验收',
      groupTasksDeliverableStatusRejected: '已拒绝',
      groupTasksDeliverableStatusPendingHint: '已提交，待 owner 验收（与链上确认是两个独立维度）',
      groupTasksDeliverableStatusDeliveredHint: '链上核验通过，待 owner 验收',
      groupTasksDeliverableStatusAcceptedHint: '已通过 owner 验收',
      groupTasksDeliverableStatusRejectedHint: '已被拒绝',
    };
    (i18nService as unknown as { t: (key: string) => string }).t = (key: string) =>
      STRINGS[key] ?? key;

    return async (deliverableStatuses: string[]): Promise<string> => {
      const detail = baseDetail(deliverableStatuses);
      state.detail = detail;
      return renderToStaticMarkup(
        React.createElement(GroupTaskDetailView, {
          taskId: TASK_ID,
          onBack: noop,
          initialDetail: detail as never,
        }),
      );
    };
  })();
  return harness;
};

// ---------------------------------------------------------------------------
// Seed row sets
// ---------------------------------------------------------------------------

const TASK_ID = 7;

const baseDetail = (deliverableStatuses: string[]): Record<string, unknown> => ({
  id: TASK_ID,
  orchestrationTaskId: null,
  groupId: 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00000000i0',
  title: 'P0-b presentation task',
  goal: 'Ship the intro MetaApp',
  acceptanceCriteria: 'Preview URL works',
  status: 'done', // a CLOSED task (chair close or owner accept)
  chairMetabotId: 1,
  createdBy: 'user',
  lastProcessedMsgId: 0,
  createPinId: null,
  createdAt: '2026-11-18T10:00:00.000Z',
  updatedAt: '2026-11-18T11:00:00.000Z',
  closedAt: '2026-11-18T11:00:00.000Z',
  rating: null,
  ratingComment: null,
  ratedAt: null,
  displayName: null,
  pinned: false,
  archivedAt: null,
  members: [
    {
      id: 1, taskId: TASK_ID, metabotId: 1,
      globalmetaid: 'idq1chair00000000000000000000000000000000',
      role: 'chair', joinedPinId: null, createdAt: null, name: 'Twin', status: 'done',
    },
    {
      id: 2, taskId: TASK_ID, metabotId: 2,
      globalmetaid: 'idq1worker000000000000000000000000000000',
      role: 'worker', joinedPinId: null, createdAt: null, name: 'Coder', status: 'done',
    },
  ],
  deliverables: deliverableStatuses.map((status, index) => ({
    id: 100 + index,
    taskId: TASK_ID,
    msgPinId: `pin-${index}-i0`,
    authorGlobalmetaid: 'idq1worker000000000000000000000000000000',
    kind: 'metaapp',
    uri: `metaapp://p0b-row-${index}`,
    status,
    createdAt: '2026-11-18T10:30:00.000Z',
    verification: null,
    confirmation: 'unconfirmed',
    sourceContent: null,
    sourceSenderName: null,
  })),
  checkpoints: [],
  acceptanceSummary: null,
  statusEvents: [],
  transitions: [],
  integrityEvents: [],
  supervisorSignals: [],
});

// ---------------------------------------------------------------------------
// Component behavior
// ---------------------------------------------------------------------------

test('chair-closed task: delivered rows render the delivered tier, never an acceptance tier', async () => {
  const renderDetail = await initRenderHarness();
  const tree = await renderDetail(['delivered', 'pending']);
  assert.ok(tree.includes('已交付'), 'the delivered tier label renders for chair-closed rows');
  assert.ok(tree.includes('待验收'), 'the still-pending row keeps its own tier');
  assert.ok(!tree.includes('已验收'), 'no acceptance tier label appears anywhere for a chair close');
  assert.ok(!tree.includes('accepted ✓'), 'no accepted badge (AcceptanceSummaryCard wording) leaks in');
});

test('owner-accepted task: the accepted row keeps rendering the acceptance tier', async () => {
  const renderDetail = await initRenderHarness();
  const tree = await renderDetail(['accepted', 'delivered']);
  assert.ok(tree.includes('已验收'), 'the acceptance tier label renders for the owner verdict');
  assert.ok(tree.includes('已交付'), 'the delivered tier still renders for on-chain verified rows');
});

// ---------------------------------------------------------------------------
// Static source guards: no default branch may masquerade as owner acceptance
// ---------------------------------------------------------------------------

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readComponent = (relative: string): string =>
  fs.readFileSync(path.join(projectRoot, 'src', 'renderer', 'components', 'groupTasks', relative), 'utf8');

for (const component of ['GroupTaskDetailView.tsx', 'OpenTeamCollabDetailView.tsx']) {
  // Merge integration (task #149): P0-a nests a ledger-actor tier INSIDE the
  // accepted arm of GroupTaskDetailView's statusHintKey ternary
  // (status === 'accepted' ? (acceptedActorKind === 'chair' ? ByChair : owner) : …),
  // so that component carries THREE accepted-key lines (status label, owner
  // hint, chair hint) and the accepted check may sit up to 3 lines above the
  // key. The guard stays intent-preserving: every accepted-key line must have
  // an explicit `status === 'accepted'` check within its upward window — a key
  // reachable from any other arm still fails.
  const expectedAcceptedKeyLines: Record<string, number> = {
    'GroupTaskDetailView.tsx': 3,
    'OpenTeamCollabDetailView.tsx': 2,
  };
  test(`source guard ${component}: accepted label only behind an explicit accepted check; fallback is pending`, () => {
    const source = readComponent(component);
    const lines = source.split('\n');
    let acceptedKeyLines = 0;
    for (let i = 0; i < lines.length; i += 1) {
      // Prefix match on purpose: it must catch BOTH the status label
      // ('groupTasksDeliverableStatusAccepted') and its hint
      // ('groupTasksDeliverableStatusAcceptedHint') and, since P0-a, the
      // chair tier ('groupTasksDeliverableStatusAcceptedHintByChair').
      if (lines[i].includes("'groupTasksDeliverableStatusAccepted")) {
        acceptedKeyLines += 1;
        // The key is a ternary CONSEQUENT; its `status === 'accepted'`
        // check lives on the same line or within a few lines above
        // (multi-line ternary, P0-a adds one nested actor tier).
        let guarded = false;
        for (let up = 1; up <= 4 && i - up >= 0; up += 1) {
          if (/===\s*'accepted'/.test(lines[i - up])) {
            guarded = true;
            break;
          }
        }
        assert.ok(
          guarded || /===\s*'accepted'/.test(lines[i]),
          `${component}: the accepted label sits behind an explicit status === 'accepted' check (line: ${lines[i].trim()})`,
        );
      }
    }
    assert.equal(
      acceptedKeyLines,
      expectedAcceptedKeyLines[component],
      `${component}: each accepted tier (status label + hints) referenced exactly once`,
    );
    // Prefix match on purpose: catches both the status label and its hint.
    const pendingFallbacks = (source.match(/'groupTasksDeliverableStatusPending/g) ?? []).length;
    assert.ok(
      pendingFallbacks >= 2,
      `${component}: unknown statuses fall through to the pending label (statusKey + statusHintKey), never to accepted`,
    );
  });
}
