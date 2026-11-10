import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveBubbleSelectedText } from '../src/renderer/features/botBrowser/panelBubbleSelection';

// Selection-aware bubble context menu (office-chat purity pass #4): the menu
// treats quote/copy as fragment-scoped ONLY when the captured selection's
// anchor and focus BOTH sit inside the right-clicked bubble and the text
// carries non-whitespace content. Every other shape — cross-bubble spans,
// selections outside the transcript, empty selections — must fall back to
// the WHOLE message (null here). The helper returns the RAW text verbatim:
// copy needs the original fragment, quote normalizes/truncates downstream.

// Minimal Node stand-ins: `contains` is the only member the helper reads.
// A membership set plays the DOM ancestor relation; the bubble always
// contains itself plus the given children (DOM containment semantics).
const makeSelfContainingNode = (...children: Node[]): Node => {
  const node: { contains: (other: Node | null) => boolean } = {
    contains: (other: Node | null) => (other ? set.has(other) : false),
  };
  const set = new Set<Node>([node as unknown as Node, ...children]);
  return node as unknown as Node;
};

const bubbleChildText = {} as unknown as Node;
const otherBubbleChild = {} as unknown as Node;
const bubble = makeSelfContainingNode(bubbleChildText);
const otherBubble = makeSelfContainingNode(otherBubbleChild);

test('in-bubble selection resolves to the RAW text verbatim', () => {
  assert.equal(
    resolveBubbleSelectedText(bubbleChildText, bubbleChildText, '选中的原文片段', bubble),
    '选中的原文片段',
  );
  // No trimming, no normalization on the copy path — verbatim out.
  assert.equal(
    resolveBubbleSelectedText(bubbleChildText, bubbleChildText, '  padded\nfragment ', bubble),
    '  padded\nfragment ',
  );
});

test('selection anchored at the bubble container itself still counts as inside', () => {
  // contains() is true for the node itself: a selection whose anchor is the
  // bubble element (e.g. triple-click selecting the whole bubble) qualifies.
  assert.equal(resolveBubbleSelectedText(bubble, bubbleChildText, 'whole', bubble), 'whole');
});

test('cross-bubble selection never harvests another bubble (anchor outside)', () => {
  assert.equal(
    resolveBubbleSelectedText(otherBubbleChild, bubbleChildText, 'stolen text', bubble),
    null,
  );
});

test('cross-bubble selection never harvests another bubble (focus outside)', () => {
  assert.equal(
    resolveBubbleSelectedText(bubbleChildText, otherBubbleChild, 'stolen text', bubble),
    null,
  );
});

test('selection fully outside the bubble resolves to null', () => {
  assert.equal(
    resolveBubbleSelectedText(otherBubbleChild, otherBubbleChild, 'elsewhere', bubble),
    null,
  );
});

test('empty and whitespace-only selections resolve to null', () => {
  assert.equal(resolveBubbleSelectedText(bubbleChildText, bubbleChildText, '', bubble), null);
  assert.equal(resolveBubbleSelectedText(bubbleChildText, bubbleChildText, '   ', bubble), null);
  assert.equal(resolveBubbleSelectedText(bubbleChildText, bubbleChildText, '\n\t ', bubble), null);
});

test('missing DOM pieces resolve to null (defensive)', () => {
  assert.equal(resolveBubbleSelectedText(null, bubbleChildText, 'text', bubble), null);
  assert.equal(resolveBubbleSelectedText(bubbleChildText, null, 'text', bubble), null);
  assert.equal(resolveBubbleSelectedText(bubbleChildText, bubbleChildText, 'text', null), null);
  assert.equal(resolveBubbleSelectedText(null, null, 'text', null), null);
});

test('non-string raw text resolves to null (defensive)', () => {
  assert.equal(
    resolveBubbleSelectedText(bubbleChildText, bubbleChildText, 42 as unknown as string, bubble),
    null,
  );
});
