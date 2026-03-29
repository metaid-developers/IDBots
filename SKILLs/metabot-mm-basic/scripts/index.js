#!/usr/bin/env node
'use strict';

const { parseArgs } = require('util');
const { normalizePayload } = require('./lib/payload');
const { handleMmRequest } = require('./lib/execution');

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

let normalized;
try {
  normalized = normalizePayload(payload);
} catch (error) {
  const message = error && error.message ? error.message : 'Invalid payload.';
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

(async () => {
  try {
    const result = await handleMmRequest(normalized, {
      env: process.env,
      fetchImpl: fetch,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error && error.message ? error.message : 'Execution failed.';
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  }
})();
