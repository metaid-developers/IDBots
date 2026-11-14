// v4 triage: map current AST records to the v2 census (per-file ordinal),
// auto-triage, and emit the manual-review queue.
// Reads audit/v4-current.json + capsule-sweep-r2-census.json
// Writes audit/v4-triage.json + prints summary.
const fs = require('fs');

const cur = JSON.parse(fs.readFileSync('audit/v4-current.json', 'utf8'));
const census = JSON.parse(fs.readFileSync('capsule-sweep-r2-census.json', 'utf8'));

// census ①改动 records to EXCLUDE from per-file mapping (already converted in v2)
const EXCLUDE = new Set([
  'src/renderer/components/traffic/TrafficSettings.tsx|1309',
  'src/renderer/components/update/AppUpdateBadge.tsx|86',
  'src/renderer/components/update/AppUpdateBadge.tsx|87',
]);
const censusByFile = new Map();
for (const r of census.records) {
  const key = r.file + '|' + r.line;
  if (EXCLUDE.has(key)) continue;
  if (!censusByFile.has(r.file)) censusByFile.set(r.file, []);
  censusByFile.get(r.file).push(r.category);
}

// per-file ordinal mapping + drift report
const drift = [];
for (const rec of cur.records) {
  const list = censusByFile.get(rec.file) || [];
  const idx = cur.records.filter((r) => r.file === rec.file).indexOf(rec);
  if (idx < list.length) rec.censusCategory = list[idx];
  else {
    rec.censusCategory = '(新增-上轮无)';
    drift.push(rec.file + ':' + rec.line);
  }
}
const censusOnly = [];
for (const [f, list] of censusByFile) {
  const have = cur.records.filter((r) => r.file === f).length;
  if (have < list.length) censusOnly.push(f + ' census=' + list.length + ' cur=' + have);
}

const isClickable = (r) =>
  ['button', 'a', 'Link', 'NavLink'].includes(r.tag) || r.onClick || r.href || (r.role && r.role.includes('button'));
const exprHasElement = (r) => r.exprs.some((e) => e.includes('<'));
const textish = (r) =>
  (r.text && r.text.trim().length > 0) ||
  (r.exprs.length > 0 && !exprHasElement(r));

const out = [];
let nButton = 0, nReview = 0;
for (const r of cur.records) {
  const clickable = isClickable(r);
  const hasText = textish(r);
  let verdict, why;
  if (clickable && hasText) { verdict = 'BUTTON'; why = '文字+可点击'; nButton++; }
  else if (clickable && !hasText) {
    // clickable but no text: toggle track? avatar button? icon button? -> manual review
    verdict = 'REVIEW-CLICKABLE-NO-TEXT'; why = '可点击但无直接文字（图标钮/开关轨道/头像钮?）'; nReview++;
  } else if (!clickable && hasText && !exprHasElement(r)) {
    verdict = 'KEEP-badge-text'; why = '带文字但不可点击→展示徽章，维持圆形'; 
  } else {
    verdict = 'KEEP-other'; why = '不可点击且无文字→装饰/点/圈'; 
  }
  out.push({ ...r, clickable, hasText, verdict, why });
}

fs.writeFileSync('audit/v4-triage.json', JSON.stringify({ count: out.length, newSinceCensus: drift, censusOnlyMissing: censusOnly, records: out }, null, 1));

const byVerdict = {};
for (const r of out) byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1;
console.log('total', out.length, JSON.stringify(byVerdict));
console.log('new since census:', drift.length, drift.slice(0, 10));
console.log('census-only missing:', censusOnly);
console.log('\n=== BUTTON verdicts (to change) ===');
for (const r of out) if (r.verdict === 'BUTTON') console.log(r.file.split('/').pop() + ':' + r.line, r.tag, JSON.stringify(r.text).slice(0, 50), 'exprs=' + JSON.stringify(r.exprs).slice(0, 60), '|| ' + (r.className || '').slice(0, 60));
