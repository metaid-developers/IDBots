#!/usr/bin/env node
'use strict';

const { USAGE, parseCliArgs } = require('./lib/cli.js');
const { handleTradeRequest } = require('./lib/execution.js');

function writeStderr(message) {
  process.stderr.write(`${message}\n`);
}

async function main() {
  let parsed;
  try {
    parsed = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    writeStderr(error instanceof Error ? error.message : String(error));
    writeStderr(USAGE);
    process.exit(1);
  }

  if (parsed.help) {
    writeStderr('metabot-trade-metaidmarket: query and execute supported metaid.market actions with structured CLI arguments.');
    writeStderr(USAGE);
    process.exit(0);
  }

  try {
    const result = await handleTradeRequest({
      request: parsed,
      env: { ...process.env },
      fetchImpl: fetch,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    writeStderr(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

void main();
