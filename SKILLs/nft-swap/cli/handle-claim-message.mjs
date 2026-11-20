#!/usr/bin/env node
/**
 * handle-claim-message — process an incoming SWAP_CLAIM_V1 wire message
 * (Contract C5.1) for any registered series in SERIES_REGISTRY.
 *
 * Usage:
 *   node cli/handle-claim-message.mjs --message '<idbots-swap-v1 message>'
 *     [--message-file <path>] [--broadcast] [--cover <metafile://...>]
 *     [--ledger <path>] [--user-data <dir>] [--min-confirmations 1]
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  CliError,
  emitError,
  openLedger,
  parseCliArgs,
  resolveLedgerPath,
  resolveUserData,
  resolvedPilotConfig,
  wantsHelp,
} from './lib/cli-common.mjs';
import { createCoverResolver, SWAP_COVER_OUT_DEFAULT } from './lib/cover-bridge.mjs';
import { defaultCatalogFile } from './lib/cover-core.mjs';
import { createHostAdapter } from './lib/host-adapter.mjs';
import { createIndexReaders, waitForTransferStable } from './lib/swap-engine.mjs';
import { MVP_CONFIRMATIONS, fetchVaultTokenRows } from './lib/vault-poll-lib.mjs';
import { handleClaimMessage } from './lib/claim-handler.mjs';

const HELP = `handle-claim-message — 处理 SWAP_CLAIM_V1 自动置换请求（v0.5.0）

用法:
  node cli/handle-claim-message.mjs (--message <文本> | --message-file <路径>) [选项]

选项:
  --message <文本>               包含 idbots-swap-v1 fenced JSON 的消息文本
  --message-file <路径>          从文件读取消息文本
  --sender-global-metaid <id>    来信者的 globalMetaId（校验与 recipientGlobalMetaId 一致）
  --sender-address <addr>        来信者的 MVC 地址（校验与 recipientAddress 一致）
  --broadcast                    真实铸造并发送（默认 dry-run）
  --dry-run                      只检查金库与确认数，不广播
  --min-confirmations <n>        确认门槛（默认 1）
  --cover <metafile://...>       显式封面覆盖（可选）
  --cover-catalog <路径>         attach-cover 快照目录
  --cover-out <目录>             取图 journal 目录
  --metabot-id <id>              铸币 bot id（默认取 pilot 配置）
  --ledger <路径>                台账 sqlite 路径
  --user-data <目录>             IDBots userData 目录
  --help                         显示本帮助

退出码: 0 完成 | 1 拒绝/失败 | 3 等待 1 确认 (pending_1_conf)
`;

async function main(argv) {
  const args = parseCliArgs(argv, {
    values: [
      'message',
      'message-file',
      'sender-global-metaid',
      'sender-address',
      'min-confirmations',
      'cover',
      'cover-catalog',
      'cover-out',
      'metabot-id',
      'ledger',
      'user-data',
    ],
    booleans: ['broadcast', 'dry-run'],
  });
  if (args.broadcast && args['dry-run']) {
    throw new CliError('BAD_ARGS', '--broadcast and --dry-run are mutually exclusive');
  }
  const rawMessage = args['message-file']
    ? readFileSync(path.resolve(args['message-file']), 'utf8')
    : args.message;
  if (!rawMessage) {
    throw new CliError('BAD_ARGS', '--message or --message-file is required');
  }

  const userDataPath = resolveUserData(args);
  const config = resolvedPilotConfig(userDataPath);
  const ledgerPath = resolveLedgerPath(userDataPath, args);
  const ledger = openLedger(ledgerPath);
  const readers = createIndexReaders();
  const broadcast = Boolean(args.broadcast);
  const minConfirmations = args['min-confirmations'] != null ? Number(args['min-confirmations']) : MVP_CONFIRMATIONS;

  let host = null;
  try {
    if (broadcast) {
      const metabotId = Number(args['metabot-id'] ?? config.metabotId);
      if (!Number.isInteger(metabotId) || metabotId <= 0) {
        throw new CliError('METABOT_ID_MISSING', 'pilot config has no metabotId; pass --metabot-id');
      }
      host = await createHostAdapter({ userDataPath, metabotId });
    }

    const vaultAddress = config.vaultAddress;
    const deps = {
      fetchConfirmations: (txid) => readers.fetchConfirmations(txid),
      fetchDepositSenderAddresses: (txid) => readers.fetchDepositSenderAddresses(txid),
      probeItemPath: (input) => readers.probeItemPath(input),
      fetchVaultRows: () => fetchVaultTokenRows({ address: vaultAddress }),
      fetchCollectionInfo: (name) => readers.fetchCollectionInfo(name),
      fetchItemVerify: (pinId) => readers.fetchItemVerify(pinId),
      waitTransferStable: ({ pinId, minCount }) =>
        waitForTransferStable({ pinId, fetchItemInfo: readers.fetchItemInfo, minCount }),
      resolveCover: createCoverResolver({
        vaultAddress,
        metabotId: () => {
          const id = Number(args['metabot-id'] ?? config.metabotId);
          if (!Number.isInteger(id) || id <= 0) {
            throw new CliError('METABOT_ID_MISSING', 'pilot config has no metabotId; pass --metabot-id');
          }
          return id;
        },
        catalogFile: args['cover-catalog'] ? path.resolve(args['cover-catalog']) : defaultCatalogFile(process.cwd()),
        outDir: args['cover-out'] ? path.resolve(args['cover-out']) : SWAP_COVER_OUT_DEFAULT,
      }),
      ...(host
        ? {
            estimateMintPins: (input) => host.estimateMintPins(input),
            mintItemPin: (input) => host.mintItemPin(input),
            writeItemDesc: (input) => host.writeItemDesc(input),
            waitItemInfo: (input) => host.waitItemInfo(input),
            transferItem: (input) => host.transferItem(input),
          }
        : {}),
    };

    const result = await handleClaimMessage({
      rawMessage,
      ledger,
      deps,
      vaultAddressOverride: vaultAddress,
      broadcast,
      cover: args.cover || null,
      minConfirmations,
      senderGlobalMetaId: args['sender-global-metaid'] || null,
      senderAddress: args['sender-address'] || null,
    });
    if (result.pending) process.exitCode = 3;
    return {
      mode: 'handle-claim-message',
      ledgerPath,
      vaultAddress,
      ...result,
    };
  } finally {
    host?.close();
    ledger.close();
  }
}

if (wantsHelp(process.argv.slice(2))) {
  process.stdout.write(HELP);
} else {
  main(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    (error) => emitError(error),
  );
}
