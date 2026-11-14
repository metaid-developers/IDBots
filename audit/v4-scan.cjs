// v4 pill-purge re-census scanner: parse every src/renderer file with the
// TypeScript AST, extract each JSX element whose className initializer carries
// `rounded-full`, and record clickability (button/a/onClick/role=button) plus
// text-bearing children (JsxText or non-element expression children).
// Output: audit/v4-current.json (full records) + console summary.
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = 'src/renderer';
function walk(dir) {
  let out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out = out.concat(walk(p));
    else if (/\.(tsx|ts|js)$/.test(name)) out.push(p);
  }
  return out;
}

const CLICKABLE_TAGS = new Set(['button', 'a', 'Link', 'NavLink']);
const TEXT_ONCLICK = /^on[A-Z]/;

const records = [];
const rawTextualDeltas = []; // textual rounded-full not captured by a JSX className attr

for (const file of walk(ROOT)) {
  const src = fs.readFileSync(file, 'utf8');
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, /*setParentNodes*/ true, kind);

  const textualCount = (src.match(/rounded-full/g) || []).length;
  let attrCount = 0;
  const spans = [];
  const initSpans = [];
  const occOffsetsByRecord = new Map();

  function attrInfo(open) {
    let classNameRaw = null;
    let onClick = false;
    let role = null;
    let href = false;
    let classInitSpan = null;
    for (const a of open.attributes.properties) {
      if (ts.isJsxAttribute(a)) {
        const name = a.name.getText();
        if (name === 'className' || name === 'class') {
          classNameRaw = a.initializer ? a.initializer.getText() : '';
          if (a.initializer) classInitSpan = [a.initializer.getStart(sf), a.initializer.getEnd(sf)];
        }
        else if (TEXT_ONCLICK.test(name)) onClick = true;
        else if (name === 'role' && a.initializer) role = a.initializer.getText();
        else if (name === 'href') href = true;
      }
    }
    return { classNameRaw, onClick, role, href, classInitSpan };
  }

  function visit(node) {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const open = ts.isJsxElement(node) ? node.openingElement : node;
      const info = attrInfo(open);
      if (info.classNameRaw && info.classNameRaw.includes('rounded-full')) {
        attrCount++;
        const tag = open.tagName.getText();
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        spans.push([node.getStart(sf), node.getEnd(sf)]);
        if (info.classInitSpan) {
          initSpans.push(info.classInitSpan);
          // per-occurrence absolute offsets inside this initializer (census alignment keys)
          const [a, b] = info.classInitSpan;
          const initText = src.slice(a, b);
          const occOffsets = [];
          let scanFrom = 0;
          while (true) {
            const at = initText.indexOf('rounded-full', scanFrom);
            if (at === -1) break;
            occOffsets.push(a + at);
            scanFrom = at + 1;
          }
          occOffsetsByRecord.set(node.getStart(sf), occOffsets);
        }
        // children analysis
        const textParts = [];
        const exprs = [];
        let descendantClickable = null; // {tag}
        let iconChild = false;
        if (ts.isJsxElement(node)) {
          (function dv(n) {
            for (const c of n.children) {
              if (ts.isJsxText(c)) {
                const t = c.getText();
                if (t.trim()) textParts.push(t.trim().replace(/\s+/g, ' '));
              } else if (ts.isJsxExpression(c) && c.expression) {
                const e = c.expression.getText();
                exprs.push(e.replace(/\s+/g, ' ').slice(0, 90));
              } else if (ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c)) {
                const co = ts.isJsxElement(c) ? c.openingElement : c;
                const ctag = co.tagName.getText();
                if (/(Icon|Lucide|Svg|svg|img|Image)$/.test(ctag) || ctag === 'img' || ctag === 'svg') iconChild = true;
                const ci = attrInfo(co);
                const cClickable = CLICKABLE_TAGS.has(ctag) || ci.onClick || (ci.role && ci.role.includes('button'));
                if (cClickable && !descendantClickable) descendantClickable = ctag;
                if (ts.isJsxElement(c)) dv(c);
              }
            }
          })(node);
        }
        records.push({
          file,
          line: line + 1,
          tag,
          selfClosing: ts.isJsxSelfClosingElement(node),
          className: info.classNameRaw.replace(/\s+/g, ' ').slice(0, 300),
          occCount: (info.classNameRaw.match(/rounded-full/g) || []).length,
          elemPos: node.getStart(sf),
          initPos: info.classInitSpan ? info.classInitSpan[0] : null,
          occOffsets: occOffsetsByRecord.get(node.getStart(sf)) || [],
          onClick: info.onClick,
          href: info.href,
          role: info.role,
          text: textParts.join(' | ').slice(0, 120),
          exprs: exprs.slice(0, 3),
          descClickable: descendantClickable,
          iconChild,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  if (textualCount !== attrCount) {
    // true outside occurrences: textual positions falling OUTSIDE every captured element span
    const lines = src.split('\n');
    let idx = 0;
    const positions = [];
    while (true) {
      const at = src.indexOf('rounded-full', idx);
      if (at === -1) break;
      positions.push(at);
      idx = at + 1;
    }
    for (const at of positions) {
      const inInit = initSpans.some(([a, b]) => at >= a && at < b);
      if (!inInit) {
        const inElem = spans.some(([a, b]) => at >= a && at < b);
        const l = src.slice(0, at).split('\n').length;
        rawTextualDeltas.push({ file, line: l, pos: at, insideElementButNoClassNameAttr: inElem, snippet: lines[l - 1].trim().slice(0, 200) });
      }
    }
  }
}

fs.mkdirSync('audit', { recursive: true });
fs.writeFileSync('audit/v4-current.json', JSON.stringify({ generatedAt: new Date().toISOString(), root: ROOT, count: records.length, rawTextualDeltas, records }, null, 1));

console.log('AST className rounded-full records:', records.length);
console.log('textual deltas (non-JSX-attr occurrences):', rawTextualDeltas.length);
for (const d of rawTextualDeltas) console.log('  DELTA', d.file + ':' + d.line, d.snippet);
