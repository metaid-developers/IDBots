import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGigSquareSkillSelectionOptions,
  buildGigSquareModifySkillOptions,
  getEnabledGigSquareSkills,
  normalizeGigSquareProviderSkillNames,
  resolveGigSquareSelectedProviderSkills,
  resolveGigSquareModifySkillSelection,
} from '../src/renderer/components/gigSquare/gigSquareSkillOptions.js';

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

test('getEnabledGigSquareSkills only returns enabled skills', () => {
  const skills = [
    createSkill({ id: 'skill-enabled', name: 'enabled-skill', enabled: true }),
    createSkill({ id: 'skill-disabled', name: 'disabled-skill', enabled: false }),
    createSkill({ id: 'skill-enabled-2', name: 'enabled-skill-2', enabled: true }),
  ];

  assert.deepEqual(
    getEnabledGigSquareSkills(skills).map((skill) => skill.name),
    ['enabled-skill', 'enabled-skill-2'],
  );
});

test('normalizeGigSquareProviderSkillNames trims and de-duplicates provider skill names', () => {
  assert.deepEqual(
    normalizeGigSquareProviderSkillNames([' weather-skill ', '', 'weather-skill', null, 'reporter']),
    ['weather-skill', 'reporter'],
  );
});

test('buildGigSquareSkillSelectionOptions includes enabled skills and selected unknown legacy skills as read-only entries', () => {
  const skills = [
    createSkill({ id: 'skill-enabled', name: 'enabled-skill', enabled: true }),
    createSkill({ id: 'skill-disabled', name: 'disabled-skill', enabled: false }),
  ];

  const options = buildGigSquareSkillSelectionOptions(skills, ['legacy-skill', 'enabled-skill', 'legacy-skill']);

  assert.deepEqual(
    options.map((skill) => ({
      id: skill.id,
      name: skill.name,
      readOnly: Boolean(skill.readOnly),
    })),
    [
      { id: '__current__:legacy-skill', name: 'legacy-skill', readOnly: true },
      { id: 'skill-enabled', name: 'enabled-skill', readOnly: false },
    ],
  );
});

test('resolveGigSquareSelectedProviderSkills maps selected option ids to unique provider skill names', () => {
  const options = buildGigSquareSkillSelectionOptions([
    createSkill({ id: 'skill-weather', name: 'weather-skill', enabled: true }),
    createSkill({ id: 'skill-report', name: 'reporter', enabled: true }),
  ], ['legacy-skill']);

  assert.deepEqual(
    resolveGigSquareSelectedProviderSkills(options, [
      'skill-report',
      '__current__:legacy-skill',
      'skill-report',
      'missing-id',
      'skill-weather',
    ]),
    ['reporter', 'legacy-skill', 'weather-skill'],
  );
});

test('buildGigSquareModifySkillOptions does not re-add the current skill when it exists but is disabled', () => {
  const skills = [
    createSkill({ id: 'skill-disabled', name: 'disabled-skill', enabled: false }),
    createSkill({ id: 'skill-enabled', name: 'enabled-skill', enabled: true }),
  ];

  const options = buildGigSquareModifySkillOptions(skills, 'disabled-skill');

  assert.deepEqual(
    options.map((skill) => skill.name),
    ['enabled-skill'],
  );
});

test('buildGigSquareModifySkillOptions preserves a current skill only when it is missing entirely from the loaded list', () => {
  const skills = [
    createSkill({ id: 'skill-enabled', name: 'enabled-skill', enabled: true }),
  ];

  const options = buildGigSquareModifySkillOptions(skills, 'missing-skill');

  assert.deepEqual(
    options.map((skill) => skill.name),
    ['missing-skill', 'enabled-skill'],
  );
  assert.equal(options[0].id, '__current__:missing-skill');
});

test('resolveGigSquareModifySkillSelection clears the selection when the current skill exists but is disabled', () => {
  const skills = [
    createSkill({ id: 'skill-disabled', name: 'disabled-skill', enabled: false }),
    createSkill({ id: 'skill-enabled', name: 'enabled-skill', enabled: true }),
  ];

  assert.deepEqual(
    resolveGigSquareModifySkillSelection(skills, 'disabled-skill'),
    {
      selectedSkillId: '',
      providerSkill: '',
    },
  );
});
