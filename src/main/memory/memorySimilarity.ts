/**
 * Memory text similarity primitives — the shared normalization + scoring the
 * revive path (createOrReviveUserMemory), the cross-night dream dedup and the
 * conversation-memory quality gate all build on. Moved verbatim out of
 * coworkStore.ts so the quality gate (libs/coworkMemoryQuality.ts) can reuse
 * the exact same scorer instead of growing a divergent copy.
 *
 * Scoring shape: scoreMemorySimilarity returns the MAX of
 *  - phrase containment ratio (one normalized string contains the other),
 *  - word-level token overlap (English-style space-separated tokens; Chinese
 *    punctuation splits phrases into comparable tokens),
 *  - character-bigram Dice (CJK-safe: works without any word boundaries).
 * normalizeMemorySemanticKey additionally strips leading first-person /
 * "the user" subject prefixes so restatements of the same fact compare equal.
 */

function normalizeMemoryText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function normalizeMemoryMatchKey(value: string): string {
  return normalizeMemoryText(value)
    .toLowerCase()
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeMemorySemanticKey(value: string): string {
  const key = normalizeMemoryMatchKey(value);
  if (!key) return '';
  return key
    .replace(/^(?:the user|user|i am|i m|i|my|me)\s+/i, '')
    .replace(/^(?:该用户|这个用户|用户|本人|我的|我们|咱们|咱|我|你的|你)\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildTokenFrequencyMap(value: string): Map<string, number> {
  const tokens = value
    .split(/\s+/g)
    .map((token) => token.trim())
    .filter(Boolean);
  const map = new Map<string, number>();
  for (const token of tokens) {
    map.set(token, (map.get(token) || 0) + 1);
  }
  return map;
}

function scoreTokenOverlap(left: string, right: string): number {
  const leftMap = buildTokenFrequencyMap(left);
  const rightMap = buildTokenFrequencyMap(right);
  if (leftMap.size === 0 || rightMap.size === 0) return 0;

  let leftCount = 0;
  let rightCount = 0;
  let intersection = 0;
  for (const count of leftMap.values()) leftCount += count;
  for (const count of rightMap.values()) rightCount += count;
  for (const [token, leftValue] of leftMap.entries()) {
    intersection += Math.min(leftValue, rightMap.get(token) || 0);
  }

  const denominator = Math.min(leftCount, rightCount);
  if (denominator <= 0) return 0;
  return intersection / denominator;
}

function buildCharacterBigramMap(value: string): Map<string, number> {
  const compact = value.replace(/\s+/g, '').trim();
  if (!compact) return new Map<string, number>();
  if (compact.length <= 1) return new Map<string, number>([[compact, 1]]);

  const map = new Map<string, number>();
  for (let index = 0; index < compact.length - 1; index += 1) {
    const gram = compact.slice(index, index + 2);
    map.set(gram, (map.get(gram) || 0) + 1);
  }
  return map;
}

function scoreCharacterBigramDice(left: string, right: string): number {
  const leftMap = buildCharacterBigramMap(left);
  const rightMap = buildCharacterBigramMap(right);
  if (leftMap.size === 0 || rightMap.size === 0) return 0;

  let leftCount = 0;
  let rightCount = 0;
  let intersection = 0;
  for (const count of leftMap.values()) leftCount += count;
  for (const count of rightMap.values()) rightCount += count;
  for (const [gram, leftValue] of leftMap.entries()) {
    intersection += Math.min(leftValue, rightMap.get(gram) || 0);
  }

  const denominator = leftCount + rightCount;
  if (denominator <= 0) return 0;
  return (2 * intersection) / denominator;
}

export function scoreMemorySimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;

  const compactLeft = left.replace(/\s+/g, '');
  const compactRight = right.replace(/\s+/g, '');
  if (compactLeft && compactLeft === compactRight) {
    return 1;
  }

  let phraseScore = 0;
  if (compactLeft && compactRight && (compactLeft.includes(compactRight) || compactRight.includes(compactLeft))) {
    phraseScore = Math.min(compactLeft.length, compactRight.length) / Math.max(compactLeft.length, compactRight.length);
  }

  return Math.max(
    phraseScore,
    scoreTokenOverlap(left, right),
    scoreCharacterBigramDice(left, right)
  );
}
