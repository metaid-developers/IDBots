// Static wiring checks for the assistant-mode system-prompt gate: the
// ASSISTANT_MODE_PROMPT section may mount only for sessions carrying the
// per-session assistantMode marker (the BotHub layer, 总裁办公室 surface
// ruling 2026-11-09) — group tasks, A2A/IM sessions, Bot Browser pages,
// long-term sessions, auto-created orchestration runs, and every BotWorks
// owner chat keep the professional prompt. The retired global
// chatExperienceMode toggle is read by nothing any more.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const coworkRunnerSource = readFileSync(join(here, '../src/main/libs/coworkRunner.ts'), 'utf8');
const claudeSettingsSource = readFileSync(join(here, '../src/main/libs/claudeSettings.ts'), 'utf8');

test('the assistant-mode prompt section mounts only behind the per-turn gate', () => {
  // The composer mounts the section only when its assistantMode argument is
  // on — professional mode never carries the section.
  assert.ok(
    coworkRunnerSource.includes("assistantMode\n        ? [{ name: 'idbots:assistant-mode'"),
    'composeEffectiveSystemPrompt must mount the section only when its assistantMode argument is on',
  );
  // Both call sites (session start and continue) must resolve the gate
  // per turn — never a value cached at session start.
  const gateCalls = coworkRunnerSource.match(/this\.isAssistantModeOwnerChatSession\(sessionId\)/g) ?? [];
  assert.ok(
    gateCalls.length >= 2,
    'composeEffectiveSystemPrompt call sites must evaluate the gate per turn (start + continue)',
  );
});

test('the gate is marker-only under the 2026-11-09 surface ruling', () => {
  const gate = coworkRunnerSource.match(
    /private isAssistantModeOwnerChatSession\(sessionId: string\): boolean \{[\s\S]*?\n  \}/,
  );
  assert.ok(gate, 'isAssistantModeOwnerChatSession must exist');
  const body = gate[0];
  assert.ok(
    body.includes('session.assistantMode && !session.autoOrigin'),
    'the gate must keep the per-session BotHub marker branch with its autoOrigin guard',
  );
  // The retired Settings value must not be read anywhere in the runner —
  // the mode is decided by the face (renderer) and the marker (backend).
  assert.ok(
    !body.includes('getPersistedChatExperienceMode'),
    'the gate must not read the retired persisted chat experience mode',
  );
  assert.ok(
    !coworkRunnerSource.includes('getPersistedChatExperienceMode'),
    'coworkRunner must carry no reference to the retired persisted mode',
  );
  assert.ok(
    !/function getPersistedChatExperienceMode/.test(claudeSettingsSource),
    'claudeSettings must not keep the retired persisted-mode reader (no dangling reference)',
  );
});

// 2026-10-20 double-acknowledgment report (session 2c70849f): the host-side
// LLM turn-ack bubble (coworkRunner emitTurnAckReplyBubble) landed in ~1s,
// then the model's prompt-mandated opening line opened with "收到" again.
// The host ack owns the instant acknowledgment now; the model's opener must
// carry substance instead, while the structural rules stay.
test('the opening line bans bare-acknowledgment openers — the host ack owns the echo', () => {
  const promptSource = readFileSync(join(here, '../src/main/libs/assistantModePrompt.ts'), 'utf8');
  assert.ok(
    promptSource.includes('NEVER open with a bare acknowledgment'),
    'the opening line must ban bare acknowledgments (the host ack bubble already delivers one)',
  );
  assert.ok(
    promptSource.includes('"收到"'),
    'the ban must name the observed Chinese opener',
  );
  assert.ok(
    !promptSource.includes('fast first response'),
    'the obsolete speed rationale is gone — the host ack owns first-response latency now',
  );
  assert.ok(
    promptSource.includes('never start a task with tool calls alone'),
    'the structural rules stay: no silent tool-call starts',
  );
  assert.ok(
    promptSource.includes('never end a turn with only a promise'),
    'the structural rules stay: no promise-only endings',
  );
});

// 2026-10-13 DeepSeek acceptance findings: with reasoning off, the model
// leaked English internal monologue as narration ("Good. Now let me build…")
// and emitted one bubble per tool round. 2026-10-24 session 2c70849f: the
// soft "2-4 narrations" budget still produced 20 progress bubbles in one
// turn, so visibility moved to the host's structured
// owner_update({ message, kind }) tool with a hard per-turn cap. The prompt
// must carry the language and tone prohibitions AND the owner_update
// protocol plus the final-report contract as explicit rules, not soft
// suggestions.
test('the assistant-mode prompt hard-pins the owner_update protocol, language, tone, and the final-report contract', () => {
  const promptSource = readFileSync(join(here, '../src/main/libs/assistantModePrompt.ts'), 'utf8');
  // Language + tone hard prohibitions (unchanged incidents: 2026-10-13
  // English monologue, 2026-10-22 asymmetric language rule).
  assert.ok(
    promptSource.includes('NEVER narrate in English'),
    'the language rule must be a hard prohibition (English narration only when the user writes English)',
  );
  assert.ok(
    promptSource.includes('中文 →'),
    'the language rule must carry an explicit Chinese example',
  );
  assert.ok(
    promptSource.includes('NEVER self-talk'),
    'the tone rule must ban internal monologue ("let me check", "I miscounted")',
  );
  assert.ok(
    promptSource.includes('已找到中文版的文件'),
    'the tone rule must carry the user-facing status example',
  );
  // The visibility protocol: owner_update is the ONLY progress channel, with
  // the opening kind, a hard per-turn budget, and the three accepted kinds.
  assert.ok(
    promptSource.includes('owner_update({ message, kind })'),
    'owner_update({message,kind}) must be the only way to show progress before the final reply',
  );
  assert.ok(
    promptSource.includes('kind: "opening"'),
    'the opening update kind must be mandated for multi-step work',
  );
  assert.ok(
    promptSource.includes('AT MOST 5 further owner_update calls'),
    'at most 5 further updates after the opening',
  );
  assert.ok(
    promptSource.includes('6 total including the opening'),
    'the total per-turn budget must be stated (6 including the opening)',
  );
  assert.ok(
    promptSource.includes('"milestone"'),
    'kind "milestone" must be defined for meaningful results',
  );
  assert.ok(
    promptSource.includes('"problem"'),
    'kind "problem" must be defined for owner-relevant blockers',
  );
  assert.ok(
    promptSource.includes('ordinary mid-turn commentary is hidden'),
    'the prompt must state that plain commentary never reaches the owner',
  );
  assert.ok(
    promptSource.includes('retries and self-corrections are internal'),
    'routine retries and setup must stay internal',
  );
  assert.ok(
    !promptSource.includes('2-4 narrations'),
    'the soft "2-4 narrations" budget is gone — it produced 20 bubbles in one turn (2026-10-24)',
  );
  // The final-report contract for complex tasks.
  assert.ok(
    promptSource.includes('the final reply MUST include clear short sections for the outcome'),
    'a complex final reply must lead with the outcome',
  );
  assert.ok(
    promptSource.includes('unresolved issues or limits'),
    'the final reply must state unresolved issues or limits (explicitly none when there are none)',
  );
  assert.ok(
    promptSource.includes('recommended next actions'),
    'the final reply must recommend next actions',
  );
  assert.ok(
    promptSource.includes('Use a compact Markdown table for structured comparisons'),
    'simple structured comparisons prefer a compact Markdown table',
  );
  assert.ok(
    promptSource.includes('Use an HTML report only when richer visual presentation would be materially clearer'),
    'HTML is optional and reserved for materially clearer cases',
  );
});

// 2026-10-22 English-install regression (first-run Twin greeting in Chinese on
// a fully English machine, free-relay deepseek-4.1-flash): the old language
// rule made Chinese mandatory ("every narration and the final reply are in
// Chinese") while English was only permitted ("only if the user writes
// English may they be English"). The greeting turn carries no user-authored
// text, so the model followed the only mandatory direction and greeted in
// Chinese. The rule must stay symmetric: BOTH languages mandatory in their
// own conversations, prohibited in the other's.
test('the language rule is symmetric — English is as mandatory as 中文', () => {
  const promptSource = readFileSync(join(here, '../src/main/libs/assistantModePrompt.ts'), 'utf8');
  assert.ok(
    !promptSource.includes('only if the user writes English may they be English'),
    'the permissive English phrasing regressed once and flipped English installs to Chinese output; English must be mandatory, not permitted',
  );
  assert.ok(
    promptSource.includes('the user writes English → every narration and the final reply are in English'),
    'the rule must state the English direction as mandatory, mirroring the 中文 direction',
  );
  assert.ok(
    promptSource.includes('NEVER write 中文 in an English conversation'),
    'the rule must prohibit Chinese output in English conversations just as it prohibits English narration in non-English ones',
  );
  assert.ok(
    promptSource.includes('Found the Chinese edition of the file'),
    'the narration example must not be Chinese-only — a Chinese-only "Good" example pulls flash models toward Chinese even in English chats',
  );
});

// 2026-10-22 owner follow-up: "the language of the user's own messages" is
// UNDEFINED while the user has not typed anything — exactly the first-greeting
// case. The section must therefore carry an explicit UI-language anchor,
// resolved from the same persisted app language the UI i18n reads (tApp), so
// zero-input turns are told the conversation language instead of inferring it
// from ambient prompt prose. The anchor yields to the user's own words after
// they write.
test('the section anchors the UI language for zero-user-input turns', () => {
  const promptSource = readFileSync(join(here, '../src/main/libs/assistantModePrompt.ts'), 'utf8');
  const runnerSource = readFileSync(join(here, '../src/main/libs/coworkRunner.ts'), 'utf8');
  const mainSource = readFileSync(join(here, '../src/main/main.ts'), 'utf8');
  assert.ok(
    promptSource.includes('export function buildAssistantModePrompt'),
    'the section must be a per-call builder so the language anchor resolves from the persisted app language at compose time',
  );
  assert.ok(
    !promptSource.includes('export const ASSISTANT_MODE_PROMPT'),
    'a frozen const cannot carry a locale-resolved anchor',
  );
  assert.ok(
    promptSource.includes('tApp(ASSISTANT_MODE_LANGUAGE_ANCHOR_ZH, ASSISTANT_MODE_LANGUAGE_ANCHOR_EN)'),
    'the anchor must ride tApp — the same persisted-app-language source the UI uses',
  );
  assert.ok(
    promptSource.includes('until they write in another language, every visible line in this conversation'),
    'the English anchor must mandate English output for the whole conversation until the user writes otherwise',
  );
  assert.ok(
    promptSource.includes('一律使用中文'),
    'the Chinese anchor must mandate Chinese output for the whole conversation until the owner writes otherwise',
  );
  assert.ok(
    runnerSource.includes('text: buildAssistantModePrompt(projectorMode)'),
    'the composer must mount the built section, not a stale const',
  );
  assert.ok(
    mainSource.includes('Greet them in English now') && mainSource.includes('用中文向他问好'),
    'the greeting turn instruction must name the output language in both tApp branches — it is the only user-role text a first greeting has',
  );
});

test('the projector section exists, mounts after assistant-mode, and swaps the inline clauses for projection', () => {
  const promptSource = readFileSync(join(here, '../src/main/libs/assistantModePrompt.ts'), 'utf8');
  const runnerSource = readFileSync(join(here, '../src/main/libs/coworkRunner.ts'), 'utf8');
  const composerSource = readFileSync(join(here, '../src/main/libs/promptComposer.ts'), 'utf8');

  assert.ok(
    promptSource.includes('export function buildProjectorModePrompt'),
    'the projector section must be a per-call builder (tApp language anchor contract)',
  );
  assert.ok(
    promptSource.includes('首轮（硬规则）') && promptSource.includes('First turn (hard rule)'),
    'the first-turn-must-project ruling must be stated in both languages',
  );
  assert.ok(
    promptSource.includes('ASSISTANT_MODE_OPTIONAL_EMBED_CLAUSES') && promptSource.includes('...(projectorMode ? [] : ASSISTANT_MODE_OPTIONAL_EMBED_CLAUSES)'),
    'projector sessions must drop the optional inline HTML/MetaApp clauses (ruling #7)',
  );
  assert.ok(
    composerSource.includes('PROJECTOR_MODE: 56'),
    'the projector section mounts right after assistant-mode (55)',
  );
  assert.ok(
    runnerSource.includes('this.isProjectorModeSession(sessionId)'),
    'the composer must gate the projector section on the per-session marker',
  );
  assert.ok(
    runnerSource.includes("name: 'idbots:projector-mode'"),
    'the composer must mount the projector section under its own name',
  );
});
