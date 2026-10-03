// Toy S2c vector runner — selftest fixture ONLY. Drives the REAL vendored
// engine over a vector-set directory per the pilot runner contract.
import { replayMetaTask } from '../vendor/metatask-engine/engine';
import { innerHash, outerHash, canonJ, sha256Hex } from '../vendor/metatask-engine/canon';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) {
  process.stderr.write('usage: tsx src/run-vectors.ts <vectors-dir>\n');
  process.exit(2);
}

const outputs: unknown[] = [];
let failed = 0;
let competitiveSeen = false;

for (const name of readdirSync(dir).sort()) {
  if (!name.endsWith('.json')) continue;
  const set = JSON.parse(readFileSync(path.join(dir, name), 'utf-8'));
  for (const vector of set.vectors ?? []) {
    const expect = vector.expect ?? {};
    const notes: string[] = [];
    if (vector.kind === 'hash') {
      const inner = innerHash(vector.input ?? {});
      const outer = outerHash({ ...(vector.input ?? {}), hash: inner });
      if (inner !== vector.expectInner) notes.push('inner mismatch');
      if (outer !== vector.expectOuter) notes.push('outer mismatch');
      outputs.push({ id: vector.id, inner, outer });
    } else {
      let root: string | undefined;
      for (const event of vector.events ?? []) {
        if (event?.path === 'task') root = event.pinId;
      }
      const projection = replayMetaTask(vector.events ?? [], {
        ...(root ? { rootPinId: root } : {}),
        ...(typeof vector.options?.now === 'number' ? { now: vector.options.now } : {}),
      });
      const nodes: Record<string, string> = {};
      for (const [id, node] of Object.entries(projection.nodeStates)) {
        nodes[id] = (node as { status: string }).status;
      }
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
      if (algo === 'idbots-metatask-engine/1.3.0') competitiveSeen = true;
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

console.log(`ENGINE metatask-ts-adapter ${competitiveSeen ? 'idbots-metatask-engine/1.3.0' : 'idbots-metatask-engine/1.2.1'}`);
console.log(`CANONICAL_SHA256 ${sha256Hex(canonJ(outputs))}`);
process.exit(failed > 0 ? 1 : 0);
