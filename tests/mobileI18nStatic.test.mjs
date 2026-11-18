import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * REQ-E-18 static checks for the mobile client:
 *
 *   1. src/mobile/i18n.ts and lazily registered feature dictionaries: zh/en
 *      key parity, no empty values, every key prefixed `mobile.`.
 *   2. Hard-coded user-facing string scan over every .ts/.tsx under
 *      src/mobile (excluding i18n.ts): fail on any CJK character in source,
 *      and on JSX text nodes / placeholder|title|alt|aria-label literals
 *      with 3+ consecutive English words (single words like "OK" stay
 *      allowed).
 *
 * Everything user-visible must route through mobileI18n.t() so the login
 * and app bundles stay bilingual (REQ-E-18, REQ-E-19).
 */

const MOBILE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/mobile');
const I18N_FILE = path.join(MOBILE_ROOT, 'i18n.ts');
const TASK_CENTER_I18N_FILE = path.join(MOBILE_ROOT, 'taskCenterI18n.ts');

/** Walks a string-literal-aware `{ ... }` body starting at `openIndex`. */
function extractObjectBody(source, openIndex) {
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = true;
      quote = ch;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  throw new Error('unbalanced braces while scanning i18n dictionaries');
}

function parseDictionary(source, varName) {
  const decl = source.indexOf(`const ${varName}: MobileDictionary = {`);
  assert.notEqual(decl, -1, `i18n.ts must declare ${varName}`);
  const open = source.indexOf('{', decl);
  const body = extractObjectBody(source, open);
  const entries = new Map();
  // A value is either a string literal or a module-constant reference (the
  // build-mode-conditional demo notice). Constants are verified against
  // their `const NAME = MOCK_LOGIN_API ? '<copy>' : ''` declaration below.
  const pattern = /'(mobile\.[A-Za-z0-9_.-]+)':\s*('((?:\\.|[^'\\])*)'|([A-Za-z_$][A-Za-z0-9_$]*)),/g;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    if (match[3] !== undefined) {
      entries.set(match[1], { kind: 'literal', value: match[3].replace(/\\'/g, "'") });
    } else {
      entries.set(match[1], { kind: 'constant', value: match[4] });
    }
  }
  return { body, entries };
}

/** Resolves the mock-mode copy behind a conditional constant declaration. */
function constantTrueBranch(source, name) {
  const decl = source.match(
    new RegExp(`const ${name}(?:: string)? = MOCK_LOGIN_API \\? '((?:\\\\.|[^'\\\\])*)' : ''`),
  );
  return decl ? decl[1] : null;
}

const i18nSource = readFileSync(I18N_FILE, 'utf8');
const taskCenterI18nSource = readFileSync(TASK_CENTER_I18N_FILE, 'utf8');
const zhBase = parseDictionary(i18nSource, 'zhTranslations');
const enBase = parseDictionary(i18nSource, 'enTranslations');
const zhTaskCenter = parseDictionary(taskCenterI18nSource, 'zhTaskCenterTranslations');
const enTaskCenter = parseDictionary(taskCenterI18nSource, 'enTaskCenterTranslations');
const zh = {
  body: zhBase.body + zhTaskCenter.body,
  entries: new Map([...zhBase.entries, ...zhTaskCenter.entries]),
};
const en = {
  body: enBase.body + enTaskCenter.body,
  entries: new Map([...enBase.entries, ...enTaskCenter.entries]),
};

test('mobile i18n: zh/en key parity, no empty values, mobile. prefix', () => {
  const zhKeys = [...zh.entries.keys()].sort();
  const enKeys = [...en.entries.keys()].sort();
  assert.ok(zhKeys.length >= 20, `expected a real dictionary, got ${zhKeys.length} keys`);
  assert.deepEqual(zhKeys, enKeys, 'zh/en dictionaries must have identical key sets');

  for (const [dictName, dict] of [['zh', zh.entries], ['en', en.entries]]) {
    for (const [key, entry] of dict) {
      assert.ok(key.startsWith('mobile.'), `${dictName} key must start with mobile.: ${key}`);
      if (entry.kind === 'literal') {
        assert.ok(
          entry.value.trim().length > 0,
          `${dictName} value for ${key} must not be empty`,
        );
      } else {
        // Constant reference (build-mode-conditional copy): the true branch
        // is what the mock/dev mode renders and must be real copy.
        const copy = constantTrueBranch(i18nSource, entry.value);
        assert.ok(copy, `${dictName} ${key} references unknown conditional constant ${entry.value}`);
        assert.ok(
          copy.trim().length > 0,
          `${dictName} conditional constant ${entry.value} must carry non-empty copy`,
        );
      }
    }
  }

  // The declaration block must not contain keys the regex failed to parse
  // (catches trailing-comma/quote typos instead of silently dropping keys).
  const zhKeyLiterals = zh.body.match(/'mobile\.[A-Za-z0-9_.-]+':/g) ?? [];
  assert.equal(zhKeyLiterals.length, zh.entries.size, 'unparsed zh dictionary entries');
  const enKeyLiterals = en.body.match(/'mobile\.[A-Za-z0-9_.-]+':/g) ?? [];
  assert.equal(enKeyLiterals.length, en.entries.size, 'unparsed en dictionary entries');
});

function listSourceFiles(dir, extensions) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

const CJK_PATTERN = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;

const scannedFiles = listSourceFiles(MOBILE_ROOT, ['.ts', '.tsx']).filter(
  (file) => !file.endsWith('/i18n.ts') && !file.endsWith('/taskCenterI18n.ts') && !statSync(file).isDirectory(),
);

test('mobile sources contain no CJK characters outside i18n.ts', () => {
  const offenders = [];
  for (const file of scannedFiles) {
    const source = readFileSync(file, 'utf8');
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      if (CJK_PATTERN.test(line)) {
        offenders.push(`${path.relative(MOBILE_ROOT, file)}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], 'CJK found outside src/mobile/i18n.ts dictionaries');
});

/**
 * Explicit, per-occurrence allowlist for hard-coded user-facing strings.
 * Every entry needs a comment in this file explaining why t() cannot be used.
 * Keep empty: the demo routes all copy through t().
 */
const ALLOWLIST = [
  // { file: 'app/components/Example.tsx', text: 'OK' }
];

const WORD_RUN = /[A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z][A-Za-z'’-]*){2,}/;

function findHardCodedText(relativeFile, source) {
  const findings = [];
  const jsxTextPattern = />([^<>{}"'`]+)</g;
  let match;
  while ((match = jsxTextPattern.exec(source)) !== null) {
    const text = match[1].trim();
    if (!text) continue;
    if (WORD_RUN.test(text)) {
      findings.push(`JSX text node: "${text.trim()}"`);
    }
  }
  const attrPattern = /(?:placeholder|title|alt|aria-label)\s*=\s*("([^"]*)"|'([^']*)')/g;
  while ((match = attrPattern.exec(source)) !== null) {
    const value = match[2] ?? match[3] ?? '';
    if (WORD_RUN.test(value)) {
      findings.push(`attribute literal: "${value.trim()}"`);
    }
  }
  return findings.map((finding) => `${relativeFile}: ${finding}`);
}

test('mobile tsx contains no hard-coded multi-word user-facing strings', () => {
  const offenders = [];
  for (const file of scannedFiles) {
    if (!file.endsWith('.tsx')) continue;
    const relative = path.relative(MOBILE_ROOT, file);
    const source = readFileSync(file, 'utf8');
    for (const finding of findHardCodedText(relative, source)) {
      const isAllowed = ALLOWLIST.some((allowed) => finding.includes(allowed.file) && finding.includes(allowed.text));
      if (!isAllowed) offenders.push(finding);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'route user-visible strings through mobile i18n t() (or add a justified ALLOWLIST entry)',
  );
});
