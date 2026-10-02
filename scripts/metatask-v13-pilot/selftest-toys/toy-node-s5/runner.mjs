// Toy S5 packaged-TS-engine runner — selftest fixture ONLY (plain node, no deps).
// Minimal mini-replay identical in semantics to the toy python/go engines, so
// the three packaged toys produce the same CANONICAL_SHA256 over the mini set.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const canonJ = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonJ).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonJ(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const sha256Hex = (text) => createHash('sha256').update(text, 'utf-8').digest('hex');
const innerHash = (result) => {
  const core = Object.fromEntries(Object.entries(result).filter(([k]) => k !== 'hash'));
  return sha256Hex(canonJ(core));
};
const outerHash = (result) => sha256Hex(canonJ(result));

const replay = (events) => {
  const task = [...events].reverse().find((event) => event.path === 'task');
  if (!task) throw new Error('no task event found');
  const tree = events.find((event) => event.path === 'tree' && event.pinId === task.body.treeid);
  if (!tree) throw new Error('no tree event for task');
  const policy = task.body.policy ?? {};
  const quorum = Number(policy.verify_quorum ?? 1);
  const finalnode = policy.finalnode;
  const competitive = policy.mode === 'competitive';
  const votes = {};
  for (const event of events) {
    if (event.path === 'verify') (votes[event.body?.targetid] ??= []).push(event);
  }
  const states = {};
  for (const node of tree.body.nodes ?? []) {
    let status = 'open';
    for (const event of events) {
      if (event.path !== 'submission') continue;
      if (event.body?.node !== node.id || event.body?.taskid !== task.pinId) continue;
      status = 'submitted';
      const counted = (votes[event.pinId] ?? []).filter(
        (vote) => vote.body?.verdict === 'pass' && vote.author !== event.author && vote.author !== task.author,
      ).length;
      if (counted >= quorum) status = 'verified';
    }
    states[node.id] = status;
  }
  const complete = Boolean(finalnode) && states[finalnode] === 'verified';
  return {
    nodeStates: states,
    taskComplete: complete,
    settlement: complete ? { engineAlgoVersion: competitive ? 'idbots-metatask-engine/1.3.0' : 'idbots-metatask-engine/1.2.1' } : null,
  };
};

const dir = process.argv[2];
const outputs = [];
let failed = 0;
for (const name of readdirSync(dir).sort()) {
  if (!name.endsWith('.json')) continue;
  const set = JSON.parse(readFileSync(path.join(dir, name), 'utf-8'));
  for (const vector of set.vectors ?? []) {
    const expect = vector.expect ?? {};
    const notes = [];
    if (vector.kind === 'hash') {
      const inner = innerHash(vector.input ?? {});
      const outer = outerHash({ ...(vector.input ?? {}), hash: inner });
      if (inner !== vector.expectInner) notes.push('inner mismatch');
      if (outer !== vector.expectOuter) notes.push('outer mismatch');
      outputs.push({ id: vector.id, inner, outer });
    } else {
      const projection = replay(vector.events ?? []);
      const nodes = projection.nodeStates;
      for (const [id, wanted] of Object.entries(expect.nodes ?? {})) {
        if (nodes[id] !== wanted) notes.push(`${id}=${nodes[id] ?? 'missing'} want ${wanted}`);
      }
      if (expect.taskComplete !== undefined && projection.taskComplete !== expect.taskComplete) {
        notes.push(`taskComplete=${projection.taskComplete} want ${expect.taskComplete}`);
      }
      const algo = projection.settlement?.engineAlgoVersion ?? null;
      if (expect.engineAlgoVersion !== undefined && algo !== expect.engineAlgoVersion) {
        notes.push(`engineAlgoVersion=${algo} want ${expect.engineAlgoVersion}`);
      }
      outputs.push({ id: vector.id, nodes, taskComplete: projection.taskComplete, engineAlgoVersion: algo });
    }
    if (notes.length > 0) {
      failed += 1;
      console.log(`FAIL ${vector.id}: ${notes.join('; ')}`);
    } else {
      console.log(`PASS ${vector.id}`);
    }
  }
}
const competitive = outputs.some((output) => output.engineAlgoVersion === 'idbots-metatask-engine/1.3.0');
console.log(`ENGINE metatask-ts-packaged ${competitive ? 'idbots-metatask-engine/1.3.0' : 'idbots-metatask-engine/1.2.1'}`);
console.log(`CANONICAL_SHA256 ${sha256Hex(canonJ(outputs))}`);
process.exit(failed > 0 ? 1 : 0);
