#!/usr/bin/env node
'use strict';

const { handleTradeRequest } = require('./lib/execution.js');

function writeStderr(message) {
  process.stderr.write(`${message}\n`);
}

async function main() {
  const input = process.argv.slice(2).join(' ').trim();
  if (!input) {
    writeStderr('Usage: node index.js "<trade request>"');
    process.exit(1);
  }

  try {
    const result = await handleTradeRequest({
      input,
      env: process.env,
      fetchImpl: fetch,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    writeStderr(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

void main();
