#!/usr/bin/env node
/**
 * burn-batch — one-tx-per-token burn of already-delivered legacy tokens to
 * the black hole (PRD §5.8, prereview #7/#10).
 *
 * Preconditions enforced by the engine:
 *  - only `sent` rows with a stable transferCount are candidates;
 *  - the token must still sit at its recorded vault outpoint;
 *  - the minted item must already carry a non-empty cover (item/info read,
 *    cover-loss fix 2026-11-19): a cover-less candidate is refused with
 *    COVER_MISSING_BEFORE_BURN and its roster — burning would destroy the
 *    last chance to fetch the legacy artwork. Backfill/attach covers first.
 *  - broadcasting needs BOTH --broadcast and --confirm-owner (owner sign-off,
 *    PRD §9) — a dry-run plan is the default.
 *
 * Crash recovery: a `burn_pending` row of this batch with no burn_txid is
 * resumed only when its token is still in the vault. If the token is gone and
 * no txid was recorded, the batch refuses to re-broadcast and reports the row
 * for manual txid reconciliation.
 *
 * Usage:
 *   node cli/burn-batch.mjs [--batch-id burn-20261117] [--limit 20]
 *     [--broadcast --confirm-owner] [--settle-ms 3000]
 *     [--ledger <path>] [--user-data <dir>]
 */

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
import { albumFromConfig, createIndexReaders, runBurnBatch } from './lib/swap-engine.mjs';

const HELP = `burn-batch — 逐枚单发销毁旧 token（PRD §5.8）

用法:
  node cli/burn-batch.mjs [--batch-id <id>] [选项]

选项:
  --batch-id <id>       批次审计键（广播时必填；dry-run 省略时自动生成一个建议值）
  --limit <n>           本批最多处理枚数（默认 20）
  --broadcast           真实广播（默认 dry-run）
  --confirm-owner       owner 亲点确认（与 --broadcast 同时给出才允许发交易，PRD §9）
  --settle-ms <ms>      逐笔之间的 UTXO 沉降间隔（默认 3000）
  --metabot-id <id>     签名 bot id（默认取 pilot 配置）
  --ledger <路径>       台账 sqlite 路径
  --user-data <目录>    IDBots userData 目录
  --help                显示本帮助

待烧名单口径（预审 #7/#10）: 仅 state=sent 且 transferCount 已稳定、且旧
token 仍在金库原 outpoint、且新条目 item/info 的 cover 非空的记录
（cover-loss 修复 2026-11-19：缺图条目拒销并报
COVER_MISSING_BEFORE_BURN 名单，先补图再销）。中航态（detected/claimed/
mint_pending/minted/send_pending）永不成批。

退出码: 0 完成/计划 | 1 拒绝/失败 | 2 需人工（缺 owner 确认/需对账）
`;

function suggestedBatchId(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `burn-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function main(argv) {
  const args = parseCliArgs(argv, {
    values: ['batch-id', 'limit', 'settle-ms', 'metabot-id', 'ledger', 'user-data'],
    booleans: ['broadcast', 'confirm-owner'],
  });
  const userDataPath = resolveUserData(args);
  const config = resolvedPilotConfig(userDataPath);
  const album = albumFromConfig(config);
  const broadcast = Boolean(args.broadcast);
  const batchId = args['batch-id'] || (broadcast ? null : suggestedBatchId());
  if (!batchId) {
    throw new CliError('BATCH_ID_MISSING', 'broadcast requires an explicit --batch-id (the batch audit key)');
  }
  const limit = args.limit != null ? Number(args.limit) : 20;
  if (!Number.isInteger(limit) || limit <= 0) throw new CliError('BAD_ARGS', '--limit must be a positive integer');
  const settleMs = args['settle-ms'] != null ? Number(args['settle-ms']) : 3_000;

  const ledgerPath = resolveLedgerPath(userDataPath, args);
  const ledger = openLedger(ledgerPath);
  const readers = createIndexReaders();
  let host = null;
  try {
    if (broadcast) {
      const metabotId = Number(args['metabot-id'] ?? config.metabotId);
      if (!Number.isInteger(metabotId) || metabotId <= 0) {
        throw new CliError('METABOT_ID_MISSING', 'pilot config has no metabotId; pass --metabot-id');
      }
      host = await createHostAdapter({ userDataPath, metabotId });
    }

    const deps = {
      fetchVaultRows: () => fetchVaultTokenRows({ address: config.vaultAddress }),
      // Cover gate (cover-loss fix 2026-11-19): the engine reads each
      // candidate's item/info cover before allowing it into a burn batch.
      fetchItemInfo: (pinId) => readers.fetchItemInfo(pinId),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      ...(host ? { transferLegacyToken: (input) => host.transferLegacyToken(input) } : {}),
    };

    const result = await runBurnBatch({
      ledger,
      album,
      batchId,
      deps,
      broadcast,
      ownerConfirmed: Boolean(args['confirm-owner']),
      limit,
      settleMs,
    });

    return {
      mode: 'burn-batch',
      ledgerPath,
      broadcast,
      suggestedBatchId: broadcast ? null : batchId,
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
