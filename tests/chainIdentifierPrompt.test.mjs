import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  CHAIN_IDENTIFIER_VERBATIM_RULE,
} = require('../dist-electron/main/libs/chainIdentifierPrompt.js');
const {
  composePromptSections,
  PROMPT_SECTION_ORDER,
} = require('../dist-electron/main/libs/promptComposer.js');
const {
  buildGroupTaskSystemPrompt,
} = require('../dist-electron/main/services/groupTaskPrompts.js');

const METABOT = {
  id: 1, name: 'Twin Bot', bio: 'Coordinates the team', goal: 'Ship group tasks',
  globalmetaid: 'gmid-twin', metaid: 'metaid-1', llm_id: 'llm-1',
};
const TASK = { title: 'T', goal: 'G', acceptanceCriteria: 'A' };
const MEMBERS = [
  { metabotId: 1, name: 'Twin Bot', role: 'chair', globalMetaId: 'gmid-twin' },
  { metabotId: 2, name: 'Coder Bot', role: 'worker', globalMetaId: 'gmid-w2' },
];

test('the rule states the exact identifier formats and forbids truncation', () => {
  assert.match(CHAIN_IDENTIFIER_VERBATIM_RULE, /64 lowercase hex characters followed by `i` and the output index/);
  assert.match(CHAIN_IDENTIFIER_VERBATIM_RULE, /pins minted by this host always end in `i0`/);
  assert.match(CHAIN_IDENTIFIER_VERBATIM_RULE, /never truncate/i);
  assert.match(CHAIN_IDENTIFIER_VERBATIM_RULE, /pin:\/\//);
});

test('group task prompts (chair and worker, plain path) carry the verbatim rule', () => {
  for (const botRole of ['chair', 'worker']) {
    const prompt = buildGroupTaskSystemPrompt({
      metabot: METABOT, task: TASK, members: MEMBERS, botRole,
    });
    assert.ok(prompt.includes(CHAIN_IDENTIFIER_VERBATIM_RULE), `${botRole} prompt carries the rule`);
  }
});

test('CHAIN_IDS slot sorts between the MetaApps and Skills blocks', () => {
  const prompt = composePromptSections([
    { name: 'idbots:metaapps', order: PROMPT_SECTION_ORDER.METAAPPS, text: 'METAAPPS' },
    { name: 'idbots:chain-ids', order: PROMPT_SECTION_ORDER.CHAIN_IDS, text: CHAIN_IDENTIFIER_VERBATIM_RULE },
    { name: 'idbots:skills', order: PROMPT_SECTION_ORDER.SKILLS, text: 'SKILLS' },
  ]);
  const metaappsAt = prompt.indexOf('METAAPPS');
  const ruleAt = prompt.indexOf('Chain identifiers are load-bearing');
  const skillsAt = prompt.indexOf('SKILLS');
  assert.ok(metaappsAt >= 0 && ruleAt > metaappsAt && skillsAt > ruleAt,
    'CHAIN_IDS renders after METAAPPS and before SKILLS');
});

test('the cowork runner wires the chain-ids section into its composed prompt', () => {
  const runnerSource = require('node:fs')
    .readFileSync(new URL('../dist-electron/main/libs/coworkRunner.js', import.meta.url), 'utf8');
  assert.match(runnerSource, /idbots:chain-ids/);
  assert.match(runnerSource, /CHAIN_IDENTIFIER_VERBATIM_RULE/);
});
