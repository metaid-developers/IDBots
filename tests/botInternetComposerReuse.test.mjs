import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const readSource = (relative) => readFileSync(join(here, relative), 'utf8');

const panelSource = readSource('../src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx');
const promptInputSource = readSource('../src/renderer/components/cowork/CoworkPromptInput.tsx');
const pickerSource = readSource('../src/renderer/components/ModelEffortPicker.tsx');
const browserCoworkSource = readSource('../src/renderer/services/browserCowork.ts');

test('Bot Browser panel toolbar keeps only the model picker (+badge) and drives the rest via the composer', () => {
  // The standalone attachment / skills toolbar buttons are gone.
  assert.ok(!panelSource.includes('SkillsButton'), 'standalone skills button should be removed from the panel');
  assert.ok(!panelSource.includes('PaperClipIcon'), 'standalone attachment button should be removed from the panel');
  // The model picker stays in the toolbar and escapes the overflow-hidden sidebar.
  assert.ok(panelSource.includes('<ModelEffortPicker'), 'model picker must stay in the panel toolbar');
  assert.ok(panelSource.includes('useFixedDropdown'), 'panel model picker must use the fixed dropdown mode');
  // The '+' menu provides attachments + skills (+ commands) inside the composer.
  assert.ok(!panelSource.includes('showAttachmentButton={false}'), 'composer attachment affordance must stay enabled');
  assert.ok(panelSource.includes('onManageSkills='), 'composer must be able to open skill management');
  assert.ok(panelSource.includes('commands={browserComposerCommands}'), 'composer must receive the slash-command catalog');
});

test('Bot Browser panel folder button reuses the cowork project-mode workspace popover', () => {
  // Same FolderSelectorPopover as the cowork home composer, with the full
  // project-mode menu: projects / new project / add folder / bot workspace.
  assert.ok(panelSource.includes('FolderSelectorPopover'), 'workspace popover must stay in the panel');
  assert.ok(panelSource.includes('onSelectProject='), 'workspace popover must offer projects');
  assert.ok(panelSource.includes('onOpenNewProject='), 'workspace popover must offer creating a project');
  assert.ok(panelSource.includes('onSelectBotWorkspace='), 'workspace popover must offer the bot workspace');
  assert.ok(
    panelSource.includes("setWorkspaceSelection({ kind: 'folder'"),
    'folder picks must flow into the workspace selection state',
  );
  // The selection feeds the session start cwd (project/folder only).
  assert.ok(
    panelSource.includes('browserCoworkService.start(prompt, effectiveMetabotId, startCwd'),
    'workspace selection must resolve to the session start cwd',
  );
});

test('Bot Browser panel wires the session slash-command catalog for live sessions', () => {
  assert.ok(
    panelSource.includes('buildSessionComposerCommands({ sessionId: currentSession.id'),
    'live browser sessions should reuse the cowork session command catalog',
  );
});

test("composer '+' menu floats fixed above its trigger", () => {
  // Fixed placement escapes the sidebar's overflow-hidden clipping; the menu
  // keeps the w-64 sizing but drops the old absolute bottom-full anchoring.
  assert.ok(promptInputSource.includes('placePopoverAbove'), 'plus menu should use the shared fixed placement helper');
  assert.match(
    promptInputSource,
    /className="fixed z-50 w-64 rounded-xl/,
    'plus menu root should be position:fixed',
  );
});

test('slash commands are not large-composer-only anymore', () => {
  assert.match(
    promptInputSource,
    /const commandsEnabled = !disabled && commands !== undefined && commands\.length > 0;/,
    'commandsEnabled must not depend on isLarge',
  );
});

test('Bot Browser panel forwards pinned skills like the home composer', () => {
  // The panel must accept the composer's second onSubmit argument instead of
  // dropping it.
  assert.match(
    panelSource,
    /const handleSubmit = async \(prompt: string, skillPrompt\?: string\) =>/,
    'handleSubmit must accept the pinned-skill prompt argument',
  );
  // Snapshot + clear semantics, and the payload rides both submit paths.
  assert.ok(panelSource.includes('clearActiveSkills'), 'pins must clear after submitting');
  assert.ok(
    panelSource.includes('browserCoworkService.send(outgoingPrompt, skills)'),
    'send path must forward the skills payload',
  );
  assert.match(
    panelSource,
    /browserCoworkService\.start\(prompt, effectiveMetabotId, startCwd, \{[\s\S]*?\}, skills, startProjectId, prompt, captureOutgoingPrompt\)/,
    'start path must forward the skills payload, project binding, and deferred prompt enrichment',
  );
  // Service side: pinned `## Skill:` blocks embed into the base prompt and
  // the ids ride startSession/submitInput (persisted main-side).
  assert.ok(
    browserCoworkSource.includes('return [skillPrompt, config.systemPrompt]'),
    'pinned skill blocks must embed into the browser session system prompt',
  );
  assert.ok(
    browserCoworkSource.includes('{ activeSkillIds: skills.activeSkillIds }'),
    'activeSkillIds must flow into the session/turn submission',
  );
  // Ordinary turns keep the persisted prompt (DeepSeek prefix-cache policy).
  assert.match(
    browserCoworkSource,
    /const systemPrompt = skills\?\.activeSkillIds\?\.length/,
    'continue path must only rebuild the system prompt when skills are pinned',
  );
});

test('ModelEffortPicker exposes an opt-in fixed dropdown mode', () => {
  assert.ok(pickerSource.includes('useFixedDropdown?: boolean;'), 'fixed dropdown prop must exist');
  assert.match(
    pickerSource,
    /'fixed w-72 dark:bg-claude-darkSurface/,
    'fixed dropdown branch must render position:fixed',
  );
  assert.ok(pickerSource.includes('placePopoverAbove'), 'picker should use the shared fixed placement helper');
});

test('panel scopes the skills picker to the session bot (pinned-skill auth surface)', () => {
  assert.ok(
    panelSource.includes('sessionMetabotId={currentSession?.metabotId ?? effectiveMetabotId}'),
    'panel must thread the session bot binding into the composer skills picker',
  );
});

test('workspace choice is remembered per surface and project bindings are validated', () => {
  assert.ok(
    panelSource.includes("'idbots.botBrowser.workspaceSelection'"),
    'panel must persist its workspace selection under its own storage key',
  );
  assert.ok(
    panelSource.includes('projectsService.loadProjects()'),
    'restored project bindings must be validated against the live project list',
  );
  // Project binding rides session start (main-side pins the project dir).
  assert.ok(
    browserCoworkSource.includes('{ projectId: projectId.trim() }'),
    'start must forward the project binding',
  );
});

test('anchored popovers stay in the viewport and follow a moving anchor', () => {
  const utilSource = readSource('../src/renderer/utils/anchoredPopover.ts');
  assert.match(
    utilSource,
    /Math\.max\(MARGIN, unclampedTop\)/,
    'placePopoverAbove must clamp the top edge into the viewport',
  );
  assert.ok(
    utilSource.includes('export function useAnchorMoveWatcher'),
    'a move-watcher hook must exist for popovers anchored to shifting triggers',
  );
  // Consumers: model picker (fixed mode), plus menu, command picker.
  assert.ok(pickerSource.includes('useAnchorMoveWatcher'), 'model picker must watch its anchor');
  assert.ok(promptInputSource.includes('useAnchorMoveWatcher'), 'plus menu must watch its anchor');
  const commandPickerSource = readSource('../src/renderer/components/cowork/ComposerCommandPicker.tsx');
  assert.ok(
    commandPickerSource.includes('placePopoverAbove'),
    'command picker must use the shared fixed placement helper',
  );
  assert.match(
    commandPickerSource,
    /'fixed z-50 w-80/,
    'command picker must render position:fixed when anchored',
  );
  assert.match(
    commandPickerSource,
    /maxHeight: `\$\{maxListHeight\}px`/,
    'command picker list must cap its height to the space above the anchor',
  );
  assert.ok(
    promptInputSource.includes('anchorRef={composerCardRef}'),
    'composer must anchor the command picker to the composer card',
  );
});
