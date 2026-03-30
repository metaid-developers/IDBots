import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const {
  FEATURED_SKILL_ADDRESSES,
  buildOfficialSkillStatuses,
} = require('../dist-electron/services/skillSyncService.js');

function makeSkillPin({
  name,
  version,
  address,
  globalMetaId,
  skillFileUri,
  description,
}) {
  return {
    address,
    globalMetaId,
    contentSummary: JSON.stringify({
      name,
      version,
      description: description ?? `${name} description`,
      'skill-file': skillFileUri ?? `metafile://${name}-${version}`,
    }),
  };
}

test('FEATURED_SKILL_ADDRESSES keeps the featured curator address priority order', () => {
  assert.deepEqual(FEATURED_SKILL_ADDRESSES, [
    '1MFi1WM2NXnV3kjdLKaUw7Ad23LSvSD9fY',
    '1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za',
    '12ghVWG1yAgNjzXj4mr3qK9DgyornMUikZ',
  ]);
});

test('buildOfficialSkillStatuses prefers the higher remote version for duplicate skill names', () => {
  const skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-skill-sync-'));
  const skills = buildOfficialSkillStatuses([
    makeSkillPin({
      name: 'alpha-skill',
      version: '1.0.0',
      address: FEATURED_SKILL_ADDRESSES[0],
      globalMetaId: 'meta-priority-1',
    }),
    makeSkillPin({
      name: 'alpha-skill',
      version: '1.2.0',
      address: FEATURED_SKILL_ADDRESSES[2],
      globalMetaId: 'meta-priority-3',
    }),
  ], {
    config: { defaults: {} },
    skillsRoot,
  });

  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, 'alpha-skill');
  assert.equal(skills[0].remoteVersion, '1.2.0');
  assert.equal(skills[0].remoteCreator, 'meta-priority-3');
  assert.equal(skills[0].status, 'download');
});

test('buildOfficialSkillStatuses keeps the higher-priority curator record when duplicate versions tie', () => {
  const skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-skill-sync-'));
  const skills = buildOfficialSkillStatuses([
    makeSkillPin({
      name: 'beta-skill',
      version: '2.0.0',
      address: FEATURED_SKILL_ADDRESSES[1],
      globalMetaId: 'meta-priority-2',
    }),
    makeSkillPin({
      name: 'beta-skill',
      version: '2.0.0',
      address: FEATURED_SKILL_ADDRESSES[0],
      globalMetaId: 'meta-priority-1',
    }),
  ], {
    config: { defaults: {} },
    skillsRoot,
  });

  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, 'beta-skill');
  assert.equal(skills[0].remoteVersion, '2.0.0');
  assert.equal(skills[0].remoteCreator, 'meta-priority-1');
  assert.equal(skills[0].status, 'download');
});
