// v4 final re-judge table: merge current records + outside occurrences with
// census categories (occurrence-expanded ordinal mapping), apply the new
// criterion (text + clickable = button), write audit/v4-rejudge.json and print
// the aggregate matrix.
const fs = require('fs');

const cur = JSON.parse(fs.readFileSync('audit/v4-current.json', 'utf8'));
const census = JSON.parse(fs.readFileSync('capsule-sweep-r2-census.json', 'utf8'));

const EXCLUDE = new Set([
  'src/renderer/components/traffic/TrafficSettings.tsx|1309',
  'src/renderer/components/update/AppUpdateBadge.tsx|86',
  'src/renderer/components/update/AppUpdateBadge.tsx|87',
]);
const cenByFile = new Map();
for (const r of census.records) {
  if (EXCLUDE.has(r.file + '|' + r.line)) continue;
  if (!cenByFile.has(r.file)) cenByFile.set(r.file, []);
  cenByFile.get(r.file).push(r.category);
}

// ---- manual adjudication overrides (each verified by reading source) ----
const OVERRIDES = new Map([
  // the single genuine text+clickable pill button (avatar + author name, onClick)
  ['src/renderer/components/metaapps/MetaAppsManager.tsx|357', { verdict: '①改矩形', why: '承载作者名文字+onClick(BotBrowser跳转)→按钮；改 rounded-[var(--shape-radius-sm)](8px)' }],
  // avatar-wrapping buttons: no visible text (aria-label/title only) → 头像圈(可点击)
  ['src/renderer/components/cowork/A2AMessageItem.tsx|684', { verdict: '②维持-头像圈(可点击)', why: '子节点=NftAvatarFrame头像元素({image})，无可见文字；aria-label只是无障碍标签' }],
  ['src/renderer/components/groupTasks/GroupTaskListMeta.tsx|105', { verdict: '②维持-头像圈(可点击)', why: '子节点={body}=纯头像(NftAvatarFrame/头像span)，圆内首字母是头像fallback非按钮文字' }],
  // forbidden hand-over
  ['src/renderer/features/botBrowser/MacWindowLights.tsx|96', { verdict: '①禁触-移交维持', why: 'macOS 红绿灯装饰点，owner 禁触清单；census 同类①禁触-移交' }],
]);

// switch-track / avatar / dot / decoration pattern recognizers for auto keeps
const isTrack = (r) => /w-\d+(\.\d+)? h-\d+(\.\d+)?|h-\d+(\.\d+)? w-\d+(\.\d+)?/.test(r.className || '') && /transition-colors/.test(r.className || '') && !r.text;
const isKnob = (r) => /translate-x|bg-white/.test(r.className || '');
const isDot = (r) => r.selfClosing || ((!r.text && r.exprs.length === 0) && /h-(0\.5|1|1\.5|2|2\.5|3)(\s|["'$}]|$)|w-(1|1\.5|2|2\.5|3)(\s|["'$}]|$)/.test(r.className || ''));
const isAvatar = (r) => /object-cover|overflow-hidden/.test(r.className || '') || r.tag === 'img';
const isBar = (r) => /h-(0\.5|1|1\.5)(\s|["'$}]|$)/.test(r.className || '') && /absolute|bottom|progress|w-full|flex-1/.test(r.className || '');

const rows = [];

function groupByFile(records) {
  const m = new Map();
  for (const r of records) { if (!m.has(r.file)) m.set(r.file, []); m.get(r.file).push(r); }
  return m;
}

const byFile = groupByFile(cur.records);
// seed files that have ONLY outside occurrences (no JSX record at all),
// e.g. metaBotCardPresentation.js / UserMessageOriginBadge.tsx
for (const d of cur.rawTextualDeltas) if (!byFile.has(d.file)) byFile.set(d.file, []);
const merged = [];
for (const [file, recs] of byFile) {
  // occurrence-level items: each record expands to occCount occurrences keyed by
  // absolute source offset (occOffsets); outside deltas carry their own pos.
  const items = [];
  for (const r of recs) {
    const offs = (r.occOffsets && r.occOffsets.length === r.occCount) ? r.occOffsets : null;
    for (let k = 0; k < r.occCount; k++) items.push({ kind: 'rec', r, occIndex: k, pos: offs ? offs[k] : (r.initPos ?? r.elemPos) + k });
  }
  for (const d of cur.rawTextualDeltas.filter((x) => x.file === file)) items.push({ kind: 'outside', d, pos: typeof d.pos === 'number' ? d.pos : Infinity });
  items.sort((a, b) => a.pos - b.pos);
  const cen = cenByFile.get(file) || [];
  if (items.length !== cen.length) {
    console.error('ALIGNMENT-DEFECT', file, 'items=' + items.length, 'census=' + cen.length);
  }
  items.forEach((it, i) => {
    const line = it.kind === 'rec' ? it.r.line : it.d.line;
    merged.push({
      file,
      line,
      occIndex: it.kind === 'rec' ? it.occIndex : null,
      pos: it.pos,
      censusCategory: cen[i] || '(无)',
      kind: it.kind,
      rec: it.r,
      delta: it.d,
    });
  });
}

const isClickable = (r) => ['button', 'a', 'Link', 'NavLink'].includes(r.tag) || r.onClick || r.href || (r.role && r.role.includes('button'));

for (const row of merged) {
  if (row.kind === 'outside') {
    const s = row.delta.snippet || '';
    let verdict, why;
    if (/frameClassName|avatarClass/.test(s)) { verdict = '②维持-头像圈(常量/透传)'; why = 'frameClassName/avatarClass 头像框透传或常量，非元素本体样式'; }
    else if (/metaBotCardPresentation\.js:20/.test(row.file + ':' + row.line) || /flex items-center transition-colors/.test(s)) { verdict = '②维持-开关轨道(常量)'; why = 'buildMetaBotToggleViewModel trackClass：w-9 h-5 开关轨道'; }
    else if (/bg-white shadow-md/.test(s)) { verdict = '②维持-开关滑块(常量)'; why = 'buildMetaBotToggleViewModel knobClass：w-3.5 h-3.5 滑块'; }
    else if (/h-0\.5/.test(s)) { verdict = '③维持-装饰条'; why = 'McpManager tab 指示条(h-0.5 底部下划线)'; }
    else { verdict = '②维持-待查'; why = s.slice(0, 80); }
    row.verdict = verdict; row.why = why;
    rows.push(row);
    continue;
  }
  const r = row.rec;
  const key = r.file + '|' + r.line;
  if (OVERRIDES.has(key)) {
    Object.assign(row, OVERRIDES.get(key));
    row.verdict = OVERRIDES.get(key).verdict; row.why = OVERRIDES.get(key).why;
    rows.push(row);
    continue;
  }
  const clickable = isClickable(r);
  const hasVisibleText = Boolean(r.text && r.text.trim()) || r.exprs.some((e) => !e.includes('<') && /'|"|`|t\(/.test(e));
  const descClickable = Boolean(r.descClickable);
  if (clickable && hasVisibleText) {
    // auto BUTTON candidates were only the 3 avatar-buttons (expr = bare identifier);
    // those 3 are overridden above; anything new landing here must be surfaced
    row.verdict = '①改矩形(需人工复核)'; row.why = '文字+可点击=按钮';
  } else if (clickable && !hasVisibleText) {
    if (isTrack(r)) { row.verdict = '②维持-开关轨道'; row.why = '可点击但无文字：w/h 对+transition-colors 开关轨道(owner 保留类)'; }
    else if (r.tag === 'img' || isAvatar(r)) { row.verdict = '②维持-头像圈(可点击)'; row.why = '可点击头像，无可见文字'; }
    else if (isKnob(r)) { row.verdict = '②维持-开关滑块'; row.why = 'bg-white/translate-x 滑块'; }
    else { row.verdict = '②维持-可点击无文字(图标/装饰)'; row.why = '可点击无文字，按判据不强制矩形'; }
  } else if (hasVisibleText && !clickable) {
    if (descClickable) { row.verdict = '②维持-展示徽章(容器不可点)'; row.why = '文字在容器，点击来自内嵌钮(MetaBotEditTabs 技能chip，×钮已矩形)'; }
    else { row.verdict = '②维持-展示徽章(带文字不可点)'; row.why = '判据两半仅成立文字半：不可点击→非按钮→维持圆形'; }
  } else {
    if (isKnob(r)) { row.verdict = '②维持-开关滑块'; row.why = '无文字不可点：bg-white/translate-x 滑块'; }
    else if (isDot(r) && !isBar(r)) { row.verdict = '②维持-状态点'; row.why = '无文字不可点：小尺寸纯状态点'; }
    else if (isBar(r)) { row.verdict = '③维持-进度/装饰条'; row.why = '无文字不可点：进度/指示条'; }
    else if (isAvatar(r)) { row.verdict = '②维持-头像圈'; row.why = '无文字不可点：object-cover/overflow-hidden 头像'; }
    else { row.verdict = '③维持-装饰'; row.why = '无文字不可点：装饰图形'; }
  }
  rows.push(row);
}

fs.writeFileSync('audit/v4-rejudge.json', JSON.stringify({ total: rows.length, rows }, null, 1));

// aggregate matrix
const matrix = {};
for (const r of rows) {
  const cen = (r.censusCategory || '(无)').replace(/\(.*/, '');
  const k = cen + ' → ' + r.verdict;
  matrix[k] = (matrix[k] || 0) + 1;
}
console.log('=== census → v4 verdict matrix (occurrences) ===');
for (const [k, v] of Object.entries(matrix).sort()) console.log(String(v).padStart(3), k);
const mustChange = rows.filter((r) => r.verdict.startsWith('①改矩形'));
console.log('\nMUST-CONVERT:', mustChange.length);
for (const r of mustChange) console.log(' ', r.file + ':' + r.line, r.censusCategory, r.why);
