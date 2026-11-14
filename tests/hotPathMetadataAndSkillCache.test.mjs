import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { SkillManager } = require('../dist-electron/main/skillManager.js');
const { rotateMetaidLogIfNeeded } = require('../dist-electron/main/services/metaidLog.js');
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');

function disposeStore(sqliteStore, dir) {
  try {
    sqliteStore.close();
  } catch {
    // already closed
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows handle tolerance
  }
}

test('SkillManager.listSkills caches parsed SKILL.md frontmatter and invalidates when file mtime/size changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-skill-cache-'));
  const skillsRoot = path.join(dir, 'skills');
  const demoSkillDir = path.join(skillsRoot, 'demo-skill');
  fs.mkdirSync(demoSkillDir, { recursive: true });
  const skillMdPath = path.join(demoSkillDir, 'SKILL.md');
  fs.writeFileSync(
    skillMdPath,
    '---\nname: Demo Skill\ndescription: First description\n---\n\nPrompt body v1\n',
    'utf8',
  );

  const sqliteStore = await SqliteStore.create(dir);
  const originalReadFileSync = fs.readFileSync;
  let skillMdReads = 0;
  fs.readFileSync = function patchedReadFileSync(target, ...rest) {
    if (String(target) === skillMdPath) {
      skillMdReads += 1;
    }
    return originalReadFileSync.call(this, target, ...rest);
  };

  try {
    const manager = new SkillManager(() => sqliteStore);
    manager.ensureSkillsRoot = () => skillsRoot;
    manager.getBundledSkillsRoot = () => null;

    const first = manager.listSkills();
    assert.equal(first.length, 1);
    assert.equal(first[0].description, 'First description');
    assert.equal(skillMdReads, 1);

    const second = manager.listSkills();
    assert.equal(second.length, 1);
    assert.equal(second[0].description, 'First description');
    assert.equal(skillMdReads, 1, 'second listSkills call must reuse cached SKILL.md parse');

    fs.writeFileSync(
      skillMdPath,
      '---\nname: Demo Skill\ndescription: Updated description with more bytes\n---\n\nPrompt body v2\n',
      'utf8',
    );
    const futureTime = new Date(Date.now() + 5000);
    fs.utimesSync(skillMdPath, futureTime, futureTime);

    const third = manager.listSkills();
    assert.equal(third[0].description, 'Updated description with more bytes');
    assert.equal(third[0].prompt, 'Prompt body v2');
    assert.equal(skillMdReads, 2, 'modified SKILL.md must re-read and re-parse automatically');
  } finally {
    fs.readFileSync = originalReadFileSync;
    disposeStore(sqliteStore, dir);
  }
});

test('CoworkStore.hasMultipleUserMessages detects <=1 vs >=2 user turns without loading transcript', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-user-count-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    const db = sqliteStore.getDatabase();
    const coworkStore = new CoworkStore(db, sqliteStore.getSaveFunction());
    const session = coworkStore.createSession('Browser Stage', '/tmp', '', 'local', [], null, 'browser');
    assert.equal(coworkStore.hasMultipleUserMessages(session.id), false);

    coworkStore.addMessage(session.id, { type: 'user', content: 'first' });
    coworkStore.addMessage(session.id, { type: 'assistant', content: 'reply 1' });
    assert.equal(coworkStore.hasMultipleUserMessages(session.id), false);

    coworkStore.addMessage(session.id, { type: 'user', content: 'second' });
    assert.equal(coworkStore.hasMultipleUserMessages(session.id), true);
  } finally {
    disposeStore(sqliteStore, dir);
  }
});

test('rotateMetaidLogIfNeeded rotates oversized metaid-rpc.log to .old', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-rpc-log-'));
  try {
    const logPath = path.join(dir, 'metaid-rpc.log');
    fs.writeFileSync(logPath, 'x'.repeat(2048), 'utf8');
    rotateMetaidLogIfNeeded(logPath, 1024);
    assert.equal(fs.existsSync(logPath), false);
    assert.equal(fs.existsSync(`${logPath}.old`), true);
    assert.equal(fs.statSync(`${logPath}.old`).size, 2048);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

test('main.ts hot metadata providers avoid full-transcript getSession loads', () => {
  const mainSource = fs.readFileSync(
    path.resolve(import.meta.dirname, '..', 'src/main/main.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  assert.match(mainSource, /mcpServerProvider:[\s\S]{0,220}getCoworkStore\(\)\.getSessionMetabotId\(coworkSessionId\)/);
  assert.match(mainSource, /browserAutomationProvider:[\s\S]{0,120}getCoworkStore\(\)\.getSessionMetabotId\(coworkSessionId\)/);
  assert.match(mainSource, /computerUseProvider:[\s\S]{0,120}getCoworkStore\(\)\.getSessionMetabotId\(coworkSessionId\)/);
  assert.match(mainSource, /createStudioLiveStageService\(\{\s*getSession: \(sessionId\) => getCoworkStore\(\)\.getSessionWithoutMessages\(sessionId\),\s*hasMultipleUserMessages:/);
});
