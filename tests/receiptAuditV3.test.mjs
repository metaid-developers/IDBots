import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repoRoot, 'scripts', 'receipt_audit_v3.py');
const python = process.env.PYTHON || 'python3';
const spillRoot = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'IDBots',
  'dsh-sessions',
  'v0',
  'spill'
);

function run(args) {
  const result = spawnSync(python, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  return result;
}

function runJson(args) {
  const result = run(args);
  assert.equal(
    result.status,
    0,
    `receipt_audit_v3.py ${args.join(' ')} failed:\n${result.stderr || result.stdout}`
  );
  return JSON.parse(result.stdout);
}

function withFixtureDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-audit-v3-'));
  try {
    const emit = run(['emit-fixtures', dir]);
    assert.equal(emit.status, 0, emit.stderr || emit.stdout);
    return fn(dir);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Leftover temp dirs are harmless and OS-swept (repo test discipline).
    }
  }
}

test('self-test: fixtures and controls are all green', () => {
  const out = runJson(['self-test', '--json']);
  assert.equal(out.ok, true);
  assert.equal(out.fixtures.length, 8);
  assert.equal(out.controls.length, 3);
  assert.match(out.summary, /^8\/8 fixtures \+ 3\/3 controls$/);
});

test('self-test: the brief frame reproduces S=2598, R=2633, residual 0', () => {
  const out = runJson(['self-test', '--json']);
  const target = out.fixtures.find((item) => item.name === 'F1-target-12-trimmed');
  assert.ok(target);
  assert.equal(target.pred_s, 2598);
  assert.equal(target.measured_s, 2598);
  assert.equal(target.measured_r, 2633);
  assert.equal(target.residual, 0);
});

test('self-test: dropping (k-1) turns the brief frame red with residual +11', () => {
  const out = runJson(['self-test', '--json']);
  const control = out.controls.find(
    (item) => item.name === 'C1-missing-commas-must-be-red'
  );
  assert.ok(control);
  assert.equal(control.ok, true);
  assert.equal(control.pred_s, 2587);
  assert.equal(control.residual, 11);
});

test('scan: emitted fixtures all close at residual 0', () => {
  withFixtureDir((dir) => {
    const out = runJson(['scan', '--root', dir, '--json']);
    assert.equal(out.parsed_lines, 8);
    assert.equal(out.distinct_frames, 8);
    assert.deepEqual(out.residual_lines, { 0: 8 });
    assert.deepEqual(out.residual_frames, { 0: 8 });
    assert.equal(out.unparseable.length, 0);
    assert.equal(out.nonzero.length, 0);
  });
});

test('probe R=457: caliber 64, two 68-char ids, growth 141, premise false', () => {
  withFixtureDir((dir) => {
    const out = runJson(['probe', '--r', '457', '--root', dir, '--json']);
    assert.equal(out.empty, false);
    assert.equal(out.hits.length, 1);
    const hit = out.hits[0];
    assert.equal(hit.R, 457);
    assert.equal(hit.S, 422);
    assert.equal(hit.residual, 0);
    assert.equal(hit.caliber_len, 64);
    assert.equal(hit.requested, 6);
    assert.equal(hit.readable_upstream, 4);
    assert.equal(hit.returned, 4);
    assert.equal(hit.unreadable, 2);
    assert.equal(hit.truncation_point_count, 0);
    assert.equal(hit.n_entries, 0);
    assert.equal(hit.bytes_written, 12128);
    assert.deepEqual(hit.id_arrays, [
      {
        name: 'unreadable_ids',
        count: 2,
        id_lengths: [68, 68],
        literal_len: 143,
        growth_over_empty: 141,
        item_price_total: 141,
      },
    ]);
    assert.equal(hit.bot009_prediction.digit_term, 5);
    assert.equal(hit.bot009_prediction.ids_growth, 141);
    assert.equal(hit.bot009_prediction.sum, 146);
    assert.equal(hit.bot009_prediction.antecedent_ids_137, false);
    assert.equal(hit.bot009_prediction.caliber_len, 64);
    assert.match(hit.bot009_prediction.verdict, /premise false \(ids=141, not 137\)/);
  });
});

test('scan comma-mode=tpc: the tpc13/array12 fixture is red by exactly -1', () => {
  withFixtureDir((dir) => {
    const out = runJson(['scan', '--root', dir, '--comma-mode', 'tpc', '--json']);
    assert.equal(out.residual_lines['-1'], 1);
    assert.equal(out.residual_lines['0'], 7);
    assert.equal(out.nonzero.length, 1);
    assert.equal(out.nonzero[0].residual, -1);
    assert.equal(out.nonzero[0].tpc, 13);
    assert.equal(out.nonzero[0].n_entries, 12);
  });
});

test(
  'live spill corpus (local only): every parsed frame closes',
  { skip: !fs.existsSync(spillRoot) },
  () => {
    const out = runJson(['scan', '--json']);
    assert.ok(out.parsed_lines > 0, 'expected at least one parsed receipt line');
    assert.ok(out.distinct_frames > 0);
    assert.deepEqual(Object.keys(out.residual_lines), ['0']);
    assert.deepEqual(Object.keys(out.residual_frames), ['0']);
    assert.equal(out.nonzero.length, 0);
  }
);
