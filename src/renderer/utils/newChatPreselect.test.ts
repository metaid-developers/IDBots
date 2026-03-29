import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePreselectedSkillId } from './newChatPreselect';

test('normalizePreselectedSkillId keeps valid skill ids', () => {
  assert.equal(normalizePreselectedSkillId('skill.weather'), 'skill.weather');
});

test('normalizePreselectedSkillId ignores click event-like payloads', () => {
  const syntheticClickEvent = {
    _reactName: 'onClick',
    type: 'click',
    nativeEvent: { type: 'click' },
    target: { tagName: 'BUTTON' },
  };

  assert.equal(normalizePreselectedSkillId(syntheticClickEvent), undefined);
});
