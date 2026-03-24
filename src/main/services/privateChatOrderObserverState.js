const NEEDS_RATING_PREFIX = '[NEEDSRATING]';

export function isNeedsRatingMessage(plaintext) {
  return String(plaintext || '').trim().toUpperCase().startsWith(NEEDS_RATING_PREFIX);
}

export function shouldCompleteBuyerOrderObserverSession(plaintext) {
  return isNeedsRatingMessage(plaintext);
}
