#!/usr/bin/env node
/**
 * vault-poll — vault inspection / deposit detection (PRD §5 step 4).
 *
 * Fetches the vault address's MetaContract NFT UTXO list with flag-cursor
 * full-page pagination, filters locally on the album triple (genesis +
 * codeHash + tokenIndex range, sensibleId fallback), and records matured
 * deposits (>= 6 confirmations) into the swap ledger.
 *
 * `--dry-run` performs the exact same fetch/filter and prints what it WOULD
 * record, without creating or touching the ledger.
 *
 * Usage:
 *   node cli/vault-poll.mjs [--dry-run] [--address <vault>] [--ledger <path>]
 *     [--user-data <dir>] [--min-confirmations 6] [--chain-tip <height>]
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
import { classifyVaultRows, fetchVaultTokenRows, pollVault, MVP_CONFIRMATIONS } from './lib/vault-poll-lib.mjs';
import { createIndexReaders } from './lib/swap-engine.mjs';

const HELP = `vault-poll — 金库巡检 / 入账识别（PRD §5.4）

用法:
  node cli/vault-poll.mjs [选项]

选项:
  --dry-run                 只拉取+过滤+报告，不写台账（台账文件也不会被创建）
  --address <mvc地址>       金库地址（默认取 pilot 配置，回退 issuer-config 常量）
  --ledger <路径>           台账 sqlite 路径（默认 <user-data>/nft-swap-ledger.sqlite）
  --user-data <目录>        IDBots userData 目录（默认 macOS 标准路径）
  --min-confirmations <n>   入账确认门槛（默认 6，PRD §5.4c）
  --chain-tip <高度>        链尖高度（不带时以 manapi tx/status 的逐笔确认数为准）
  --help                    显示本帮助

退出码: 0 完成 | 1 拒绝/失败 | 2 需人工 | 3 待重试
`;

const albumOf = (config) => ({
  genesis: config.genesis ?? ISSUER_CONFIG.genesis,
  codeHash: config.codeHash ?? ISSUER_CONFIG.codeHash,
  sensibleId: config.sensibleId ?? ISSUER_CONFIG.sensibleId,
  tokenSupply: config.tokenSupply ?? ISSUER_CONFIG.tokenSupply,
});

async function main(argv) {
  const args = parseCliArgs(argv, {
    values: ['address', 'ledger', 'user-data', 'min-confirmations', 'chain-tip'],
    booleans: ['dry-run'],
  });
  const userDataPath = resolveUserData(args);
  const minConfirmations = args['min-confirmations'] != null ? Number(args['min-confirmations']) : MVP_CONFIRMATIONS;
  if (!Number.isInteger(minConfirmations) || minConfirmations < 0) {
    throw new CliError('BAD_ARGS', '--min-confirmations must be a non-negative integer');
  }

  let config = null;
  try {
    config = resolvedPilotConfig(userDataPath);
  } catch (error) {
    if (!args.address) throw error;
  }
  const album = albumOf(config ?? {});
  const vaultAddress = args.address || config?.vaultAddress || ISSUER_CONFIG.vaultAddress;
  if (!vaultAddress) throw new CliError('VAULT_ADDRESS_MISSING', 'no vault address: pass --address or complete M0');

  const readers = createIndexReaders();
  const chainTipHeight = args['chain-tip'] != null ? Number(args['chain-tip']) : undefined;

  if (args['dry-run']) {
    const rows = await fetchVaultTokenRows({ address: vaultAddress });
    const { matched, foreign } = classifyVaultRows(rows, album);
    const withConfirmations = [];
    for (const row of matched) {
      const confirmations = await readers.fetchConfirmations(row.txid);
      withConfirmations.push({
        outpoint: `${row.txid}:${row.outIndex}`,
        tokenIndex: row.tokenIndex,
        height: row.height,
        confirmations,
        matured: confirmations >= minConfirmations,
      });
    }
    return {
      ok: true,
      mode: 'vault-poll',
      dryRun: true,
      vaultAddress,
      album: { genesis: album.genesis, codeHash: album.codeHash, tokenSupply: album.tokenSupply },
      scanned: rows.length,
      matched: matched.length,
      foreign: foreign.length,
      minConfirmations,
      deposits: withConfirmations,
      wouldRecord: withConfirmations.filter((d) => d.matured).length,
    };
  }

  const ledger = openLedger(resolveLedgerPath(userDataPath, args));
  try {
    const result = await pollVault({
      ledger,
      album,
      vaultAddress,
      minConfirmations,
      chainTipHeight,
      confirmationsResolver: (txid) => readers.fetchConfirmations(txid),
    });
    return {
      ok: true,
      mode: 'vault-poll',
      dryRun: false,
      vaultAddress,
      minConfirmations,
      scanned: result.scanned,
      newDeposits: result.newDeposits.map((row) => ({
        ledgerId: row.ledgerId,
        tokenIndex: row.tokenIndex,
        outpoint: `${row.txid}:${row.outIndex}`,
      })),
      matured: result.matured.length,
      foreign: result.foreign.map((row) => ({ ledgerId: row.ledgerId, genesis: row.genesis, tokenIndex: row.tokenIndex })),
      unconfirmed: result.unconfirmed.map((row) => ({
        tokenIndex: row.tokenIndex,
        outpoint: `${row.txid}:${row.outIndex}`,
        confirmations: row.confirmations,
      })),
      ledgerPath: resolveLedgerPath(userDataPath, args),
    };
  } finally {
    ledger.close();
  }
}

if (wantsHelp(process.argv.slice(2))) {
  process.stdout.write(HELP);
} else {
  main(process.argv.slice(2)).then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    },
    (error) => emitError(error),
  );
}
