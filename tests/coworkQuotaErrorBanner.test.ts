import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FREE_QUOTA_EXHAUSTED_CODE,
  isFreeQuotaErrorLive,
  isQuotaExhaustedErrorLive,
  liveQuotaErrorKind,
} from '../src/renderer/components/cowork/quotaErrorBanner';
import type { CoworkMessage, CoworkSessionStatus } from '../src/renderer/types/cowork';

/**
 * The free-quota banner pinned above the composer must track the LIVE error
 * state of the session, not "did this transcript ever contain the quota
 * code". The reported failure: a user hit the free-quota wall, configured
 * their own key, and kept chatting successfully — yet the red banner stayed
 * pinned at the bottom for the rest of the session (and after restarts),
 * until they opened a brand-new conversation.
 */

let seq = 0;
const message = (overrides: Partial<CoworkMessage>): CoworkMessage => ({
  id: `msg-${(seq += 1)}`,
  type: 'assistant',
  content: 'x',
  timestamp: seq,
  ...overrides,
});

const QUOTA_ERROR = `DSH turn failed: 429 free_quota_exhausted — the free relay quota is used up (code: ${FREE_QUOTA_EXHAUSTED_CODE})`;

const user = (text = 'hello') => message({ type: 'user', content: text });
const assistant = (text = 'reply') => message({ type: 'assistant', content: text });
/** What coworkRunner.handleError persists: "Error: …" content plus metadata.error. */
const systemError = (error: string) => message({ type: 'system', content: `Error: ${error}`, metadata: { error } });

const live = (messages: CoworkMessage[], status: CoworkSessionStatus) => isFreeQuotaErrorLive(messages, status);

test('shows while the quota failure is the live, unresolved error', () => {
  const messages = [user(), systemError(QUOTA_ERROR)];
  assert.equal(live(messages, 'error'), true);
});

test('legacy rows carrying the code only in the content still count', () => {
  const messages = [user(), message({ type: 'system', content: `Error: ${QUOTA_ERROR}` })];
  assert.equal(live(messages, 'error'), true);
});

test('hides the moment the next turn starts (status leaves error)', () => {
  // Both start and continue paths flip the session to 'running' before anything
  // else, so the banner disappears as soon as the user sends again.
  const messages = [user(), systemError(QUOTA_ERROR)];
  assert.equal(live(messages, 'running'), false);
});

test('stays hidden once a later turn succeeded — the reported regression', () => {
  const messages = [user(), systemError(QUOTA_ERROR), user('continue'), assistant('sure, continuing')];
  assert.equal(live(messages, 'completed'), false);
  assert.equal(live(messages, 'idle'), false);
});

test('comes back when the retry fails with the quota error again', () => {
  const messages = [user(), systemError(QUOTA_ERROR), user('again'), systemError(QUOTA_ERROR)];
  assert.equal(live(messages, 'error'), true);
});

test('does not claim a different, newer failure', () => {
  // Only the newest system error decides; an older quota failure in the
  // transcript must not resurface the quota call-to-action over an auth error.
  const messages = [user(), systemError(QUOTA_ERROR), user('retry'), systemError('401 invalid api key')];
  assert.equal(live(messages, 'error'), false);
});

test('error_retried is a historical failure, not a live one', () => {
  const messages = [user(), systemError(QUOTA_ERROR)];
  assert.equal(live(messages, 'error_retried'), false);
  assert.equal(live(messages, 'stopped'), false);
});

test('the code is found even at the tail of a long error text', () => {
  // lastA2AErrorDetail truncates to 240 chars by default; the banner reads the
  // full detail so a long "DSH turn failed: …" prefix cannot hide the code.
  const longError = `${'x'.repeat(600)} ${FREE_QUOTA_EXHAUSTED_CODE}`;
  assert.equal(live([user(), systemError(longError)], 'error'), true);
});

test('non-error messages mentioning the code never trigger the banner', () => {
  const messages = [user(`why does it say ${FREE_QUOTA_EXHAUSTED_CODE}?`), assistant('that code means…')];
  assert.equal(live(messages, 'error'), false);
  assert.equal(live([], 'error'), false);
  assert.equal(live(undefined, 'error'), false);
});

test('me_daily_limit and insufficient_me/quota_exhausted classify distinct banner kinds', () => {
  assert.equal(liveQuotaErrorKind([user(), systemError('DSH turn failed: me_daily_limit')], 'error'), 'me_daily_limit');
  assert.equal(liveQuotaErrorKind([user(), systemError('DSH turn failed: insufficient_me')], 'error'), 'me_quota');
  assert.equal(liveQuotaErrorKind([user(), systemError('DSH turn failed: quota_exhausted')], 'error'), 'me_quota');
  assert.equal(liveQuotaErrorKind([user(), systemError(QUOTA_ERROR)], 'error'), 'free');
  assert.equal(isQuotaExhaustedErrorLive([user(), systemError('DSH turn failed: me_daily_limit')], 'error'), true);
});
