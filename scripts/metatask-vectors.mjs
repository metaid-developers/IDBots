#!/usr/bin/env node
/**
 * MetaTask engine conformance-vector runner + canonical sha256 printer.
 *
 * The vector set (tests/fixtures/metatask/conformance-vectors.json) is the
 * cross-engine artifact required by the v1.2.1 registration body
 * (conformance.fixtureSet): Python skill, metaso Go indexer and this TS
 * engine must all run the SAME set green before H_ACT2. This script runs the
 * set against the compiled IDBots TS engine and prints the set's
 * canonical-JSON sha256 (canonJ per Appendix A) — the value the registration
 * publisher announces alongside the pinned copy. Exit 1 on any failure.
 *
 * v1.3 (PRE-ACTIVATION): when tests/fixtures/metatask/conformance-vectors-v13-draft.json
 * exists, its vectors run afterwards as a second, clearly labeled section.
 * That set is a DRAFT (protocol v1.3.0 draft §8) — not part of the registered
 * 1.2.1 set, not announced, and free to change until H_ACT3 — but failures
 * still fail this runner. Its vectors may additionally assert
 * `expect.engineAlgoVersion` and `expect.winningChain`.
 *
 * Usage: pnpm run test:metatask (or node scripts/metatask-vectors.mjs)
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { replayMetaTask } = require('../dist-electron/main/services/metatask/engine.js');
const { innerHash, outerHash, canonJ, sha256Hex } = require('../dist-electron/main/services/metatask/canon.js');
const { ENGINE_ALGO_VERSION, ENGINE_ALGO_VERSION_COMPETITIVE } = require('../dist-electron/main/services/metatask/constants.js');

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The three-engine conformance anchor (v1.3.0 registration, conformance
 * section): every engine replays all vectors and emits
 * CANONICAL_SHA256 = sha256(utf8(canonJ(outputs))), where each vector
 * contributes {id, inner, outer} (hash vectors) or
 * {id, nodes{nodeId:status}, taskComplete, engineAlgoVersion} (replay vectors,
 * version string per the task's policy.mode). The registered anchor digest is
 * 726959e97e354b1489c2baa4923702193e0b1ce38871cfc1bca830eb9e9dcfd0.
 */
const outputs = [];

const runSet = (setPath) => {
  const set = JSON.parse(readFileSync(setPath, 'utf-8'));
  const canonicalSha256 = sha256Hex(canonJ(set));
  let failed = 0;
  for (const vector of set.vectors) {
    if (vector.kind === 'hash') {
      const inner = innerHash(vector.input);
      const outer = outerHash({ ...vector.input, hash: inner });
      outputs.push({ id: vector.id, inner, outer });
      if (inner === vector.expectInner && outer === vector.expectOuter) {
        console.log(`PASS ${vector.id}`);
      } else {
        failed += 1;
        console.log(`FAIL ${vector.id} inner=${inner} outer=${outer}`);
      }
      continue;
    }
    try {
      const projection = replayMetaTask(vector.events, vector.options ?? {});
      const nodes = {};
      for (const [nodeId, nodeState] of Object.entries(projection.nodeStates ?? {})) {
        nodes[nodeId] = nodeState?.status ?? 'missing';
      }
      outputs.push({
        id: vector.id,
        nodes,
        taskComplete: projection.taskComplete === true,
        engineAlgoVersion:
          projection.policy?.mode === 'competitive' ? ENGINE_ALGO_VERSION_COMPETITIVE : ENGINE_ALGO_VERSION,
      });
      const notes = [];
      let ok = true;
      for (const [node, status] of Object.entries(vector.expect.nodes ?? {})) {
        if (projection.nodeStates[node]?.status !== status) {
          ok = false;
          notes.push(`${node}=${projection.nodeStates[node]?.status ?? 'missing'} want ${status}`);
        }
      }
      if (vector.expect.taskComplete !== undefined && projection.taskComplete !== vector.expect.taskComplete) {
        ok = false;
        notes.push(`taskComplete=${projection.taskComplete} want ${vector.expect.taskComplete}`);
      }
      if (vector.expect.settlement === null && projection.settlement !== null) {
        ok = false;
        notes.push('expected no settlement');
      }
      if (vector.expect.settlementShareSumBP !== undefined) {
        const sum = (projection.settlement?.shares ?? []).reduce((acc, share) => acc + share.shareBP, 0);
        if (sum !== vector.expect.settlementShareSumBP) {
          ok = false;
          notes.push(`settlementSum=${sum} want ${vector.expect.settlementShareSumBP}`);
        }
      }
      if (vector.expect.ignoredContains) {
        const hit = projection.ignoredEvents.some(
          (entry) =>
            entry.pinId === vector.expect.ignoredContains.pinId &&
            entry.reason === vector.expect.ignoredContains.reason
        );
        if (!hit) {
          ok = false;
          notes.push(`missing ignored entry ${vector.expect.ignoredContains.reason}`);
        }
      }
      // v1.3 draft-only expect fields (never present in the registered 1.2.1 set).
      if (vector.expect.engineAlgoVersion !== undefined) {
        const actual = projection.settlement?.engineAlgoVersion ?? null;
        if (actual !== vector.expect.engineAlgoVersion) {
          ok = false;
          notes.push(`engineAlgoVersion=${actual} want ${vector.expect.engineAlgoVersion}`);
        }
      }
      if (vector.expect.winningChain !== undefined) {
        const actual = projection.settlement?.winningChain ?? null;
        if (JSON.stringify(actual) !== JSON.stringify(vector.expect.winningChain)) {
          ok = false;
          notes.push(`winningChain=${JSON.stringify(actual)}`);
        }
      }
      if (ok) {
        console.log(`PASS ${vector.id}`);
      } else {
        failed += 1;
        console.log(`FAIL ${vector.id}: ${notes.join('; ')}`);
      }
    } catch (error) {
      failed += 1;
      console.log(`FAIL ${vector.id}: threw ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { set, failed, canonicalSha256 };
};

const mainSetPath = path.join(here, '..', 'tests', 'fixtures', 'metatask', 'conformance-vectors.json');
const main = runSet(mainSetPath);
console.log(`\nvectors: ${main.set.vectors.length}  failed: ${main.failed}`);
console.log(`protocol: ${main.set.protocolVersion}`);
console.log(`canonical sha256 (canonJ of the parsed vector set): ${main.canonicalSha256}`);

let failed = main.failed;

const draftSetPath = path.join(here, '..', 'tests', 'fixtures', 'metatask', 'conformance-vectors-v13-draft.json');
if (existsSync(draftSetPath)) {
  console.log('\n── v1.3 competitive-mode DRAFT vectors (PRE-ACTIVATION: not part of the');
  console.log('   registered 1.2.1 set; unannounced and free to change until H_ACT3) ──');
  const draft = runSet(draftSetPath);
  console.log(`\ndraft vectors: ${draft.set.vectors.length}  failed: ${draft.failed}`);
  console.log(`protocol: ${draft.set.protocolVersion}`);
  console.log(`draft canonical sha256: ${draft.canonicalSha256}`);
  failed += draft.failed;
}

console.log(`\nCANONICAL_SHA256 ${sha256Hex(canonJ(outputs))}`);
console.log('(three-engine anchor, v1.3.0 registration: 726959e97e354b1489c2baa4923702193e0b1ce38871cfc1bca830eb9e9dcfd0)');

process.exit(failed > 0 ? 1 : 0);
