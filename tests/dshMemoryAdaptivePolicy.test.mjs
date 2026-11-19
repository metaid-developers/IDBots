import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  resolveDshRuntimeIdleTtlMsForMemory,
  shouldSkipSecondaryCleanWarmupForMemory,
  DSH_RUNTIME_IDLE_TTL_MS,
  DSH_RUNTIME_PRESSURE_IDLE_TTL_MS,
  DSH_RUNTIME_CRITICAL_PRESSURE_IDLE_TTL_MS,
} = require('../dist-electron/main/libs/coworkDshTurn.js');

test('resolveDshRuntimeIdleTtlMsForMemory scales idle TTL across healthy, pressure, and critical swap tiers', () => {
  assert.equal(resolveDshRuntimeIdleTtlMsForMemory(DSH_RUNTIME_IDLE_TTL_MS, 2048), DSH_RUNTIME_IDLE_TTL_MS);
  assert.equal(resolveDshRuntimeIdleTtlMsForMemory(DSH_RUNTIME_IDLE_TTL_MS, 512), DSH_RUNTIME_PRESSURE_IDLE_TTL_MS);
  assert.equal(resolveDshRuntimeIdleTtlMsForMemory(DSH_RUNTIME_IDLE_TTL_MS, 128), DSH_RUNTIME_CRITICAL_PRESSURE_IDLE_TTL_MS);
  assert.equal(resolveDshRuntimeIdleTtlMsForMemory(0, 128), 0);
});

test('resolveDshRuntimeIdleTtlMsForMemory preserves the fixed server TTL when pressure adaptation is disabled', () => {
  const serverTtl = 10 * 60_000;
  assert.equal(resolveDshRuntimeIdleTtlMsForMemory(serverTtl, 128, false), serverTtl);
  assert.equal(resolveDshRuntimeIdleTtlMsForMemory(serverTtl, 512, false), serverTtl);
  assert.equal(resolveDshRuntimeIdleTtlMsForMemory(serverTtl, 2048, false), serverTtl);
  assert.equal(resolveDshRuntimeIdleTtlMsForMemory(0, 128, false), 0);
  assert.equal(
    resolveDshRuntimeIdleTtlMsForMemory(DSH_RUNTIME_IDLE_TTL_MS, 128, true),
    DSH_RUNTIME_CRITICAL_PRESSURE_IDLE_TTL_MS,
    'desktop pressure behavior remains unchanged',
  );
});

test('shouldSkipSecondaryCleanWarmupForMemory caps startup warmup to one slot on memory-constrained hosts when automation slot booted', () => {
  assert.equal(
    shouldSkipSecondaryCleanWarmupForMemory({
      hasComboWarmupSupport: true,
      topComboHasAutomation: true,
      freeMemoryMb: 120,
      totalMemoryMb: 16_384,
    }),
    true,
  );
  assert.equal(
    shouldSkipSecondaryCleanWarmupForMemory({
      hasComboWarmupSupport: true,
      topComboHasAutomation: true,
      freeMemoryMb: 800,
      totalMemoryMb: 16_384,
    }),
    true,
  );
  assert.equal(
    shouldSkipSecondaryCleanWarmupForMemory({
      hasComboWarmupSupport: true,
      topComboHasAutomation: true,
      freeMemoryMb: 4096,
      totalMemoryMb: 32_768,
    }),
    false,
  );
  assert.equal(
    shouldSkipSecondaryCleanWarmupForMemory({
      hasComboWarmupSupport: true,
      topComboHasAutomation: false,
      freeMemoryMb: 120,
      totalMemoryMb: 8_192,
    }),
    false,
    'when topCombo has no automation flags it shares the clean kernel, so bootCleanSlot can run safely',
  );
  assert.equal(
    shouldSkipSecondaryCleanWarmupForMemory({
      hasComboWarmupSupport: false,
      topComboHasAutomation: true,
      freeMemoryMb: 120,
      totalMemoryMb: 8_192,
    }),
    false,
  );
});
