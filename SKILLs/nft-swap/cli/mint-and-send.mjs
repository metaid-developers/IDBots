#!/usr/bin/env node
/**
 * mint-and-send — mint the same-numbered MRC-721 item and deliver it
 * (PRD §5.5-§5.7). Resume-aware: the commmand can be re-run after a crash at
 * any step and will continue from the recorded pinId — it NEVER re-mints.
 *
 * Default is a dry-run plan. Real broadcasting requires --broadcast, which
 * routes every write through the app's services and host confirmation gates
 * (issuer mnemonic stays inside the host signing worker; nothing here reads
 * or prints it).
 *
 * Usage:
 *   node cli/mint-and-send.mjs --token-index 817 [--recipient <mvc地址>]
 *     [--cover metafile://…] [--broadcast] [--fee-ceiling 5000]
 *     [--item-info-timeout-ms 360000] [--ledger <path>] [--user-data <dir>]
 */

import { ISSUER_CONFIG } from './lib/issuer-config.mjs';
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
import { createHostAdapter } from './lib/host-adapter.mjs';
import { fetchVaultTokenRows } from './lib/vault-poll-lib.mjs';
import { albumFromConfig, createIndexReaders, mintAndSend, waitForTransferStable } from './lib/swap-engine.mjs';

const HELP = `mint-and-send — 按需铸造 + 发货（PRD §5.5–§5.7，崩溃恢复安全）

用法:
  node cli/mint-and-send.mjs --token-index <n> [选项]

选项:
  --token-index <n>              旧 token 编号（必须已在台账 claimed 或更后）
  --recipient <MVC地址>          收货地址（台账已有 claimant 时可省）
  --cover <metafile://…>         封面（可选；只在首次 mint 时写入）
  --broadcast                    真实广播（默认 dry-run，绝不发交易）
  --fee-ceiling <sats>           单枚费用上限（默认 5000，COST-BUDGET §5-1）
  --item-info-timeout-ms <ms>    等待 item/info 索引的超时（默认 360000 ≥ 5 分钟）
  --metabot-id <id>              铸币 bot id（默认取 pilot 配置）
  --ledger <路径>                台账 sqlite 路径
  --user-data <目录>             IDBots userData 目录
  --help                         显示本帮助

可恢复状态: claimed → mint_pending → minted → send_pending → sent
  * mint_pending 会从已记录的 mint pinId 续作，禁止重铸；
  * item/info 缺 output/outputValue 视为索引欠账，保持 mint_pending 待重试；
  * creatorMinted / createAddress 不符则停机告警，不自动改状态。

退出码: 0 完成/计划 | 1 拒绝/失败 | 2 需人工 | 3 待重试（索引/稳定性未到）
`;

async function main(argv) {
  const args = parseCliArgs(argv, {
    values: ['token-index', 'recipient', 'cover', 'fee-ceiling', 'item-info-timeout-ms', 'metabot-id', 'ledger', 'user-data'],
    booleans: ['broadcast', 'dry-run'],
  });
  if (args.broadcast && args['dry-run']) {
    throw new CliError('BAD_ARGS', '--broadcast and --dry-run are mutually exclusive');
  }
  const tokenIndex = Number(args['token-index']);
  if (!Number.isInteger(tokenIndex) || tokenIndex <= 0) {
    throw new CliError('BAD_ARGS', '--token-index must be a positive integer');
  }
  const userDataPath = resolveUserData(args);
  const config = resolvedPilotConfig(userDataPath);
  const album = albumFromConfig(config);
  const ledgerPath = resolveLedgerPath(userDataPath, args);
  const ledger = openLedger(ledgerPath);
  const readers = createIndexReaders();
  const broadcast = Boolean(args.broadcast);

  let host = null;
  try {
    const row = ledger.activeRowByToken(album.genesis, tokenIndex) ?? ledger.latestRowByToken(album.genesis, tokenIndex);
    if (!row) {
      throw new CliError(
        'LEDGER_ROW_MISSING',
        `no ledger row for tokenIndex ${tokenIndex} — run vault-poll + verify-claim first`,
      );
    }

    if (broadcast) {
      const metabotId = Number(args['metabot-id'] ?? config.metabotId);
      if (!Number.isInteger(metabotId) || metabotId <= 0) {
        throw new CliError('METABOT_ID_MISSING', 'pilot config has no metabotId; pass --metabot-id');
      }
      host = await createHostAdapter({ userDataPath, metabotId });
    }

    const deps = {
      probeItemPath: (input) => readers.probeItemPath(input),
      fetchVaultRows: () => fetchVaultTokenRows({ address: config.vaultAddress }),
      fetchCollectionInfo: (name) => readers.fetchCollectionInfo(name),
      fetchItemVerify: (pinId) => readers.fetchItemVerify(pinId),
      waitTransferStable: ({ pinId, minCount }) =>
        waitForTransferStable({ pinId, fetchItemInfo: readers.fetchItemInfo, minCount }),
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

    const feeCeilingSats = args['fee-ceiling'] != null ? Number(args['fee-ceiling']) : album.perSwapFeeCeilingSats;
    if (!Number.isFinite(feeCeilingSats) || feeCeilingSats <= 0) {
      throw new CliError('BAD_ARGS', '--fee-ceiling must be a positive number of sats');
    }
    const itemInfoTimeoutMs =
      args['item-info-timeout-ms'] != null ? Number(args['item-info-timeout-ms']) : 360_000;

    const result = await mintAndSend({
      ledger,
      album,
      row,
      deps,
      recipientAddress: args.recipient || null,
      cover: args.cover || null,
      broadcast,
      feeCeilingSats,
      itemInfoTimeoutMs,
    });

    return {
      ok: result.ok,
      mode: 'mint-and-send',
      broadcast,
      ledgerPath,
      vaultAddress: config.vaultAddress,
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
    (result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result?.pending) process.exitCode = 3;
    },
    (error) => emitError(error),
  );
}
