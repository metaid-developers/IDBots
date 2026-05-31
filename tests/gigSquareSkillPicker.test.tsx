import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GigSquareSkillPicker } from '../src/renderer/components/gigSquare/GigSquareSkillPicker';

const createSkill = (overrides = {}) => ({
  id: 'skill-1',
  name: 'weather-skill',
  description: 'desc',
  enabled: true,
  isOfficial: false,
  isBuiltIn: false,
  updatedAt: 0,
  prompt: 'prompt',
  skillPath: '/tmp/skill',
  ...overrides,
});

test('GigSquareSkillPicker uses compact select-add controls instead of an expanded checkbox list', () => {
  const markup = renderToStaticMarkup(
    <GigSquareSkillPicker
      id="test-skill-picker"
      options={[
        createSkill({ id: 'skill-weather', name: 'weather-skill' }),
        createSkill({ id: 'skill-report', name: 'reporter' }),
      ]}
      selectedSkillIds={['skill-weather']}
      onSelectedSkillIdsChange={() => {}}
    />,
  );

  assert.match(markup, /<select[^>]*id="test-skill-picker"/);
  assert.match(markup, />添加</);
  assert.match(markup, /data-slot="gig-square-selected-skill-chips"[\s\S]*weather-skill/);
  assert.doesNotMatch(markup, /type="checkbox"/);
});
