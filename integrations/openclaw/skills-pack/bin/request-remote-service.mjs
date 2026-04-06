#!/usr/bin/env node

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

function toSafeString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function parseCliInput(argv) {
  const options = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const stripped = token.slice(2);
    const [rawKey, inlineValue] = stripped.split('=', 2);
    const nextToken = argv[index + 1];
    if (inlineValue !== undefined) {
      options[rawKey] = inlineValue;
      continue;
    }
    if (nextToken && !nextToken.startsWith('--')) {
      options[rawKey] = nextToken;
      index += 1;
      continue;
    }
    options[rawKey] = true;
  }

  return { options, positionals };
}

function getOptionString(options, key, fallback = '') {
  const value = options[key];
  if (typeof value === 'string') return value.trim();
  return fallback;
}

function getOptionBoolean(options, key) {
  return options[key] === true;
}

function runMetabotCli(repoRoot, cliScript, args) {
  const result = spawnSync(process.execPath, [cliScript, ...args], {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(toSafeString(result.stderr) || `metabot-cli ${args[0]} failed`);
  }
  return JSON.parse(String(result.stdout).trim());
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, '..', '..', '..', '..');
  const cliScript = path.resolve(repoRoot, 'scripts', 'metabot-cli.mjs');
  const runtimePath = path.resolve(
    repoRoot,
    'dist-electron',
    'metabotRuntime',
    'openclaw',
    'openclawRequesterAdapter.js',
  );
  const pendingRequestsFile = process.env.OPENCLAW_PENDING_REQUESTS_FILE
    || path.resolve(scriptDir, '..', 'state', 'pending-requests.json');
  const parsed = parseCliInput(process.argv.slice(2));
  const runtime = await import(pathToFileURL(runtimePath).href);
  const bridge = runtime.createOpenClawRequesterBridge({
    pendingRequestsFile,
    async listServices() {
      return runMetabotCli(repoRoot, cliScript, ['list-services']);
    },
    async requestService(input) {
      const cliArgs = [
        'request-service',
        '--metabot-id', String(input.metabotId),
        '--service-pin-id', input.servicePinId,
        '--request-id', input.requestId,
        '--requester-session-id', input.requesterSessionId,
        '--requester-global-metaid', input.requesterGlobalMetaId,
        '--user-task', input.userTask,
        '--task-context', input.taskContext,
      ];

      if (input.requesterConversationId) {
        cliArgs.push('--requester-conversation-id', input.requesterConversationId);
      }
      if (input.price) {
        cliArgs.push('--price', input.price);
      }
      if (input.currency) {
        cliArgs.push('--currency', input.currency);
      }
      if (input.paymentTxid) {
        cliArgs.push('--payment-txid', input.paymentTxid);
      }
      if (input.paymentChain) {
        cliArgs.push('--payment-chain', input.paymentChain);
      }
      if (input.orderReferenceId) {
        cliArgs.push('--order-reference-id', input.orderReferenceId);
      }

      return runMetabotCli(repoRoot, cliScript, cliArgs);
    },
  });

  if (getOptionBoolean(parsed.options, 'discover')) {
    const payload = await bridge.discoverRemoteServices();
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  if (getOptionBoolean(parsed.options, 'submit')) {
    const payload = await bridge.submitRemoteRequest({
      metabotId: Number(getOptionString(parsed.options, 'metabot-id', '0')),
      servicePinId: getOptionString(parsed.options, 'service-pin-id'),
      requestId: getOptionString(parsed.options, 'request-id'),
      requesterSessionId: getOptionString(parsed.options, 'requester-session-id'),
      requesterConversationId: getOptionString(parsed.options, 'requester-conversation-id') || null,
      requesterGlobalMetaId: getOptionString(parsed.options, 'requester-global-metaid'),
      targetSessionId: getOptionString(parsed.options, 'target-session-id'),
      userTask: getOptionString(parsed.options, 'user-task'),
      taskContext: getOptionString(parsed.options, 'task-context'),
      confirm: getOptionBoolean(parsed.options, 'confirm'),
      price: getOptionString(parsed.options, 'price') || undefined,
      currency: getOptionString(parsed.options, 'currency') || undefined,
      paymentTxid: getOptionString(parsed.options, 'payment-txid') || null,
      paymentChain: getOptionString(parsed.options, 'payment-chain') || null,
      orderReferenceId: getOptionString(parsed.options, 'order-reference-id') || null,
    });
    process.stdout.write(`${JSON.stringify({
      request_write: payload.request_write,
      provider_wakeup: payload.provider_wakeup,
    }, null, 2)}\n`);
    return;
  }

  throw new Error('request-remote-service requires either --discover or --submit');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
