// v4 internal-alignment audit: every <button> classified by
//  - layout: hasFlex (inline-flex|flex) + itemsCenter + justifyCenter
//  - content: hasIconChild (Icon*/svg/img/Lucide descendant), hasDirectText
//  - width mode: fixed-width candidates (w-full|flex-1|min-w-|w-\d) needing justify-center
//  - icon spacing pattern: gap-N vs mr-N on the icon
// Output: audit/v4-align.json + console buckets.
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

const records = [];
for (const file of walk(ROOT)) {
  const src = fs.readFileSync(file, 'utf8');
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  function visit(node) {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const open = ts.isJsxElement(node) ? node.openingElement : node;
      if (open.tagName.getText() === 'button') {
        let cls = '';
        for (const a of open.attributes.properties) {
          if (ts.isJsxAttribute(a) && (a.name.getText() === 'className' || a.name.getText() === 'class') && a.initializer) cls = a.initializer.getText();
        }
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        // children probe
        let iconChild = false, directText = false, textExpr = false;
        if (ts.isJsxElement(node)) {
          (function dv(n, depth) {
            for (const c of n.children) {
              if (ts.isJsxText(c) && c.getText().trim()) directText = true;
              else if (ts.isJsxExpression(c) && c.expression) {
                const e = c.expression.getText();
                if (!e.includes('<') && /('|"|t\()/.test(e)) textExpr = true;
              } else if ((ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c)) && depth < 3) {
                const co = ts.isJsxElement(c) ? c.openingElement : c;
                const tg = co.tagName.getText();
                if (/(Icon|Lucide|Svg|svg|img|Image)$/.test(tg) || tg === 'img' || tg === 'svg') iconChild = true;
                if (ts.isJsxElement(c)) dv(c, depth + 1);
              }
            }
          })(node, 0);
        }
        const flat = cls.replace(/\s+/g, ' ');
        records.push({
          file, line: line + 1, cls: flat.slice(0, 220),
          hasFlex: /(^|\s|"|'|`)(inline-)?flex(\s|"|'|$|\})/.test(flat),
          itemsCenter: /items-center/.test(flat),
          justifyCenter: /justify-center/.test(flat),
          fixedWidth: /w-full|flex-1|min-w-\[|min-w-\d|\bw-\d/.test(flat),
          textLeft: /text-left/.test(flat),
          family: /btn-idchat|btn-welcome/.test(flat),
          iconChild, directText, textExpr,
          iconGap: /gap-[\d.]+/.test(flat),
          iconMr: /mr-[\d.]+/.test(flat),
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

const btns = records;
const noFlex = btns.filter((b) => !b.hasFlex);
const noFlexWithIcon = noFlex.filter((b) => b.iconChild);
const noFlexWithText = noFlex.filter((b) => (b.directText || b.textExpr) && !b.iconChild);
const flexNoCenter = btns.filter((b) => b.hasFlex && !b.itemsCenter);
const fixedNoJustify = btns.filter((b) => b.hasFlex && b.itemsCenter && !b.justifyCenter && b.fixedWidth);
const iconGapMixed = btns.filter((b) => b.iconChild && b.hasFlex && b.iconMr && !b.iconGap);

const out = { total: btns.length, noFlexWithIcon, noFlexWithText, flexNoCenter, fixedNoJustify, iconGapMixed };
fs.writeFileSync('audit/v4-align.json', JSON.stringify(out, null, 1));
console.log('buttons:', btns.length,
  '| noFlex+icon:', noFlexWithIcon.length,
  '| noFlex+text:', noFlexWithText.length,
  '| flex w/o items-center:', flexNoCenter.length,
  '| fixed-width w/o justify-center:', fixedNoJustify.length,
  '| icon mr-pattern (no gap):', iconGapMixed.length);
const short = (arr, n) => arr.slice(0, n).forEach((b) => console.log(' ', b.file.split('/').pop() + ':' + b.line, (b.iconChild ? '[icon]' : '') + (b.family ? '[family]' : ''), b.cls.slice(0, 110)));
console.log('\n== noFlex WITH icon (worst) =='); short(noFlexWithIcon, 40);
console.log('\n== noFlex text-only =='); short(noFlexWithText, 25);
