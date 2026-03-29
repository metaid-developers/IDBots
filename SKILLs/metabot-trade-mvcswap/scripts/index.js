#!/usr/bin/env node
'use strict';

const { USAGE, parseTradeCliArgs } = require('./lib/cli.js');
const { handleTradeRequest } = require('./lib/execution.js');

function writeStderr(message) {
  process.stderr.write(`${message}\n`);
}

async function main() {
  let parsed;

  try {
    parsed = parseTradeCliArgs(process.argv.slice(2));
  } catch (error) {
    writeStderr(error instanceof Error ? error.message : String(error));
    writeStderr(USAGE);
    process.exit(1);
  }

  if (parsed.help) {
    writeStderr('metabot-trade-mvcswap: Execute mvcswap trades using structured CLI arguments.');
    writeStderr(USAGE);
    writeStderr('');
    writeStderr('Options:');
    writeStderr('  --action <quote|preview|execute>');
    writeStderr('  --direction <space_to_token|token_to_space>');
    writeStderr('  --amount-in <decimal>');
    writeStderr('  --token-symbol <symbol>');
    writeStderr('  --slippage-percent <decimal>   optional, default: 1');
    writeStderr('  --metabot-id <int>             optional; overrides IDBOTS_METABOT_ID (Cowork injects env)');
    writeStderr('  -h, --help                     show this message');
    process.exit(0);
  }

  try {
    const { metabotIdCli, ...tradeRequest } = parsed;
    const env = { ...process.env };
    if (metabotIdCli != null) {
      env.IDBOTS_METABOT_ID = String(metabotIdCli);
    }
    const result = await handleTradeRequest({
      request: tradeRequest,
      env,
      fetchImpl: fetch,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    writeStderr(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

void main();
