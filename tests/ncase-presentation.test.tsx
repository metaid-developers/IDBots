import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18nService } from '../src/renderer/services/i18n';

// P0-a (#149) 组件级测试 —— 承袭 tests/ncase-presentation.test.tsx 原件
// （链上原文 pin://16b63f23cec3e2aa65b7ac390dd60b9e3fb5dd0c3d5c1467f9042e649d60e834i0，
//   修前工作文件 sha256 fc115127da7609cf6641b1571b3a64a76a20d0fd4e13a0da21523906139c60fa、105 行）。
// 修前段第三例是「chair 代闭仍渲染 owner 验收文案 → 红复现」；P0-a 落地后该例翻绿：
// chair 代闭（账本 status event actor_kind=chair）必须渲染 chair 档文案，
// 且整页【不得出现】owner 验收文案（不得出现式判定）。
// 种子行集对齐 .iso-userdata/idbots.sqlite 的 N-case 行集，并补上 P0-a 读取的
// 落库 status event（renderer 读 GroupTaskDetail.statusEvents，camelCase）。

// —— 垫片：组件渲染期会读 window.electron.platform / document.visibilityState ——
(globalThis as any).window = {
  electron: {
    platform: 'darwin',
    window: {
      isMaximized: async () => false,
      isFullscreen: async () => false,
      isFocused: async () => true,
      onStateChanged: (_cb: any) => () => {},
      onClose: (_cb: any) => () => {},
      minimize: () => {},
      toggleMaximize: () => {},
      close: () => {},
    },
    groupTask: {
      onStatusChanged: (_cb: any) => () => {},
      onCheckpointChanged: (_cb: any) => () => {},
      onTurnActivityChanged: (_cb: any) => () => {},
      onOwnerReportDelivery: (_cb: any) => () => {},
    },
    userIdentity: { get: async () => ({ success: true, identity: { globalmetaid: 'ncase-owner-test' } }) },
  },
  setInterval: (_fn: any, _ms: any) => 0, // 不真排程：轮询与渲染语义无关，防 act 内无限重排
  setTimeout: (fn: any, ms: any) => globalThis.setTimeout(fn, ms),
  clearInterval: (id: any) => globalThis.clearInterval(id),
  clearTimeout: (id: any) => globalThis.clearTimeout(id),
  addEventListener: () => {},
  removeEventListener: () => {},
  requestAnimationFrame: (fn: any) => globalThis.setTimeout(fn, 0),
  location: { reload: () => {} },
  visibilityState: 'visible',
};
(globalThis as any).document = { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} };
(globalThis as any).matchMedia = (globalThis as any).matchMedia || (() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));

// —— 种子行（对齐 .iso-userdata/idbots.sqlite 的 N-case 行集）——
const mkDeliverable = (id: number, taskId: number, uri: string, status: string) => ({
  id, taskId, msgPinId: null, authorGlobalmetaid: 'idq1nqworker0000000000000000000000000',
  kind: 'file', uri, status, confirmation: 'confirmed', created_at: '2026-11-13', verification: null, content_hash: null,
});
const mkStatusEvent = (id: number, taskId: number, fromStatus: string, toStatus: string, actorKind: string, actorName: string | null, createdAt: string) => ({
  id, taskId, fromStatus, toStatus, actorKind, actorGlobalMetaId: null, actorName, createdAt,
});
const baseTask = {
  orchestrationTaskId: null, groupId: null, acceptanceCriteria: null, chairMetabotId: 1,
  createdBy: 'user', lastProcessedMsgId: 0, lastDrivenAt: null, createPinId: null,
  displayName: null, pinned: false, archivedAt: null, sourceSessionId: null,
  dispatchPausedAt: null, mode: 'task', members: [], rating: null, ratingComment: null, ratedAt: null,
};
const task1: any = { ...baseTask, id: 1, title: 'N-case 验收语义测试', goal: 'g', status: 'review',
  deliverables: [mkDeliverable(1, 1, 'metafile://ncase-n1-delivered', 'delivered'),
                 mkDeliverable(2, 1, 'metafile://ncase-n2-accepted', 'accepted')],
  statusEvents: [mkStatusEvent(11, 1, 'review', 'done', 'owner', 'Owner', '2026-11-13 13:50:00')] };
const task2: any = { ...baseTask, id: 2, title: 'N5 chair-RPC 关单测试', goal: 'g', status: 'done',
  closedAt: '2026-11-13 13:55:05',
  deliverables: [mkDeliverable(3, 2, 'metafile://ncase-n5-pending', 'accepted')],
  // N5 实测口径：chair 代闭落库 status event actor_kind='chair'（actor_globalmetaid 空串）。
  statusEvents: [mkStatusEvent(21, 2, 'review', 'done', 'chair', null, '2026-11-13 13:55:05')] };

let inited: ((taskId: number) => Promise<string>) | null = null;
async function init(): Promise<(taskId: number) => Promise<string>> {
  if (inited) return inited;
  const { groupTaskService } = await import('../src/renderer/services/groupTaskService');
  const overrides: Record<string, unknown> = {
    getTask: async (id: number) => (id === 2 ? task2 : task1),
    listMessages: async () => ({ messages: [], hasMore: false, page: 1, total: 0 }),
    list: async () => [task1, task2],
  };
  Object.assign(groupTaskService as any, overrides);
  const mod = await import('../src/renderer/components/groupTasks/GroupTaskDetailView');
  const GroupTaskDetailView = mod.default;
  inited = async (taskId: number): Promise<string> => {
    const detail = taskId === 2 ? task2 : task1;
    return renderToStaticMarkup(
      React.createElement(GroupTaskDetailView, {
        taskId,
        onBack: () => {},
        initialDetail: detail,
      }),
    );
  };
  return inited;
}

const OWNER_HINT = i18nService.t('groupTasksDeliverableStatusAcceptedHint');
const CHAIR_HINT = i18nService.t('groupTasksDeliverableStatusAcceptedHintByChair');
const ACCEPTED_LABEL = i18nService.t('groupTasksDeliverableStatusAccepted');
const DELIVERED_HINT = i18nService.t('groupTasksDeliverableStatusDeliveredHint');

test('P0-a 前置: chair 档 i18n key 已落双语词典且 chair 文案不含「owner 验收」字样', async () => {
  assert.ok(CHAIR_HINT && CHAIR_HINT !== 'groupTasksDeliverableStatusAcceptedHintByChair',
    'chair 档 key 未落词典（返回了 key 本身）');
  // 不得出现式判定：chair 档文案自身不得含「owner 验收」子串（中英两档各自守）。
  assert.ok(!CHAIR_HINT.includes('owner 验收'), `chair 文案含禁字样「owner 验收」: ${CHAIR_HINT}`);
  assert.ok(!CHAIR_HINT.includes('Accepted by the owner'), `chair 文案含禁句「Accepted by the owner」: ${CHAIR_HINT}`);
});

test('N2: owner 验收（actor_kind=owner）渲染 owner 验收文案（恰好一次）', async () => {
  const text = await (await init())(1);
  assert.ok(text.includes(OWNER_HINT), 'owner 验收的 owner 档文案缺失');
  const occurrences = text.split(OWNER_HINT).length - 1;
  assert.equal(occurrences, 1, `owner 验收文案应恰好 1 次（仅 accepted 行），实为 ${occurrences}`);
  assert.ok(text.includes(ACCEPTED_LABEL), 'accepted 状态标签缺失');
});

test('N1: delivered deliverable 不渲染 owner 验收文案', async () => {
  const text = await (await init())(1);
  const deliveredOk = text.includes(DELIVERED_HINT) || text.includes('awaiting owner acceptance');
  assert.ok(deliveredOk, 'delivered 行渲染缺失');
  const beforeDelivered = text.split(DELIVERED_HINT)[0];
  assert.ok(!beforeDelivered.includes(OWNER_HINT), 'delivered 段不应携带 owner 验收文案');
});

test('N5 修后: chair 代闭（status event actor_kind=chair）渲染 chair 档文案且整页不含 owner 验收文案', async () => {
  const text = await (await init())(2);
  assert.ok(text.includes(CHAIR_HINT), 'chair 代闭未渲染 chair 档文案');
  // 不得出现式判定：chair 代闭的整页渲染不得出现 owner 验收文案。
  assert.ok(!text.includes(OWNER_HINT), `chair 代闭页面不得出现 owner 验收文案，实渲染了 ${text.split(OWNER_HINT).length - 1} 次`);
  // 数据源判定（渲染证据）：落库 status event 进了状态史区块（actorName 为空时回显 actorKind='chair'），
  // 组件手里唯一的 chair 信号就是这个事件——分档只可能来自它，而非 session 状态或 UI 现场推断。
  assert.ok(text.includes(' → '), 'task2 的落库 close 事件未进状态史渲染');
  assert.ok(text.includes('· chair ·'), 'chair actor 未能从落库 status event 渲染出来');
});
