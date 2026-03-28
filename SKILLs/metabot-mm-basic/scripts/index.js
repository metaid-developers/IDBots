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

normalizePayload(payload);
process.stdout.write(`${JSON.stringify({ mode: 'stub', ok: true })}\n`);
