#!/usr/bin/env node
'use strict';

const { parseArgs } = require('util');

const { values } = parseArgs({ options: { payload: { type: 'string' } } });

if (!values.payload) {
  process.stderr.write('Error: --payload is required.\n');
  process.exit(1);
}

process.stdout.write(`${JSON.stringify({ mode: 'stub', ok: true })}\n`);
