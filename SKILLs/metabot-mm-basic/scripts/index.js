#!/usr/bin/env node
'use strict';

const { parseArgs } = require('util');
const { normalizePayload } = require('./lib/payload');

const { values } = parseArgs({ options: { payload: { type: 'string' } } });

if (!values.payload) {
  process.stderr.write('Error: --payload is required.\n');
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(values.payload);
} catch (error) {
  process.stderr.write(`Error: --payload must be valid JSON. ${error.message}\n`);
  process.exit(1);
}

try {
  normalizePayload(payload);
} catch (error) {
  const message = error && error.message ? error.message : 'Invalid payload.';
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ mode: 'stub', ok: true })}\n`);
