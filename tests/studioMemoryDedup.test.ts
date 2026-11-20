// Memory sub-block dedup (Phase 2 slice 3, 2026-11-18 Studio post-mortem):
// the memory volatile section was alwaysInject — cerebellum re-ranking kept
// the block byte-unstable, so ~2K chars of ownerMemories re-injected on every
// message (78K chars/day in the incident session) while the MEMBERSHIP stayed
// identical. The dedup layer now splits the memory XML into its known
// sub-blocks and dedups each on its own hash: a pure re-rank skips, a new or
// edited memory re-injects just that chunk.

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyVolatileDedup, createVolatileDedupState } from '../src/main/libs/coworkVolatileDedup';

const mem = (tag: string, body: string) => `<${tag}>\n${body}\n</${tag}>`;

const memorySection = (blocks: string[]) => ({
  key: 'memory',
  text: blocks.join('\n'),
  alwaysInject: true,
});

test('a pure re-rank of the same memory sub-blocks is skipped entirely', () => {
  const state = createVolatileDedupState('gen-1');
  const first = applyVolatileDedup([
    memorySection([mem('ownerMemories', '- fact A'), mem('contactMemories', '- Bob likes tea')]),
  ], state);
  assert.equal(first.length, 1, 'first turn injects');

  // Same members, different order + cerebellum noise between the tags.
  const second = applyVolatileDedup([
    memorySection([mem('contactMemories', '- Bob likes tea'), mem('ownerMemories', '- fact A')]),
  ], state);
  assert.deepEqual(second, [], 're-ranked identical blocks cost zero tokens');
});

test('a new memory re-injects only its own sub-block', () => {
  const state = createVolatileDedupState('gen-1');
  applyVolatileDedup([
    memorySection([mem('ownerMemories', '- fact A'), mem('contactMemories', '- Bob likes tea')]),
  ], state);
  const second = applyVolatileDedup([
    memorySection([mem('ownerMemories', '- fact A\n- fact B (new)'), mem('contactMemories', '- Bob likes tea')]),
  ], state);
  assert.equal(second.length, 1);
  assert.ok(second[0].includes('fact B (new)'), 'the changed chunk rides');
  assert.ok(!second[0].includes('Bob likes tea'), 'the unchanged chunk does not');
});

test('an edited memory re-injects its chunk; a changed-away-and-back chunk re-injects', () => {
  const state = createVolatileDedupState('gen-1');
  applyVolatileDedup([memorySection([mem('ownerMemories', '- fact A')])], state);
  applyVolatileDedup([memorySection([mem('ownerMemories', '- fact A (edited)')])], state);
  const back = applyVolatileDedup([memorySection([mem('ownerMemories', '- fact A')])], state);
  assert.equal(back.length, 1, 'A -> B -> A re-injects A (hash tracks the LAST injection)');
});

test('a render matching no known sub-block stays fail-open injected', () => {
  const state = createVolatileDedupState('gen-1');
  const odd = { key: 'memory', text: 'no xml blocks here, just prose memory context', alwaysInject: true };
  assert.deepEqual(applyVolatileDedup([odd], state), [odd.text]);
  assert.deepEqual(applyVolatileDedup([{ ...odd }], state), [odd.text], 'alwaysInject fail-open survives for non-matching renders');
});

test('a generation change re-anchors everything', () => {
  const blocks = [mem('ownerMemories', '- fact A')];
  const state = createVolatileDedupState('gen-1');
  applyVolatileDedup([memorySection(blocks)], state);
  // The runner responds to an SDK-generation change by building a FRESH
  // state (createVolatileDedupState(newGeneration)) — hashes start empty and
  // everything re-injects (post-compaction re-anchoring).
  const fresh = createVolatileDedupState('gen-2');
  const reanchored = applyVolatileDedup([memorySection(blocks)], fresh);
  assert.equal(reanchored.length, 1, 'post-compaction generation change re-injects');
});

test('botDirectives rides the same sub-block treatment', () => {
  const state = createVolatileDedupState('gen-1');
  applyVolatileDedup([memorySection([mem('botDirectives', '- rule 1'), mem('ownerMemories', '- fact A')])], state);
  const second = applyVolatileDedup([memorySection([mem('botDirectives', '- rule 1'), mem('ownerMemories', '- fact A')])], state);
  assert.deepEqual(second, []);
  const third = applyVolatileDedup([memorySection([mem('botDirectives', '- rule 1 EDITED'), mem('ownerMemories', '- fact A')])], state);
  assert.equal(third.length, 1);
  assert.ok(third[0].includes('rule 1 EDITED'));
});
