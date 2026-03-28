import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getOnboardingCloseButtonClassName,
  shouldRouteFirstMetabotCreationToOnboarding,
  shouldShowOnboardingClose,
  shouldShowInitialOnboarding,
} from '../src/renderer/components/onboarding/onboardingGate.js';

test('app init shows onboarding when no provider API key is configured', () => {
  assert.equal(
    shouldShowInitialOnboarding({
      hasProviderWithApiKey: false,
      metabotCount: 3,
    }),
    true,
  );
});

test('app init shows onboarding when provider config exists but there are no local MetaBots', () => {
  assert.equal(
    shouldShowInitialOnboarding({
      hasProviderWithApiKey: true,
      metabotCount: 0,
    }),
    true,
  );
});

test('app init does not show onboarding when provider config exists and local MetaBots are present', () => {
  assert.equal(
    shouldShowInitialOnboarding({
      hasProviderWithApiKey: true,
      metabotCount: 2,
    }),
    false,
  );
});

test('first-MetaBot reroute is enabled only when the local MetaBot count is zero', () => {
  assert.equal(shouldRouteFirstMetabotCreationToOnboarding(0), true);
  assert.equal(shouldRouteFirstMetabotCreationToOnboarding(1), false);
  assert.equal(shouldRouteFirstMetabotCreationToOnboarding(5), false);
});

test('onboarding close button is available during step 1 when a close handler exists', () => {
  assert.equal(
    shouldShowOnboardingClose({
      hasCloseHandler: true,
      step: 1,
      running: false,
      awakeningComplete: false,
    }),
    true,
  );
});

test('onboarding close button is hidden only while step 3 awakening is actively running', () => {
  assert.equal(
    shouldShowOnboardingClose({
      hasCloseHandler: true,
      step: 3,
      running: true,
      awakeningComplete: false,
    }),
    false,
  );
  assert.equal(
    shouldShowOnboardingClose({
      hasCloseHandler: true,
      step: 3,
      running: false,
      awakeningComplete: false,
    }),
    true,
  );
});

test('onboarding close button uses a high-contrast neutral light-mode style', () => {
  const className = getOnboardingCloseButtonClassName();
  assert.match(className, /\bbg-white\b/);
  assert.match(className, /\btext-slate-700\b/);
  assert.match(className, /\bborder-slate-300\b/);
  assert.match(className, /\bshadow-sm\b/);
});
