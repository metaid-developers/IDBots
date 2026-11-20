#!/usr/bin/env node
/**
 * verify-claim — live verification + ledger claim (PRD §5.4 / §5.5-a).
 *
 * Re-reads the vault on-chain before anything else: the deposit must still
 * sit at its recorded outpoint, match the album triple, and carry >= 6
 * confirmations. Only then does the itemPath pre-check run and the row move
 * detected → claimed. A path conflict aborts and leaves the row detected
 * (PRD §11-1: stop and alert; never mint, never auto-refund).
 *
 * If no ledger row exists yet (the user transferred before the bot was
 * installed — PRD §4b fallback), this mode first runs one vault poll to detect
 * the deposit. `--dry-run` never writes.
 *
 * Usage:
 *   node cli/verify-claim.mjs --token-index 817 --claimant <mvc地址>
 *     [--claim-channel cli] [--claim-message-id <id>] [--outpoint txid:vout]
 *     [--dry-run] [--ledger <path>] [--user-data <dir>]
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
import { fetchVaultTokenRows, pollVault, MVP_CONFIRMATIONS } from './lib/vault-poll-lib.mjs';
import { albumFromConfig, createIndexReaders, verifyAndClaim } from './lib/swap-engine.mjs';

const HELP = `verify-claim — 验真 + 台账占位（PRD §5.4 / §5.5）

用法:
  node cli/verify-claim.mjs --token-index <n> --claimant <MVC地址> [选项]

选项:
  --collection <slug>       目标系列 slug（默认 metabot-avatar）
  --token-index <n>         旧 token 编号
  --claimant <MVC地址>      收货方 bot 钱包地址（claim 主键的一部分）
  --outpoint <txid:vout>    直接指定入账 outpoint（优先于 --token-index）
  --claim-channel <渠道>    claim 来源渠道（默认 cli）
  --claim-message-id <id>   claim 消息 id（可选）
  --dry-run                 只验真+双检并报告，不写台账
  --min-confirmations <n>   确认门槛（默认 1）
  --ledger <路径>           台账 sqlite 路径
  --user-data <目录>        IDBots userData 目录
  --help                    显示本帮助

退出码: 0 完成 | 1 拒绝/失败 | 2 需人工（如 ITEM_PATH_CONFLICT）| 3 待重试
`;

const MVC_ADDRESS = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/;

function resolveRow(ledger, collectionSlug, args) {
  if (args.outpoint) {
    const row = ledger.rowByOutpoint(args.outpoint);
    if (!row) throw new CliError('LEDGER_ROW_MISSING', `no ledger row for outpoint ${args.outpoint} — run vault-poll first`);
    return row;
  }
  const tokenIndex = Number(args['token-index']);
  if (!Number.isInteger(tokenIndex) || tokenIndex <= 0) {
    throw new CliError('BAD_ARGS', '--token-index must be a positive integer');
  }
  return ledger.activeRowByToken(collectionSlug, tokenIndex) ?? ledger.latestRowByToken(collectionSlug, tokenIndex);
}

async function main(argv) {
  const args = parseCliArgs(argv, {
    values: ['collection', 'token-index', 'claimant', 'outpoint', 'claim-channel', 'claim-message-id', 'min-confirmations', 'ledger', 'user-data'],
    booleans: ['dry-run'],
  });
  if (!args.claimant) throw new CliError('BAD_ARGS', '--claimant is required (the recipient bot MVC address)');
  if (!MVC_ADDRESS.test(args.claimant)) {
    throw new CliError('BAD_ARGS', `--claimant is not an MVC base58 address: ${args.claimant}`);
  }
  const userDataPath = resolveUserData(args);
  const config = resolvedPilotConfig(userDataPath, args.collection || null);
  const album = albumFromConfig(config, { collectionSlug: args.collection || null });
  if (!config.vaultAddress) throw new CliError('VAULT_ADDRESS_MISSING', 'pilot config has no vault address');

  const minConfirmations = args['min-confirmations'] != null ? Number(args['min-confirmations']) : MVP_CONFIRMATIONS;
  const readers = createIndexReaders();
  const ledgerPath = resolveLedgerPath(userDataPath, args);
  const ledger = openLedger(ledgerPath);

  try {
    let row = resolveRow(ledger, album.collectionSlug, args);
    let detected = false;
    if (!row && !args['dry-run']) {
      // PRD §4b fallback: deposit first, install later. One poll records it.
      await pollVault({
        ledger,
        album,
        vaultAddress: config.vaultAddress,
        minConfirmations,
        confirmationsResolver: (txid) => readers.fetchConfirmations(txid),
      });
      row = resolveRow(ledger, album.collectionSlug, args);
      detected = Boolean(row);
    }
    if (!row) {
      throw new CliError(
        'LEDGER_ROW_MISSING',
        args['dry-run']
          ? 'no ledger row for this deposit; run vault-poll first (dry-run never writes)'
          : `deposit not found in the vault (or still under ${minConfirmations} confirmation(s))`,
      );
    }

    const result = await verifyAndClaim({
      ledger,
      album,
      row,
      claimantAddress: args.claimant,
      claimChannel: args['claim-channel'] || 'cli',
      claimMessageId: args['claim-message-id'] || null,
      dryRun: Boolean(args['dry-run']),
      minConfirmations,
      deps: {
        fetchVaultRows: () => fetchVaultTokenRows({ address: config.vaultAddress }),
        fetchConfirmations: (txid) => readers.fetchConfirmations(txid),
        probeItemPath: (input) => readers.probeItemPath(input),
      },
    });

    return {
      ok: true,
      mode: 'verify-claim',
      dryRun: Boolean(args['dry-run']),
      ledgerPath,
      detectedThisRun: detected,
      vaultAddress: config.vaultAddress,
      ...result,
    };
  } finally {
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
