import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const readOrb = (relative) => fs.readFileSync(path.resolve('public/live-stage', relative), 'utf8');

test('the shared orb renderer keeps direct params alongside state-driven Live Stage presets', () => {
  const source = readOrb('liquid-orb.js');
  assert.match(source, /setParams\(partial, options = \{\}\) \{/);
  assert.match(source, /setModulation\(offsets\) \{/);
  assert.match(source, /setLerpRate\(rate\) \{/);
  assert.match(source, /const blend = reduced \? 1 : 1 - Math\.exp\(-dt \* lerpRate\);/);
  assert.match(source, /let lerpRate = 5\.5;/);

  const window = {};
  vm.runInNewContext(source, { window });
  const base = window.liquidOrbBaseParams();
  assert.equal(base.colorA, '#FFD86B');
  assert.equal(base.glowColor, '#956CFF');
  const presets = source.match(/const statePresets = \{([\s\S]*?)\n  \};/)[1];
  const deforms = [...presets.matchAll(/contourDeform: ([\d.]+)/g)].map((match) => Number(match[1]));
  assert.ok(deforms.length >= 16);
  for (const value of deforms) assert.ok(value <= 0.95, `Live Stage contourDeform ${value} stays bounded`);
  assert.ok(window.liquidOrbParamsForFamily('reasoning').contourDeform >= .9);
  assert.ok(window.liquidOrbParamsForFamily('speaking').contourDeform <= .045);
});

test('the WGSL contour accepts the Genesis distortion range', () => {
  const window = {};
  vm.runInNewContext(readOrb('liquid-orb-effect.js'), { window });
  const source = window.LiquidOrbEffectSource;
  assert.equal((source.match(/clamp\(amount, 0\.0, 4\.0\) \* glsContourStrength\(\)/g) ?? []).length, 2);
  assert.doesNotMatch(source, /clamp\(amount, 0\.0, 1\.0\) \* glsContourStrength\(\)/);
});
