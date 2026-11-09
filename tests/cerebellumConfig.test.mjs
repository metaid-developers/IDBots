import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CEREBELLUM_DEFAULT_BASE_URL,
  CEREBELLUM_DEFAULT_MODEL,
  CEREBELLUM_FREE_MODEL,
  CEREBELLUM_FREE_RELAY_BASE_URL,
  resolveCerebellumConfig,
} from '../src/main/libs/cerebellumConfig.ts';

test('resolveCerebellumConfig returns null for missing configs', () => {
  assert.equal(resolveCerebellumConfig(undefined), null);
  assert.equal(resolveCerebellumConfig(null), null);
  assert.equal(resolveCerebellumConfig({}), null);
  assert.equal(resolveCerebellumConfig('cerebellum'), null);
  assert.equal(resolveCerebellumConfig(42), null);
});

test('resolveCerebellumConfig returns null when disabled', () => {
  assert.equal(
    resolveCerebellumConfig({
      cerebellum: {
        enabled: false,
        provider: 'typesafe-jev',
        apiKey: 'sk-jev',
        baseUrl: CEREBELLUM_DEFAULT_BASE_URL,
        model: CEREBELLUM_DEFAULT_MODEL,
      },
    }),
    null,
  );
  // Missing enabled flag counts as disabled.
  assert.equal(
    resolveCerebellumConfig({ cerebellum: { provider: 'typesafe-jev', apiKey: 'sk-jev' } }),
    null,
  );
});

test('resolveCerebellumConfig returns null without an api key', () => {
  const base = { enabled: true, provider: 'typesafe-jev', baseUrl: CEREBELLUM_DEFAULT_BASE_URL };
  assert.equal(resolveCerebellumConfig({ cerebellum: base }), null);
  assert.equal(resolveCerebellumConfig({ cerebellum: { ...base, apiKey: '' } }), null);
  assert.equal(resolveCerebellumConfig({ cerebellum: { ...base, apiKey: '   ' } }), null);
  assert.equal(resolveCerebellumConfig({ cerebellum: { ...base, apiKey: 123 } }), null);
});

test('resolveCerebellumConfig resolves a fully configured cerebellum', () => {
  const resolved = resolveCerebellumConfig({
    cerebellum: {
      enabled: true,
      provider: 'typesafe-jev',
      apiKey: ' sk-jev ',
      baseUrl: 'https://jev.example.com',
      model: 'jev-fast',
    },
  });
  assert.deepEqual(resolved, {
    provider: 'typesafe-jev',
    apiKey: 'sk-jev',
    baseUrl: 'https://jev.example.com',
    model: 'jev-fast',
  });
});

test('resolveCerebellumConfig strips trailing slashes from the base URL', () => {
  const resolved = resolveCerebellumConfig({
    cerebellum: {
      enabled: true,
      provider: 'typesafe-jev',
      apiKey: 'sk-jev',
      baseUrl: 'https://jev.example.com///',
      model: 'jev-latest',
    },
  });
  assert.equal(resolved?.baseUrl, 'https://jev.example.com');
});

test('resolveCerebellumConfig fills default base URL and model when blank', () => {
  const resolved = resolveCerebellumConfig({
    cerebellum: {
      enabled: true,
      provider: 'typesafe-jev',
      apiKey: 'sk-jev',
      baseUrl: '',
      model: '  ',
    },
  });
  assert.equal(resolved?.baseUrl, CEREBELLUM_DEFAULT_BASE_URL);
  assert.equal(resolved?.model, CEREBELLUM_DEFAULT_MODEL);
});

test('resolveCerebellumConfig rejects malformed shapes', () => {
  assert.equal(resolveCerebellumConfig({ cerebellum: 'typesafe-jev' }), null);
  assert.equal(resolveCerebellumConfig({ cerebellum: ['typesafe-jev'] }), null);
  assert.equal(resolveCerebellumConfig({ cerebellum: { enabled: 'yes', provider: 'typesafe-jev', apiKey: 'sk' } }), null);
  // Unknown providers are not resolvable until a provider adapter lands.
  assert.equal(
    resolveCerebellumConfig({ cerebellum: { enabled: true, provider: 'other', apiKey: 'sk' } }),
    null,
  );
});

// --- idbots-jev-free (legacy storage id for official IDBots-JEV) branches ---

test('resolveCerebellumConfig resolves IDBots-JEV with an empty api key', () => {
  // The identity-bound ME relay key is injected at call time (credential
  // chain), so a missing stored key must not disable the feature here.
  const resolved = resolveCerebellumConfig({
    cerebellum: {
      enabled: true,
      provider: 'idbots-jev-free',
      apiKey: '',
      baseUrl: '',
      model: '',
    },
  });
  assert.deepEqual(resolved, {
    provider: 'idbots-jev-free',
    apiKey: '',
    baseUrl: CEREBELLUM_FREE_RELAY_BASE_URL,
    model: CEREBELLUM_FREE_MODEL,
  });
});

test('resolveCerebellumConfig pins the IDBots-JEV relay baseUrl and model', () => {
  // Stored values are ignored: the relay endpoint/model is a fixed contract
  // (assist-base-service《JEV 小脑模型中转接口.md》§3).
  const resolved = resolveCerebellumConfig({
    cerebellum: {
      enabled: true,
      provider: 'idbots-jev-free',
      apiKey: 'mrk_stale',
      baseUrl: 'https://evil.example.com',
      model: 'jev-preview',
    },
  });
  assert.equal(resolved?.baseUrl, CEREBELLUM_FREE_RELAY_BASE_URL);
  assert.equal(resolved?.model, CEREBELLUM_FREE_MODEL);
  // A stored key passes through; the runtime resolver may override it.
  assert.equal(resolved?.apiKey, 'mrk_stale');
});

test('resolveCerebellumConfig keeps IDBots-JEV disabled/malformed semantics', () => {
  assert.equal(resolveCerebellumConfig({ cerebellum: { enabled: false, provider: 'idbots-jev-free' } }), null);
  assert.equal(resolveCerebellumConfig({ cerebellum: { provider: 'idbots-jev-free', apiKey: 'mrk' } }), null);
  assert.equal(resolveCerebellumConfig({ cerebellum: { enabled: true, provider: 'idbots-jev-freezz', apiKey: 'mrk' } }), null);
});
