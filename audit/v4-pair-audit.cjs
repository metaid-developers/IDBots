// v4 pair audit: ALL <button> elements (AST), effective-geometry resolution
// with the btn-idchat family overlay (family CSS sits after @tailwind
// utilities in index.css, so px-*/py-*/rounded-* utilities on family buttons
// are DEAD — family padding 0.5rem/1rem, radius var(--rounded)=12px, border
// 1px, fw 500 always wins). Adjacent-pair (≤45 lines) effective-geometry
// comparison: radius/padding-x/padding-y/border/height must match within a
// same-container group; only fill & text colour may differ.
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

const num = (tok) => {
  // tailwind spacing N → N*4px (supports .5 steps)
  const v = parseFloat(tok);
  return Number.isFinite(v) ? v * 4 : null;
};

function resolveGeometry(rawCls) {
  // strip JSX initializer wrappers (backticks/quotes/braces) so ^ anchors work
  const cls = rawCls.replace(/^[`"'{\s]+|[`"'}\s]+$/g, '');
  const isFamily = /btn-idchat/.test(cls);
  const isWelcome = /btn-welcome-primary/.test(cls);
  const g = { isFamily, isWelcome, radius: null, py: null, px: null, border: null, lineHeight: null, ambiguous: false, displacement: /active:scale|active:translate|hover:-?translate|active:-?translate|hover:scale/.test(cls), shadow: /(^|\s)shadow(?!-none)/.test(cls) };

  if (isFamily) {
    g.radius = 12; g.py = 8; g.px = 16; g.border = 1;
    // dead utilities on family buttons (hygiene flag, not geometry)
    g.deadUtilities = /(?:^|\s)(?:px-\d|py-\d|p-\d|rounded[\w\[\]().-]*)/.test(cls.replace(/btn-idchat[\w-]*/g, ''));
  } else if (isWelcome) {
    g.radius = 12; g.py = 13; g.px = 30; g.border = 2;
  } else {
    // radius
    if (/rounded-full/.test(cls)) g.radius = 'pill';
    else if (/rounded-\[var\(--shape-radius-sm\)\]/.test(cls)) g.radius = 8;
    else if (/rounded-\[var\(--shape-radius-md\)\]/.test(cls)) g.radius = 10;
    else if (/rounded-\[var\(--rounded\)\]/.test(cls)) g.radius = 12;
    else if (/rounded-2xl/.test(cls)) g.radius = 16;
    else if (/rounded-xl/.test(cls)) g.radius = 12;
    else if (/rounded-lg/.test(cls)) g.radius = 8;
    else if (/rounded-md/.test(cls)) g.radius = 6;
    else if (/(^|\s)rounded(\s|"|'|$)/.test(cls)) g.radius = 4;
    else if (/rounded-none/.test(cls)) g.radius = 0;
    // padding-y
    let m = cls.match(/(?:^|\s)py-([\d.]+)/);
    if (m) g.py = num(m[1]);
    else { m = cls.match(/(?:^|\s)p-([\d.]+)/); if (m) g.py = num(m[1]); }
    // padding-x
    m = cls.match(/(?:^|\s)px-([\d.]+)/);
    if (m) g.px = num(m[1]);
    else { m = cls.match(/(?:^|\s)p-([\d.]+)/); if (m) g.px = num(m[1]); }
    // border width: 'border' (1px), 'border-2' (2px); color-only border-[..]/border-red-600 do NOT set width
    if (/(^|\s)border-2(\s|"|'|$)/.test(cls)) g.border = 2;
    else if (/(^|\s)border(\s|"|'|$|\})/.test(cls)) g.border = 1;
    else if (/border-\[var\(--btn-primary-edge\)\]/.test(cls)) g.border = 1; // only when paired with border? conservative: width token present? color-only → tailwind border-color needs width class; treat as 1 if also 'border' present else unknown
    // line height from text size
    m = cls.match(/(?:^|\s)text-\[(\d+)px\]/);
    if (m) g.lineHeight = parseInt(m[1], 10);
    else if (/(?:^|\s)text-xs(\s|"|'|$)/.test(cls)) g.lineHeight = 16;
    else if (/(?:^|\s)text-sm(\s|"|'|$)/.test(cls)) g.lineHeight = 20;
    else if (/(?:^|\s)text-base(\s|"|'|$)/.test(cls)) g.lineHeight = 24;
    else if (/(?:^|\s)text-lg(\s|"|'|$)/.test(cls)) g.lineHeight = 28;
  }
  if (/text-\[1[01]px\]/.test(cls) && g.lineHeight == null) g.lineHeight = parseInt(cls.match(/text-\[(\d+)px\]/)[1], 10);
  // ambiguous when conditional branches carry differing padding tokens
  const pyTokens = (cls.match(/(?:^|\s)p[xy]-[\d.]+/g) || []).map((s) => s.trim());
  const uniq = [...new Set(pyTokens.map((t) => t.split('-').slice(0, 1)[0] + t.split('-')[1]))];
  if (pyTokens.length > 2) g.ambiguous = true;
  g.height = g.py != null && g.lineHeight != null && g.border != null ? g.py * 2 + g.lineHeight + g.border * 2 : null;
  return g;
}

function extractClass(open) {
  for (const a of open.attributes.properties) {
    if (ts.isJsxAttribute(a) && (a.name.getText() === 'className' || a.name.getText() === 'class')) {
      return a.initializer ? a.initializer.getText() : '';
    }
  }
  return '';
}

const files = walk(ROOT);
const all = [];
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  function visit(node) {
    if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node))) {
      const open = ts.isJsxElement(node) ? node.openingElement : node;
      if (open.tagName.getText() === 'button') {
        const raw = extractClass(open);
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        // nearest JsxElement ancestor = the container the button lives in
        let anc = node.parent;
        while (anc && !ts.isJsxElement(anc)) anc = anc.parent;
        const parentCls = anc && ts.isJsxElement(anc) ? extractClass(anc.openingElement) : '';
        all.push({ file, line: line + 1, cls: raw.replace(/\s+/g, ' ').slice(0, 260), geo: resolveGeometry(raw), parentLine: anc ? sf.getLineAndCharacterOfPosition(anc.getStart(sf)).line + 1 : 0, parentCls: parentCls.replace(/\s+/g, ' ').slice(0, 120) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

// pairing: TRUE same-container siblings — same parent element, adjacent among
// the parent's button children; flex direction noted from parent class.
const violations = [];
let pairCount = 0;
for (const file of [...new Set(all.map((b) => b.file))]) {
  const list = all.filter((b) => b.file === file).sort((a, b) => a.line - b.line);
  for (let i = 0; i + 1 < list.length; i++) {
    const a = list[i], b = list[i + 1];
    if (a.parentLine !== b.parentLine) continue; // not same container
    pairCount++;
    const ga = a.geo, gb = b.geo;
    if (ga.ambiguous || gb.ambiguous) { violations.push({ file, a, b, why: 'ambiguous-dynamic-padding' }); continue; }
    const diffs = [];
    if (ga.radius !== gb.radius) diffs.push(`radius ${ga.radius} vs ${gb.radius}`);
    if (ga.py !== gb.py) diffs.push(`py ${ga.py} vs ${gb.py}`);
    if (ga.px !== gb.px) diffs.push(`px ${ga.px} vs ${gb.px}`);
    if (ga.border !== gb.border) diffs.push(`border ${ga.border} vs ${gb.border}`);
    if (ga.height != null && gb.height != null && ga.height !== gb.height) diffs.push(`height≈${ga.height} vs ${gb.height}`);
    if (ga.displacement || gb.displacement) diffs.push('displacement-utility');
    if (diffs.length) violations.push({ file, a, b, why: diffs.join('; ') });
  }
}

fs.writeFileSync('audit/v4-pair-audit.json', JSON.stringify({ totalButtons: all.length, pairs: pairCount, violations }, null, 1));
console.log('buttons:', all.length, 'pairs:', pairCount, 'violation-candidates:', violations.length);
for (const v of violations) {
  console.log('\n', v.file.split('/').pop() + ':' + v.a.line, '⟷', v.b.line, '|', v.why);
  console.log('  A:', v.a.cls.slice(0, 150));
  console.log('  B:', v.b.cls.slice(0, 150));
}
