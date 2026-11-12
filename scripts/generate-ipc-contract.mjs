// REQ-A-23 — IPC contract generator.
//
// Parses src/main/preload.ts with the TypeScript compiler API and writes
// src/mobile/generated/ipc-contract.json: for every method the preload
// exposes on window.electron, its dot path (for example `cowork.startSession`),
// kind (`invoke`, `on`, `send`, `value`, `custom`), the IPC channel, and the
// argument names the wrapper forwards.
//
// The preload is a sandboxed Electron preload: it cannot import shared modules
// at runtime, so this script parses source instead of importing. It is the
// single source of truth for the mobile API surface (WS-E builds against the
// generated JSON; the gateway and tests check every channel against the
// REQ-A-17 allowlist data).
//
// Wrappers the classifier cannot understand become `kind: 'custom'` and fail
// the run unless scripts/ipc-contract-overrides.json documents them (kind,
// channel, note). Overrides for paths that no longer exist are stale and also
// fail the run.
//
// Usage:
//   node scripts/generate-ipc-contract.mjs            write the JSON file
//   node scripts/generate-ipc-contract.mjs --check    fail if the file is stale
//   node scripts/generate-ipc-contract.mjs --stdout   print instead of write

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PRELOAD_PATH = path.join(ROOT, 'src', 'main', 'preload.ts');
const OVERRIDES_PATH = path.join(ROOT, 'scripts', 'ipc-contract-overrides.json');
const OUTPUT_PATH = path.join(ROOT, 'src', 'mobile', 'generated', 'ipc-contract.json');
const CONTRACT_VERSION = '1.0.0';
const ALLOWLIST_VERSION = '1.0.3';

const CHECK = process.argv.includes('--check');
const STDOUT = process.argv.includes('--stdout');

// In --stdout mode the JSON is the only thing allowed on stdout; diagnostics
// move to stderr so the output stays machine-readable.
function logInfo(message) {
  if (STDOUT) process.stderr.write(`${message}\n`);
  else console.log(message);
}

function fail(messages) {
  const list = Array.isArray(messages) ? messages : [messages];
  for (const message of list) console.error(`ipc-contract: error: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

function unwrapExpression(expression) {
  let current = expression;
  for (;;) {
    if (
      ts.isAsExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function calleeText(call, sourceFile) {
  return call.expression.getText(sourceFile);
}

function stringLiteralArg(call, index, sourceFile) {
  const arg = call.arguments[index];
  if (arg && ts.isStringLiteral(arg)) return arg.text;
  return null;
}

// Unwrap a function body to a single effective expression, or null when the
// body has multiple statements (the `on` pattern handles that shape itself).
function singleExpressionBody(fn, sourceFile) {
  const body = fn.body;
  if (!body) return null;
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1) return null;
    const statement = body.statements[0];
    if (ts.isReturnStatement(statement) && statement.expression) {
      return unwrapExpression(statement.expression);
    }
    if (ts.isExpressionStatement(statement)) {
      return unwrapExpression(statement.expression);
    }
    return null;
  }
  return unwrapExpression(body);
}

function parameterNames(fn, sourceFile) {
  return fn.parameters.map((parameter) => parameter.name.getText(sourceFile));
}

// Detect the preload's unsubscribe pattern:
//   (callback) => {
//     const handler = (...) => callback(...);
//     ipcRenderer.on('<channel>', handler);
//     return () => { ipcRenderer.removeListener('<channel>', handler); };
//   }
// Returns the channel when both registrations use the same string literal,
// or null when the shape does not match.
function matchOnPattern(fn, sourceFile) {
  const body = fn.body;
  if (!body || !ts.isBlock(body)) return undefined;
  let onChannel = null;
  let sawOn = false;
  let removeChannel = null;
  let sawRemove = false;
  for (const statement of body.statements) {
    if (ts.isExpressionStatement(statement)) {
      const expression = unwrapExpression(statement.expression);
      if (expression && ts.isCallExpression(expression) && calleeText(expression, sourceFile) === 'ipcRenderer.on') {
        sawOn = true;
        onChannel = stringLiteralArg(expression, 0, sourceFile);
      }
      continue;
    }
    if (ts.isReturnStatement(statement) && statement.expression) {
      const returned = unwrapExpression(statement.expression);
      const returnedBody = returned && (ts.isArrowFunction(returned) || ts.isFunctionExpression(returned))
        ? returned.body
        : null;
      const expressions = [];
      if (returnedBody) {
        if (ts.isBlock(returnedBody)) {
          for (const inner of returnedBody.statements) {
            if (ts.isExpressionStatement(inner)) expressions.push(unwrapExpression(inner.expression));
            if (ts.isReturnStatement(inner) && inner.expression) expressions.push(unwrapExpression(inner.expression));
          }
        } else {
          expressions.push(unwrapExpression(returnedBody));
        }
      } else if (returned && ts.isCallExpression(returned)) {
        expressions.push(returned);
      }
      for (const expression of expressions) {
        if (expression && ts.isCallExpression(expression) && calleeText(expression, sourceFile) === 'ipcRenderer.removeListener') {
          sawRemove = true;
          removeChannel = stringLiteralArg(expression, 0, sourceFile);
        }
      }
    }
  }
  if (sawOn && sawRemove) {
    if (onChannel !== null && onChannel === removeChannel) return { channel: onChannel };
    return null; // matched the shape but not with a stable string channel
  }
  return undefined; // not the on pattern at all
}

function classifyLeaf(value, sourceFile) {
  const isFunction = ts.isArrowFunction(value) || ts.isFunctionExpression(value);
  if (!isFunction) {
    return { kind: 'value' };
  }

  const onPattern = matchOnPattern(value, sourceFile);
  if (onPattern) {
    return { kind: 'on', channel: onPattern.channel };
  }

  const expression = singleExpressionBody(value, sourceFile);
  if (expression && ts.isCallExpression(expression)) {
    const callee = calleeText(expression, sourceFile);
    if (callee === 'ipcRenderer.invoke' || callee === 'ipcRenderer.send') {
      const channel = stringLiteralArg(expression, 0, sourceFile);
      if (channel !== null) {
        return {
          kind: callee === 'ipcRenderer.invoke' ? 'invoke' : 'send',
          channel,
          args: parameterNames(value, sourceFile),
        };
      }
    }
  }
  return { kind: 'custom' };
}

// ---------------------------------------------------------------------------
// Preload walk
// ---------------------------------------------------------------------------

function extractMethods() {
  const sourceText = fs.readFileSync(PRELOAD_PATH, 'utf8');
  const sourceFile = ts.createSourceFile('preload.ts', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  let apiObject = null;
  const visit = (node) => {
    if (apiObject) return;
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(sourceFile) === 'contextBridge.exposeInMainWorld' &&
      node.arguments.length >= 2 &&
      ts.isObjectLiteralExpression(node.arguments[1])
    ) {
      apiObject = node.arguments[1];
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (!apiObject) fail('could not find contextBridge.exposeInMainWorld object literal in src/main/preload.ts');

  const methods = [];
  const walkObject = (objectLiteral, prefix) => {
    for (const property of objectLiteral.properties) {
      if (!ts.isPropertyAssignment(property)) {
        methods.push({ path: prefix || '(root)', kind: 'custom' });
        continue;
      }
      const name = property.name.getText(sourceFile);
      const pathName = prefix ? `${prefix}.${name}` : name;
      const value = unwrapExpression(property.initializer);
      if (ts.isObjectLiteralExpression(value)) {
        walkObject(value, pathName);
      } else {
        methods.push({ path: pathName, ...classifyLeaf(value, sourceFile) });
      }
    }
  };
  walkObject(apiObject, '');
  return methods;
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

function loadOverrides() {
  if (!fs.existsSync(OVERRIDES_PATH)) return {};
  return JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
}

function applyOverrides(methods, overrides) {
  const methodPaths = new Set(methods.map((method) => method.path));
  const stale = Object.keys(overrides).filter((key) => !methodPaths.has(key));
  if (stale.length > 0) {
    fail(stale.map((key) => `stale override "${key}" — no such preload method path (remove it from scripts/ipc-contract-overrides.json)`));
  }

  const errors = [];
  const applied = [];
  for (const method of methods) {
    const override = overrides[method.path];
    if (!override) continue;
    if (method.kind !== 'custom') {
      errors.push(`override for "${method.path}" — the wrapper classifies as ${method.kind}, the override is unnecessary; remove it`);
      continue;
    }
    applied.push(method.path);
    method.kind = override.kind;
    if (override.channel !== undefined) method.channel = override.channel;
    if (override.note) method.note = override.note;
    delete method.args;
  }
  if (errors.length > 0) fail(errors);

  const missing = methods.filter((method) => method.kind === 'custom' && !overrides[method.path]);
  if (missing.length > 0) {
    fail(missing.map((method) => (
      `unclassifiable wrapper "${method.path}" — declare it in scripts/ipc-contract-overrides.json ` +
      `with an accurate kind/channel/note (REQ-A-23)`
    )));
  }
  return applied;
}

// ---------------------------------------------------------------------------
// Contract assembly + tier coverage warning (best effort against the compiled
// REQ-A-17 allowlist; the hard gate lives in tests/ipcContract.test.mjs).
// ---------------------------------------------------------------------------

function buildContract(methods) {
  const sorted = [...methods].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    contractVersion: CONTRACT_VERSION,
    allowlistVersion: ALLOWLIST_VERSION,
    source: 'src/main/preload.ts',
    methods: sorted,
  };
}

function warnUntieredChannels(methods) {
  let allowlist = null;
  try {
    allowlist = require(path.join(ROOT, 'dist-electron', 'main', 'gateway', 'allowlist.js'));
  } catch {
    return; // compiled allowlist not present; the test enforces coverage
  }
  const seen = new Set();
  for (const method of methods) {
    const key = `${method.kind}:${method.channel ?? ''}`;
    if (method.kind === 'invoke') {
      if (seen.has(key)) continue;
      seen.add(key);
      const { matched } = allowlist.lookupInvokeChannelWithSource(method.channel);
      if (matched === 'default') console.warn(`ipc-contract: warning: invoke channel "${method.channel}" has no tier in the allowlist`);
    } else if (method.kind === 'on') {
      if (seen.has(key)) continue;
      seen.add(key);
      const { matched } = allowlist.lookupEventChannelWithSource(method.channel);
      if (matched === 'default') console.warn(`ipc-contract: warning: event channel "${method.channel}" has no tier in the allowlist`);
    } else if (method.kind === 'send') {
      if (seen.has(key)) continue;
      seen.add(key);
      if (!allowlist.SEND_CHANNELS.includes(method.channel)) {
        console.warn(`ipc-contract: warning: send channel "${method.channel}" is not in SEND_CHANNELS`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const methods = extractMethods();
const overrides = loadOverrides();
const appliedOverrides = applyOverrides(methods, overrides);
const contract = buildContract(methods);
const serialized = `${JSON.stringify(contract, null, 2)}\n`;

const counts = {};
for (const method of contract.methods) {
  counts[method.kind] = (counts[method.kind] ?? 0) + 1;
}

if (CHECK) {
  if (!fs.existsSync(OUTPUT_PATH)) {
    fail(`missing generated file ${path.relative(ROOT, OUTPUT_PATH)} — run node scripts/generate-ipc-contract.mjs`);
  }
  const existing = fs.readFileSync(OUTPUT_PATH, 'utf8');
  if (existing !== serialized) {
    console.error(`ipc-contract: error: ${path.relative(ROOT, OUTPUT_PATH)} is stale — regenerate with node scripts/generate-ipc-contract.mjs`);
    process.exit(1);
  }
  logInfo('ipc-contract: check ok — generated file is fresh');
} else if (STDOUT) {
  process.stdout.write(serialized);
} else {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, serialized);
  logInfo(`ipc-contract: wrote ${path.relative(ROOT, OUTPUT_PATH)} (${contract.methods.length} methods)`);
}

logInfo(`ipc-contract: methods=${contract.methods.length} kinds=${JSON.stringify(counts)}`);
if (appliedOverrides.length > 0) {
  logInfo(`ipc-contract: override-documented custom wrappers: ${appliedOverrides.join(', ')}`);
}
warnUntieredChannels(contract.methods);
