// v4 pair-audit fixer: deterministic className rewrites for the TRUE
// four-same violations found by audit/v4-pair-audit.cjs.
// Rules:
//  A) family-strip downgrade: remove btn-idchat-* token, inject yellow
//     identity (border-[var(--btn-primary-edge)] + bg-claude-accent +
//     text-claude-accentInk + brightness hover/active + transition-[filter]);
//     existing px/py/text utilities become LIVE and mirror the partner.
//     Radius: keep existing rounded-* if present, else copy partner tier.
//  B) missing border on filled buttons: red→border-red-600 (+text-white if
//     text-gray-900), emerald→border-emerald-600, yellow→border-[var(--btn-primary-edge)]
//  C) displacement strip: active:scale-[0.9x] tokens removed
//  D) size alignment (explicit per site)
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const audit = JSON.parse(fs.readFileSync('audit/v4-pair-audit.json', 'utf8'));

const ROOT = 'src/renderer';
function classAt(file, line) {
  const src = fs.readFileSync(file, 'utf8');
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  let found = null;
  function visit(node) {
    if (found) return;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const open = ts.isJsxElement(node) ? node.openingElement : node;
      if (open.tagName.getText() === 'button') {
        const { line: ln } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        if (ln + 1 === line) {
          for (const a of open.attributes.properties) {
            if (ts.isJsxAttribute(a) && a.name.getText() === 'className' && a.initializer) {
              found = { full: a.initializer.getText(), pos: a.initializer.getStart(sf), end: a.initializer.getEnd(sf), sf, src };
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return found;
}

// --- fix plan: keyed by "file|line" (button to rewrite), rule + params ---
const fixes = [];
function addFix(file, line, rule, params = {}) { fixes.push({ file, line, rule, params }); }

// A) family-strip downgrades (partner tier noted for radius fallback)
const FAMILY_STRIP = [
  ['src/renderer/components/Settings.tsx', 4088, 'rounded-[var(--rounded)]'],
  ['src/renderer/components/agentGame/AgentGameConsentCard.tsx', 103, null],
  ['src/renderer/components/cowork/A2AApprovalBar.tsx', 68, null],
  ['src/renderer/components/gigSquare/GigSquareMyServicesModal.tsx', 938, 'rounded-lg', 'outline'],
  ['src/renderer/components/gigSquare/GigSquareMyServicesModal.tsx', 1318, null],
  ['src/renderer/components/gigSquare/GigSquareMyServicesModal.tsx', 1622, null],
  ['src/renderer/components/gigSquare/GigSquareRefundsModal.tsx', 411, 'rounded-lg', 'outline'],
  ['src/renderer/components/mcp/McpServerFormModal.tsx', 439, null],
  ['src/renderer/components/metabots/KnowledgeBasePanel.tsx', 459, 'rounded-[var(--rounded)]'],
  ['src/renderer/components/metabots/KnowledgeBasePanel.tsx', 568, 'rounded-lg'],
  ['src/renderer/components/metabots/MetaBotCreateForm.tsx', 326, 'rounded-[var(--rounded)]'],
  ['src/renderer/components/metabots/MetaBotEditTabs.tsx', 630, 'rounded-[var(--rounded)]'],
  ['src/renderer/components/preference/PreferenceSealConfirmModal.tsx', 60, null],
  ['src/renderer/components/scheduledTasks/TaskForm.tsx', 623, 'rounded-lg'],
  ['src/renderer/components/settings/MemorySettings.tsx', 1856, 'rounded-lg'],
  ['src/renderer/components/settings/MemorySettings.tsx', 2102, 'rounded-lg'],
  ['src/renderer/components/skills/SkillsManager.tsx', 740, 'rounded-lg'],
  ['src/renderer/components/skills/SkillsManager.tsx', 989, null],
];
for (const [f, l, radius, variant] of FAMILY_STRIP) addFix(f, l, 'family-strip', { radius, variant });

// B) missing border on filled buttons
const BORDER_ADD = [
  ['src/renderer/components/groupTasks/AcceptanceSummaryCard.tsx', 105, 'border border-emerald-600 '],
  ['src/renderer/components/groupTasks/GroupTaskCloseConfirmModal.tsx', 115, null], // dynamic branches, handled specially
  ['src/renderer/components/groupTasks/GroupTaskDetailView.tsx', 704, 'border border-emerald-600 '],
  ['src/renderer/components/groupTasks/GroupTaskKickConfirmModal.tsx', 70, 'border border-red-600 '],
  ['src/renderer/components/im/IMSettings.tsx', 1448, 'border border-[var(--btn-primary-edge)] '],
  ['src/renderer/components/longTermTasks/LongTermTaskCard.tsx', 161, 'border border-emerald-600 '],
  ['src/renderer/components/longTermTasks/LongTermTaskCard.tsx', 195, 'border border-red-600 '],
  ['src/renderer/components/longTermTasks/LongTermTaskDetail.tsx', 642, 'border border-red-600 '],
  ['src/renderer/components/mcp/McpManager.tsx', 622, 'border border-red-600 '],
  ['src/renderer/components/metaapps/myApps/MetaAppDeleteModal.tsx', 37, 'border border-red-600 '],
  ['src/renderer/components/metabots/MetaBotNftWalletModal.tsx', 439, 'border border-[var(--btn-primary-edge)] '],
  ['src/renderer/components/projects/ProjectsManager.tsx', 269, 'border border-red-600 '],
  ['src/renderer/components/scheduledTasks/DeleteConfirmModal.tsx', 47, 'border border-red-600 '],
  ['src/renderer/components/settings/PaymentReceivingSettings.tsx', 392, 'border border-[var(--btn-primary-edge)] '],
  ['src/renderer/components/skills/SkillsManager.tsx', 1023, 'border border-red-600 '],
  ['src/renderer/components/skills/SkillsManager.tsx', 1065, 'border border-red-600 '],
];
for (const [f, l, token] of BORDER_ADD) addFix(f, l, 'border-add', { token });

// NftWalletModal yellow buttons (582..1216): border-[var(--btn-primary-edge)]
for (const l of [582, 634, 705, 823, 873, 951, 1085, 1138, 1209]) {
  addFix('src/renderer/components/metabots/MetaBotNftWalletModal.tsx', l, 'border-add', { token: 'border border-[var(--btn-primary-edge)] ' });
}

// C) displacement strips (exact token)
const DISPLACEMENT = [
  ['src/renderer/components/Settings.tsx', 3150],
  ['src/renderer/components/Settings.tsx', 3165],
  ['src/renderer/components/Settings.tsx', 4132],
  ['src/renderer/components/cowork/CoworkConversationSearch.tsx', 116],
  ['src/renderer/components/cowork/CoworkConversationSearch.tsx', 126],
  ['src/renderer/components/cowork/CoworkSessionDetail.tsx', 4768],
  ['src/renderer/components/im/IMSettings.tsx', 1157],
  ['src/renderer/components/im/IMSettings.tsx', 1167],
  ['src/renderer/components/im/IMSettings.tsx', 1275],
  ['src/renderer/components/im/IMSettings.tsx', 1285],
  ['src/renderer/components/user/UserBackupMnemonicModal.tsx', 118],
];
for (const [f, l] of DISPLACEMENT) addFix(f, l, 'displacement-strip', {});

// D) explicit size alignments
addFix('src/renderer/components/metabots/KnowledgeBasePanel.tsx', 435, 'text-replace', { from: 'px-3 py-2 text-xs rounded-xl', to: 'px-3 py-2 text-sm rounded-xl' });
addFix('src/renderer/components/user/UserBackupMnemonicModal.tsx', 118, 'text-replace', { from: 'inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl', to: 'inline-flex items-center px-4 py-2 text-sm font-medium rounded-xl' });
addFix('src/renderer/components/settings/PaymentReceivingSettings.tsx', 392, 'text-replace', { from: 'px-4 py-1.5 text-xs font-medium rounded-xl', to: 'px-3 py-1.5 text-xs font-medium rounded-xl' });

// execute
const edits = new Map(); // file -> [{pos, end, text}]
let ok = 0, fail = [];
for (const fx of fixes) {
  const hit = classAt(fx.file, fx.line);
  if (!hit) { fail.push(fx.file + ':' + fx.line + ' button/class not found'); continue; }
  let full = hit.full;
  let inner = full;
  const stripped = {};
  if (/^`/.test(inner)) { stripped.tpl = true; }
  // operate on the raw initializer text (keeps `${}` intact); string ops below are token-level
  let text = full;
  if (fx.rule === 'family-strip') {
    if (!/btn-idchat-primary(-filled)?/.test(text)) { fail.push(fx.file + ':' + fx.line + ' no family token: ' + text.slice(0, 60)); continue; }
    text = text.replace(/btn-idchat-primary(-filled)?\s?/, '');
    // radius: keep existing; if none, insert params.radius after leading layout tokens or at start of first quoted segment
    if (!/rounded[\w[\]().-]/.test(text)) {
      const r = fx.params.radius || 'rounded-[var(--shape-radius-md)]';
      if (stripped.tpl) text = text.replace(/(`|'|")/, '$1' + r + ' ');
      else text = '"' + r + ' ' + text.slice(1);
    }
    const identity = fx.params.variant === 'outline'
      ? 'border border-[var(--color-primary)] bg-[var(--bg-panel)] text-claude-text hover:brightness-[0.96] active:brightness-[0.9] transition-[filter] '
      : 'border border-[var(--btn-primary-edge)] bg-claude-accent text-claude-accentInk hover:brightness-[0.96] active:brightness-[0.9] transition-[filter] ';
    // inject after the first quote of the class value (start of a concrete segment)
    text = text.replace(/(`|'|")/, '$1' + identity);
  } else if (fx.rule === 'border-add') {
    if (fx.params.token == null) { fail.push(fx.file + ':' + fx.line + ' special-case must be manual'); continue; }
    if (/(^|\s|"|'|`)border(\s|"|'|$)/.test(text) && !/border-\[var\(--btn-primary-edge\)\]/.test(text)) {
      // already has plain border? then skip (should not happen for this list)
      fail.push(fx.file + ':' + fx.line + ' already bordered: ' + text.slice(0, 60)); continue;
    }
    text = text.replace(/(`|'|")/, '$1' + fx.params.token);
    if (/text-gray-900/.test(text)) text = text.replace(/text-gray-900/, 'text-white');
  } else if (fx.rule === 'displacement-strip') {
    const before = text;
    text = text.replace(/\s?active:scale-\[[\d.]+\]/g, '');
    if (text === before) { fail.push(fx.file + ':' + fx.line + ' no displacement token'); continue; }
  } else if (fx.rule === 'text-replace') {
    if (!text.includes(fx.params.from)) { fail.push(fx.file + ':' + fx.line + ' from-string missing'); continue; }
    text = text.replace(fx.params.from, fx.params.to);
  }
  if (text !== full) {
    if (!edits.has(fx.file)) edits.set(fx.file, []);
    edits.get(fx.file).push({ pos: hit.pos, end: hit.end, text });
    ok++;
  }
}

// GroupTaskCloseConfirmModal dynamic red/emerald branches — manual precise edits
{
  const f = 'src/renderer/components/groupTasks/GroupTaskCloseConfirmModal.tsx';
  const src = fs.readFileSync(f, 'utf8');
  const want = (s) => src.includes(s);
  let text = src;
  const subs = [
    ["'bg-red-500 hover:bg-red-600'", "'bg-red-500 border border-red-600 hover:bg-red-600'"],
    ["'bg-emerald-500 hover:bg-emerald-600'", "'bg-emerald-500 border border-emerald-600 hover:bg-emerald-600'"],
  ];
  let n = 0;
  for (const [a, b] of subs) { if (want(a)) { text = text.split(a).join(b); n++; } }
  if (n === 2) { fs.writeFileSync(f, text); console.log('manual-edit GroupTaskCloseConfirmModal branches: 2'); }
  else fail.push('GroupTaskCloseConfirmModal branches not both found (n=' + n + ')');
}

// apply file edits (descending pos to keep offsets valid)
for (const [file, list] of edits) {
  const src = fs.readFileSync(file, 'utf8');
  list.sort((a, b) => b.pos - a.pos);
  let out = src;
  for (const e of list) out = out.slice(0, e.pos) + e.text + out.slice(e.end);
  fs.writeFileSync(file, out);
  console.log('edited', file.split('/').pop(), 'sites:', list.length);
}
console.log('fixes applied:', ok, 'failures:', fail.length);
for (const f of fail) console.log('  FAIL', f);
