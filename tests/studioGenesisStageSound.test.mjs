import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const read = (name) => fs.readFileSync(path.resolve('public/genesis-stage', name), 'utf8');

function fakeParam(value = 0) {
  return {
    value,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    exponentialRampToValueAtTime(target) {
      if (!(target > 0)) throw new RangeError(`exponential ramp to ${target}`);
    },
    setTargetAtTime() {},
    cancelScheduledValues() {},
  };
}

function fakeContext() {
  const ctx = {
    sampleRate: 8000,
    currentTime: 0,
    state: 'running',
    destination: { connect() {} },
    started: [],
    resumed: 0,
    suspended: 0,
    closed: 0,
  };
  const node = (extra) => ({ connect: (target) => target, disconnect() {}, ...extra });
  const source = (kind) => node({
    kind,
    start(at = 0) { ctx.started.push({ kind, at }); },
    stop() {},
    onended: null,
  });
  ctx.createGain = () => node({ gain: fakeParam(1) });
  ctx.createOscillator = () => ({ ...source('osc'), type: 'sine', frequency: fakeParam(440), detune: fakeParam(0) });
  ctx.createBiquadFilter = () => node({ type: 'lowpass', frequency: fakeParam(350), Q: fakeParam(1), gain: fakeParam(0) });
  ctx.createBufferSource = () => ({ ...source('noise'), buffer: null, loop: false });
  ctx.createConvolver = () => node({ buffer: null });
  ctx.createDynamicsCompressor = () => node({ threshold: fakeParam(), knee: fakeParam(), ratio: fakeParam(), attack: fakeParam(), release: fakeParam() });
  ctx.createBuffer = (channels, length) => ({ getChannelData: () => new Float32Array(length) });
  ctx.resume = async () => { ctx.resumed += 1; ctx.state = 'running'; };
  ctx.suspend = async () => { ctx.suspended += 1; ctx.state = 'suspended'; };
  ctx.close = async () => { ctx.closed += 1; };
  return ctx;
}

function load() {
  const window = {};
  vm.runInNewContext(read('genesis-sound.js'), { window, Math });
  return window;
}

test('every cue builds a valid Web Audio graph (no exponential ramp to zero)', () => {
  const window = load();
  const ctx = fakeContext();
  const sound = window.createGenesisSound({ context: ctx, immediate: true });
  const names = sound.cueNames();
  assert.ok(names.length >= 20, `${names.length} cues`);
  let at = 1;
  for (const name of names) {
    for (const kind of ['welcome', 'internet', 'chain', 'name', 'collab', 'learn', 'create', 'memory']) {
      const before = ctx.started.length;
      sound.cue(name, { at, kind, index: 2, degree: 3 });
      at += 5;
      assert.ok(ctx.started.length > before, `${name}/${kind} schedules sound`);
      if (name !== 'cue') break;
    }
  }
  sound.frame({ speech: 0.8, glow: 0.4 });
  sound.setBed(1);
  sound.frame({ speech: 2, glow: -1 });
});

test('muted engines schedule nothing and the same cue is throttled', () => {
  const window = load();
  const ctx = fakeContext();
  const muted = window.createGenesisSound({ context: ctx, enabled: false });
  const ambient = ctx.started.length;
  muted.cue('birth', { at: 1 });
  muted.cue('chapter', { at: 2 });
  assert.equal(ctx.started.length, ambient, 'no voices while muted');

  muted.setEnabled(true);
  muted.cue('segment', { at: 10 });
  const afterFirst = ctx.started.length;
  muted.cue('segment', { at: 10.1 });
  assert.equal(ctx.started.length, afterFirst, 'a second segment cue inside the gate is dropped');
  muted.cue('segment', { at: 10.6 });
  assert.ok(ctx.started.length > afterFirst, 'outside the gate it plays again');

  muted.cue('cue', { at: 20, kind: 'welcome' });
  const afterCue = ctx.started.length;
  muted.cue('cue', { at: 20.05, kind: 'internet' });
  assert.equal(ctx.started.length, afterCue, 'keyword cues share a short global gate');

  muted.fadeOut(1);
  assert.equal(muted.isEnabled(), false);
  muted.cue('birth', { at: 30 });
  assert.equal(ctx.started.length, afterCue, 'faded out for the handoff');
  muted.dispose();
  assert.equal(ctx.closed, 0, 'a provided context is not closed by the engine');
});

test('silence is true silence: no always-on noise layer and a speech-gated bed', () => {
  const window = load();
  const ctx = fakeContext();
  const gains = [];
  const createGain = ctx.createGain;
  ctx.createGain = () => {
    const node = createGain();
    const targets = [];
    node.gain.setTargetAtTime = (value) => { targets.push(value); };
    gains.push({ node, targets });
    return node;
  };
  const sound = window.createGenesisSound({ context: ctx, immediate: true });
  assert.ok(!ctx.started.some((entry) => entry.kind === 'noise'), 'no looping noise source runs at rest');
  sound.setBed(1);
  gains.forEach((entry) => { entry.targets.length = 0; });
  sound.frame({ speech: 0, glow: 1 });
  const idleTargets = gains.flatMap((entry) => entry.targets);
  assert.ok(idleTargets.length > 0, 'the bed gain is driven every frame');
  assert.ok(idleTargets.every((value) => value === 0), `idle frame targets ${idleTargets.join(',')} must all be 0`);
  gains.forEach((entry) => { entry.targets.length = 0; });
  sound.frame({ speech: 0.9, glow: 0 });
  assert.ok(gains.flatMap((entry) => entry.targets).some((value) => value > 0), 'speech opens the bed');
});

test('the engine degrades to silence without Web Audio', () => {
  const window = load();
  const sound = window.createGenesisSound();
  assert.equal(sound.getContext(), null);
  assert.doesNotThrow(() => { sound.cue('birth'); sound.frame({}); sound.setBed(1); sound.setEnabled(true); sound.dispose(); });
});

test('the stage only calls cues the engine defines, and the sound stays local', () => {
  const window = load();
  const names = new Set(window.createGenesisSound({ context: fakeContext() }).cueNames());
  const stage = read('genesis.js');
  const used = [...stage.matchAll(/sfx\('([a-z-]+)'/g)].map((match) => match[1]);
  assert.ok(used.length >= 20, `${used.length} cue calls`);
  for (const name of used) assert.ok(names.has(name), `cue ${name} exists`);
  const source = read('genesis-sound.js');
  assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|https?:\/\/|new Audio\(/, 'synthesized, never downloaded');
  assert.match(stage, /const SOUND_KEY = 'idbots\.genesis\.sound';/);
  assert.match(stage, /if \(document\.hidden\) sound\.suspend\(\); else sound\.resume\(\);/);
  assert.match(stage, /setTimeout\(\(\) => sound\.fadeOut\(1\.6\), 1300\)/);
});
