// 2026-11-11 incident: one host tool's `parameters.type` was 'string' and the
// provider rejected the WHOLE turn —
//   400 upstream_bad_request: "tools.77.function.parameters must be a JSON
//   Schema of type object"
// The old normalizer ended with `{ type: 'object', properties: {}, ...record }`,
// so a record carrying its own non-object `type` overwrote the coerced
// 'object' and was passed through verbatim. These tests pin the repaired
// spread order and the hand-off guard that names the tools it repaired.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { z } = require('zod');
const {
  coerceObjectToolSchema,
  normalizeHostToolParameters,
  guardHostToolSchemas,
  formatHostToolSchemaGuardWarning,
} = require('../dist-electron/main/libs/hostToolSchemaGuard.js');

test('non-object top-level type is coerced to object (the 400 root cause)', () => {
  const normalized = normalizeHostToolParameters({ type: 'string' });
  assert.equal(normalized.type, 'object', 'normalizeToolSchema must not let a record type overwrite the coercion');
  assert.deepEqual(normalized.properties, {});
});

test('coercion keeps every other schema key (required/additionalProperties/$defs/description)', () => {
  const normalized = normalizeHostToolParameters({
    type: 'string',
    description: 'free-form',
    required: ['a'],
    additionalProperties: false,
    $defs: { A: { type: 'string' } },
  });
  assert.equal(normalized.type, 'object');
  assert.deepEqual(normalized.properties, {});
  assert.equal(normalized.description, 'free-form');
  assert.deepEqual(normalized.required, ['a']);
  assert.equal(normalized.additionalProperties, false);
  assert.deepEqual(normalized.$defs, { A: { type: 'string' } });
});

test('coercion preserves an existing properties map', () => {
  const properties = { a: { type: 'string' } };
  const coerced = coerceObjectToolSchema({ type: 'string', properties });
  assert.equal(coerced.type, 'object');
  assert.equal(coerced.properties, properties, 'properties object should be reused, not rebuilt');
});

test('existing object schema is passed through unchanged (same reference)', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } } };
  const normalized = normalizeHostToolParameters(schema);
  assert.equal(normalized, schema, 'already-object schemas must not be rebuilt');
  assert.deepEqual(normalized, { type: 'object', properties: { a: { type: 'string' } } });
});

test('empty schema gets an empty properties map', () => {
  const normalized = normalizeHostToolParameters({});
  assert.equal(normalized.type, 'object');
  assert.deepEqual(normalized.properties, {});
});

test('bare zod raw shape still converts through z.toJSONSchema', () => {
  const normalized = normalizeHostToolParameters({ q: z.string() });
  assert.equal(normalized.type, 'object');
  assert.equal(normalized.properties?.q?.type, 'string');
  assert.deepEqual(normalized.required, ['q']);
});

test('full zod schema still converts through z.toJSONSchema', () => {
  const normalized = normalizeHostToolParameters(z.object({ n: z.number() }));
  assert.equal(normalized.type, 'object');
  assert.equal(normalized.properties?.n?.type, 'number');
});

test('guard catches a non-object schema produced by the zod path (why the second layer exists)', () => {
  // A passthrough given a scalar zod schema converts to a top-level
  // `{ type: 'string' }` — the zod path's behavior is deliberately unchanged,
  // so the hand-off guard is the layer that must catch it.
  const fromZod = normalizeHostToolParameters(z.string());
  assert.equal(fromZod.type, 'string');
  const { tools, coerced } = guardHostToolSchemas([{ name: 'scalar_tool', parameters: fromZod }]);
  assert.deepEqual(coerced, [{ name: 'scalar_tool', reason: 'type=string' }]);
  assert.equal(tools[0].parameters.type, 'object');
  assert.deepEqual(tools[0].parameters.properties, {});
});

test('guard repairs a mixed list and reports name + reason per tool', () => {
  const okExecute = () => 'ok';
  const { tools, coerced } = guardHostToolSchemas([
    { name: 'ok', description: 'already object', parameters: { type: 'object', properties: { a: { type: 'string' } } }, execute: okExecute },
    { name: 'foo', description: 'bad type', parameters: { type: 'string' }, execute: () => 'foo' },
    { name: 'bar', description: 'empty schema', parameters: {}, execute: () => 'bar' },
    { name: 'baz', description: 'missing parameters' },
  ]);

  assert.deepEqual(coerced, [
    { name: 'foo', reason: 'type=string' },
    { name: 'bar', reason: 'missing type' },
    { name: 'baz', reason: 'missing type' },
  ]);
  assert.equal(tools[0].execute, okExecute, 'already-object tools must pass through untouched');
  assert.equal(tools[0].parameters.properties.a.type, 'string');
  assert.equal(tools[1].description, 'bad type', 'non-schema tool fields must survive the repair');
  assert.deepEqual(tools[2].parameters, { type: 'object', properties: {} });
  assert.deepEqual(tools[3].parameters, { type: 'object', properties: {} });
});

test('after the guard no tool has parameters.type !== object', () => {
  const { tools } = guardHostToolSchemas([
    { name: 'a', parameters: { type: 'string' } },
    { name: 'b', parameters: { type: 'array', items: { type: 'string' } } },
    { name: 'c', parameters: {} },
    { name: 'd' },
    { name: 'e', parameters: { type: 'object', properties: {} } },
    { name: 'f', parameters: null },
  ]);
  const offenders = tools.filter((tool) => tool.parameters?.type !== 'object');
  assert.deepEqual(offenders.map((tool) => tool.name), [], 'no non-object schema may survive the guard');
});

test('guard is idempotent: a second pass coerces nothing and keeps identities', () => {
  const first = guardHostToolSchemas([{ name: 'a', parameters: { type: 'string' } }]);
  const second = guardHostToolSchemas(first.tools);
  assert.deepEqual(second.coerced, []);
  assert.equal(second.tools[0], first.tools[0]);
});

test('guard warning carries the fixed tag and the tool names', () => {
  assert.equal(
    formatHostToolSchemaGuardWarning([
      { name: 'foo', reason: 'type=string' },
      { name: 'bar', reason: 'missing type' },
    ]),
    '[tool-schema-guard] coerced 2 tool schema(s): foo (type=string), bar (missing type)',
  );
});

test('wiring: both hostTools hand-off sites run the guard, old spread order is gone', () => {
  const source = fs.readFileSync(new URL('../src/main/libs/coworkRunner.ts', import.meta.url), 'utf8');
  const guardCalls = source.match(/guardHostToolSchemas\(/g) ?? [];
  assert.equal(guardCalls.length, 2, 'registry/pre-warm site and runTurn site must both guard');
  assert.match(source, /const hostToolsGuard = guardHostToolSchemas\(hostToolsBuilt\)/);
  assert.match(source, /const sendHostToolsGuard = guardHostToolSchemas\(turnOpts\?\.finalizing \? \[\] : hostTools\)/);
  assert.match(source, /coworkLog\('WARN', 'runDshSessionLocal', formatHostToolSchemaGuardWarning\(/);
  assert.equal(
    source.includes("{ type: 'object', properties: {}, ...record }"),
    false,
    'the buggy spread order must not remain in coworkRunner.ts',
  );
});
