// v3 pair-harmony audit scanner v2: split on <button, grab the open tag text
// (up to the closing > of the open tag), extract className with quote-run matching.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'src/renderer';
function walk(dir) {
  let out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out = out.concat(walk(p));
    else if (name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

function extractClass(tagText) {
  // className={`...`} | className="..." | className='...' | className={cond ? 'a' : 'b'}
  const m = tagText.match(/className=\{?\s*([`"'])([\s\S]*?)\1/);
  if (m) return m[2].replace(/\$\{[\s\S]*?\}/g, ' DYN ').replace(/\s+/g, ' ').trim();
  const m2 = tagText.match(/className=\{[\s\S]*?\}/);
  if (m2) return m2[0].replace(/\s+/g, ' ').trim();
  return '(no-cls)';
}

const files = walk(ROOT);
const report = [];
let totalBtns = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const upto = [];
  let idx = 0, line = 1;
  while (true) {
    const m = src.slice(idx).match(/<button[\s>]/);
    if (!m) break;
    const at = idx + m.index;
    line += src.slice(idx, at).split('\n').length - 1;
    // open tag text: from at until the first '>' that closes the tag (heuristic: first '>' after which a newline+text child follows is fine; JSX attrs rarely contain bare '>' before end)
    const seg = src.slice(at, at + 1200);
    let end = seg.indexOf('>');
    while (end !== -1 && seg.slice(0, end).split('"').length % 2 === 0) end = seg.indexOf('>', end + 1);
    const tagText = seg.slice(0, end === -1 ? 1200 : end);
    const cls = extractClass(tagText);
    upto.push({ line, cls });
    totalBtns++;
    idx = at + m.index + 1;
  }
  if (upto.length === 0) continue;
  const fileReport = { file, buttons: upto, pairs: [], violations: [] };
  for (let k = 0; k + 1 < upto.length; k++) {
    const a = upto[k], b = upto[k + 1];
    if (b.line - a.line <= 45 && a.cls !== b.cls) {
      fileReport.pairs.push({ a: { line: a.line, cls: a.cls }, b: { line: b.line, cls: b.cls } });
    }
  }
  const patterns = [
    { re: /active:scale|active:translate|hover:-?translate|active:-?translate/, why: 'v3-no-displacement' },
    { re: /shadow(?!-none)/, why: 'shadow-token' },
  ];
  for (const b of upto) {
    for (const { re, why } of patterns) {
      const m = b.cls.match(re);
      if (m) fileReport.violations.push({ line: b.line, why, hit: m[0], cls: b.cls });
    }
  }
  report.push(fileReport);
}
console.error('total buttons:', totalBtns);
console.log(JSON.stringify(report, null, 1));
