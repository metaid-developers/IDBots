// 通知中心 rail 入口 × 进程中心 rail 入口 — 对齐合同
// (owner order 2026-11-24 00:38「对齐一下通知中心和进程中心的按钮」)
//
// 对齐不是把一串 class 抄第二遍，而是让两个入口由同一个组件渲染（同一支
// RailButton：h-10 w-10 + rounded-[8px]，在本应用 15px 根字号下实测 37.5×37.5）：
//   进程中心 = <RailButton itemId="processes">（栏内既有基准，不动）
//   通知中心 = <RailButton itemId="notifications">（面板把自己的 trigger 槽
//              交还给栏，见 NotificationCenter 的 renderTrigger）
//
// 这个套件钉住四件事，任何一件被破坏都说明「对齐」退回了「复制」：
//   ① 两条入口都来自 WorkspaceRail 里唯一的一份 RailButton；
//   ② NotificationCenter 里不再有自己画的按钮 / 自己画的徽章；
//   ③ 两个入口在同一个 mt-auto 系统组里相邻，落位顺序固定；
//   ④ 计数徽章走同一支 badgeCount、同一段 class，只有单位（runs / unread）不同。
//
// 真实渲染几何（宽高 / 圆角 / 徽章偏移）不在本套件里断言：那是 CDP 活体量测
// 的活（见交付报告 §渲染验收），源码断言只能证明「同一组件」，不能证明像素。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

const rail = read('src/renderer/components/layout/WorkspaceRail.tsx');
const panel = read('src/renderer/components/notifications/NotificationCenter.tsx');
const i18n = read('src/renderer/services/i18n.ts');

/** The rail's bottom system group: everything after the `mt-auto` container opens. */
const systemGroup = (() => {
  const at = rail.indexOf('mt-auto flex w-full flex-col items-center gap-1.5 px-1.5 pb-3 pt-1');
  assert.ok(at > 0, 'the rail still has its one mt-auto system group');
  return rail.slice(at);
})();

const count = (haystack, needle) => haystack.split(needle).length - 1;

test('① both system entries render through the ONE RailButton, never a copy', () => {
  // One definition, in the rail. A second copy anywhere is the drift this guards.
  assert.equal(count(rail, 'const RailButton: React.FC<{'), 1, 'exactly one RailButton definition');
  assert.equal(count(rail, 'data-slot="rail-item"'), 1, 'one place renders a rail button');

  // 通知中心: the panel's trigger slot, filled with the rail's own button.
  assert.match(rail, /<NotificationCenter[\s\S]{0,400}renderTrigger=\{\(\{ open: notificationsOpen, unreadCount, decisionCount, label, toggle \}\)/);
  assert.match(rail, /<RailButton\s*\n\s*itemId="notifications"/);

  // 进程中心: the SAME component, mounted from the model entry.
  assert.match(rail, /<RailButton\s*\n\s*itemId=\{processesItem\.id\}/);
  assert.match(rail, /renderRailIcon\(processesItem\.icon\)/);

  // Both live inside the system group (not in the scrolling navs).
  assert.match(systemGroup, /<NotificationCenter/);
  assert.match(systemGroup, /itemId=\{processesItem\.id\}/);
});

test('② NotificationCenter draws no entry of its own — no button, no badge, no glyph', () => {
  // The panel owns state + surface only. Each of these was a real part of the
  // pre-alignment bell and each one is a way for the two entries to drift again.
  assert.doesNotMatch(panel, /data-slot="rail-item"/);
  assert.doesNotMatch(panel, /h-10 w-10/, 'the tile size belongs to RailButton');
  assert.doesNotMatch(panel, /from '@heroicons\/react\/24\/outline'/, 'the glyph moves with the entry');
  assert.doesNotMatch(panel, /data-testid="notification-bell-badge"/, 'the badge is the shared one');
  assert.doesNotMatch(panel, /<Tooltip/, 'the entry tooltip is the rail\'s');
  // …and it does hand the trigger out, with the live state a real toggle needs.
  assert.match(panel, /renderTrigger\(\{ open, unreadCount, decisionCount, label, toggle \}\)/);
  assert.match(panel, /export interface NotificationTriggerState \{[\s\S]{0,260}toggle: \(\) => void;/);
});

test('③ system group order is 通知中心 → 进程中心 → 设置 → 更新模块, adjacent', () => {
  const atBell = systemGroup.indexOf('<NotificationCenter');
  const atProcesses = systemGroup.indexOf('{processesItem ? (');
  const atSettings = systemGroup.indexOf('itemId="settings"');
  const atUpdate = systemGroup.indexOf('{updateModule}');
  for (const [name, at] of [['通知中心', atBell], ['进程中心', atProcesses], ['设置', atSettings], ['更新模块', atUpdate]]) {
    assert.ok(at > 0, `${name} is mounted in the system group`);
  }
  assert.ok(atBell < atProcesses, '通知中心 sits directly above 进程中心');
  assert.ok(atProcesses < atSettings, '进程中心 sits directly above 设置');
  assert.ok(atSettings < atUpdate, 'the update module stays the bottom slot');
  // Adjacency is a property of the container, not of two lucky margins: neither
  // entry carries spacing of its own between the pair (comments excluded).
  const between = systemGroup.slice(atBell, atProcesses).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(between, /className="[^"]*\b(?:mt|mb|space-y)-/, 'no private spacing between the pair');
});

test('④ one count badge: same element, same class, only the unit differs', () => {
  // The badge markup exists once — inside RailButton — so both entries inherit
  // the 14 px / rounded-full / red-500 pill and its -3px offsets verbatim.
  assert.equal(
    count(rail, 'absolute -right-[3px] -top-[3px] flex h-[14px] min-w-[14px] shrink-0 items-center justify-center rounded-full bg-red-500 px-[3px] text-[9.5px] font-bold leading-none text-white'),
    1,
    'one count-badge form',
  );
  assert.equal(count(rail, 'data-rail-badge-count={badgeCount}'), 1);
  assert.equal(count(rail, 'data-count-unit={countUnit}'), 1);

  // 进程中心: the runs unit (default), the awaiting count from the model.
  assert.match(rail, /badgeCount=\{processesItem\.badgeCount\}/);
  // 通知中心: the unread count from the SAME notification pipeline the panel reads.
  assert.match(rail, /badgeCount=\{unreadCount\}/);
  assert.match(rail, /countUnit="unread"/);
  // The raw count stays in the DOM even when the RENDERED number is capped.
  assert.match(rail, /badgeMaxDisplay=\{99\}/);
  assert.match(rail, /typeof badgeMaxDisplay === 'number' && badgeCount > badgeMaxDisplay/);
  // The count's meaning is never the bare number: both entries label it.
  assert.match(rail, /indicatorLabel=\{unreadCount > 0[\s\S]{0,160}t\('notificationsUnreadBadge'\)\.replace\('\{count\}', String\(unreadCount\)\)/);
});

test('⑤ the bell counts the EXISTING notification pipeline — no new channel', () => {
  // unreadCount is fed by notification:getUnreadCount, refreshed on
  // notification:changed — the same two reads the panel already had.
  assert.match(panel, /api\.getUnreadCount\?\.\(\)/);
  assert.match(panel, /notification\?\.onChanged\?\.\(/);
  assert.match(panel, /if \(count\?\.success && typeof count\.count === 'number'\) setUnreadCount\(count\.count\);/);
  // The entry shows exactly that number (no second derivation on the rail side).
  assert.match(panel, /renderTrigger\(\{ open, unreadCount, decisionCount, label, toggle \}\)/);
});

test('⑥ the entry keeps the rail\'s accessible contract (label, pressed, expanded)', () => {
  // One button contract: tooltip on the right with the rail's 200 ms delay,
  // aria-label as the accessible name, aria-pressed for the pressed state.
  assert.match(rail, /<Tooltip content=\{label\} position="right" delay=\{200\}>/);
  assert.match(rail, /aria-label=\{label\}/);
  assert.match(rail, /aria-pressed=\{active\}/);
  // The popover entry adds aria-expanded through the shared button, not a copy.
  assert.match(rail, /aria-expanded=\{ariaExpanded\}/);
  assert.match(rail, /ariaExpanded=\{notificationsOpen\}/);
  // The bell's pressed state IS the panel state, so the two can never disagree.
  assert.match(rail, /active=\{notificationsOpen\}/);
  assert.match(rail, /onClick=\{toggle\}/);
});

test('⑦ i18n: the entry label and the count label exist in BOTH languages', () => {
  for (const key of ['notificationsBellLabel', 'notificationsUnreadBadge']) {
    const hits = i18n.match(new RegExp(`^\\s+${key}:`, 'gm')) ?? [];
    assert.equal(hits.length, 2, `${key} must be defined once per language`);
  }
});
