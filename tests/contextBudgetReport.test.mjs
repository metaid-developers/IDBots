// Smoke pins for scripts/context-budget-report.mjs (Phase 2 slice 0): the
// measurement base every slimming slice validates against. Runs the script
// as a child against a SYNTHETIC plain-jsonl session dir (no zstd needed on
// Windows CI) via the IDBOTS_USERDATA override.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, '../scripts/context-budget-report.mjs');

function buildFakeUserdata(root) {
  const bucket = '--Users-test-fake--';
  const sessionDir = path.join(root, 'dsh-sessions', 'v0', bucket, 'cw-abc123');
  fs.mkdirSync(sessionDir, { recursive: true });
  const events = [
    { type: 'session', version: 4, id: 'cw-abc123', createdAt: 1_749_000_000_000, cwd: '/tmp/fake' },
    { type: 'model/selection', seq: 1, time: 1_749_000_000_001, data: { provider: 'zhipu', model: 'glm-5.3-flash' } },
    { type: 'request/header', seq: 2, time: 1_749_000_000_002, data: { header: { config: {}, tools: [
      { name: 'bash', description: 'run commands', parameters: { type: 'object' } },
      { name: 'write', description: 'write files', parameters: { type: 'object' } },
    ] } } },
    { type: 'request/context', seq: 3, time: 1_749_000_000_003, data: { provider: 'zhipu', model: 'glm-5.3-flash', contextWindow: 1_048_576 } },
    { type: 'system/message', seq: 4, time: 1_749_000_000_004, data: { message: { role: 'system', content: [{ type: 'text', text: '<metabot_identity>persona body</metabot_identity>' }] } } },
    { type: 'user/message', seq: 5, time: 1_749_000_000_005, data: { content: [{ type: 'text', text: '你好'.repeat(300) + '<browser_context><open_tabs><tab id="1"/></open_tabs></browser_context>' }] } },
    { type: 'assistant/message', seq: 6, time: 1_749_000_000_006, data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, usage: { inputTokens: 1200, cacheReadTokens: 5000, outputTokens: 10 } } },
    { type: 'tool/call', seq: 7, time: 1_749_000_000_007, data: { turn: 1, call: { name: 'bash', arguments: '{}' } } },
    { type: 'tool/call', seq: 8, time: 1_749_000_000_008, data: { turn: 1, call: { name: 'bash', arguments: '{}' } } },
    { type: 'turn/end', seq: 9, time: 1_749_000_000_009, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/end', seq: 10, time: 1_749_000_000_010, data: { turn: 2, reason: { kind: 'error', error: { message: '429 insufficient_me need more' } } } },
    { type: 'compaction/summary', seq: 11, time: 1_749_000_000_011, data: {} },
  ];
  fs.writeFileSync(path.join(sessionDir, 'session.v4.jsonl'), events.map((event) => JSON.stringify(event)).join('\n'));
  return { root, sessionDir };
}

test('context-budget-report reads a plain-jsonl session and reports all sections', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-cbr-'));
  try {
    const { root } = buildFakeUserdata(dir);
    const stdout = execFileSync('node', [scriptPath, 'abc123'], {
      env: { ...process.env, IDBOTS_USERDATA: root },
      encoding: 'utf8',
    });
    assert.ok(stdout.includes('## cw-abc123'), 'session header');
    assert.ok(stdout.includes('cwd /tmp/fake'), 'session cwd (top-level v4 field)');
    assert.ok(stdout.includes('2 tools, '), 'tool census from request/header');
    assert.ok(stdout.includes('declared context window: 1,048,576'));
    assert.ok(stdout.includes('first measured request: ~6,200 tokens'), 'first request = input + cacheRead');
    assert.ok(stdout.includes('compactions: 1'));
    assert.ok(stdout.includes('quota deaths: 1'));
    assert.ok(stdout.includes('browser_context'), 'volatile section breakdown');
    assert.ok(stdout.includes('Tool usage census'), 'census section present');
    assert.match(stdout, / {2,}2 {2,}bash/, 'bash counted twice');
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // leftover temp dirs are harmless
    }
  }
});

test('context-budget-report exits nonzero for an unmatched session id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-cbr-empty-'));
  try {
    let exited = 0;
    try {
      execFileSync('node', [scriptPath, 'no-such-session'], {
        env: { ...process.env, IDBOTS_USERDATA: dir },
        encoding: 'utf8',
      });
    } catch (error) {
      exited = error.status ?? -1;
    }
    assert.equal(exited, 2);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // harmless
    }
  }
});
