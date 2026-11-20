/**
 * Shared CLI plumbing for the nft-swap engine modes: argument parsing with
 * --help, pilot-config lookup, ledger path, JSON output, and exit codes.
 *
 * Exit codes (stable, documented in SKILL.md):
 *   0  done (including dry-runs)
 *   1  refused / failed (structured JSON on stdout carries the code)
 *   2  blocked on a human gate (owner sign-off missing, conflict, anomaly)
 *   3  pending — retry later (index lag, transfer not yet stable)
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ISSUER_CONFIG } from './issuer-config.mjs';
import { albumFromSeries, resolveSeries } from './series-registry.mjs';
import { SwapLedger } from './swap-ledger.mjs';
import { SwapEngineError } from './swap-engine.mjs';

export const DEFAULT_USER_DATA = path.join(process.env.HOME || '', 'Library', 'Application Support', 'IDBots');
export const APP_DB_FILENAME = 'idbots.sqlite';
export const PILOT_CONFIG_KEY = 'nft_swap_pilot_config';
export const LEDGER_FILENAME = 'nft-swap-ledger.sqlite';

export class CliError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.detail = detail;
  }
}

export function wantsHelp(argv) {
  return argv.includes('--help') || argv.includes('-h');
}

/**
 * Parse `--flag value` and `--flag` pairs. Unknown options are refused (a
 * typo like --broacast must never silently run a dry-run).
 */
export function parseCliArgs(argv, { values = [], booleans = [] } = {}) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const name = token.slice(2);
    if (values.includes(name)) {
      const value = argv[i + 1];
      if (value == null || value.startsWith('--')) {
        throw new CliError('BAD_ARGS', `--${name} requires a value`);
      }
      args[name] = value;
      i += 1;
    } else if (booleans.includes(name)) {
      args[name] = true;
    } else {
      throw new CliError('BAD_ARGS', `unknown option --${name}`);
    }
  }
  return args;
}

export function resolveUserData(args) {
  return args['user-data'] || DEFAULT_USER_DATA;
}

export function resolveLedgerPath(userDataPath, args) {
  return args.ledger || path.join(userDataPath, LEDGER_FILENAME);
}

/**
 * Read the M0 pilot config (collection/vault/metabot ids) from the app DB
 * WITHOUT touching the app build. Read-only; the row never contains key
 * material (addresses and constants only).
 */
export function readPilotConfig(userDataPath) {
  const dbPath = path.join(userDataPath, APP_DB_FILENAME);
  if (!existsSync(dbPath)) {
    throw new CliError(
      'PILOT_CONFIG_MISSING',
      `app database not found at ${dbPath} — run restore-issuer (M0) first, or pass --user-data`,
    );
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare('SELECT value FROM cowork_config WHERE key = ?').get(PILOT_CONFIG_KEY);
    if (!row?.value) {
      throw new CliError(
        'PILOT_CONFIG_MISSING',
        `cowork_config key ${PILOT_CONFIG_KEY} is absent — M0 restore-issuer has not run against this userData`,
      );
    }
    return JSON.parse(String(row.value));
  } finally {
    db.close();
  }
}

/** Config with series-registry + issuer-config fallbacks for the constants the engine needs. */
export function resolvedPilotConfig(userDataPath, collectionSlug = null) {
  const stored = readPilotConfig(userDataPath);
  const series = collectionSlug
    ? resolveSeries({ collectionSlug })
    : resolveSeries({ genesis: stored.genesis, codeHash: stored.codeHash });
  if (collectionSlug && !series) {
    throw new CliError('UNKNOWN_COLLECTION_SLUG', `unknown collection slug in SERIES_REGISTRY: ${collectionSlug}`);
  }
  const base = series
    ? albumFromSeries(series, {
        issuerAddress: stored.issuerAddress || series.issuerAddress,
        vaultAddress: stored.vaultAddress || series.vaultAddress,
        burnAddress: stored.burnAddress || series.burnAddress,
        perSwapFeeCeilingSats: stored.perSwapFeeCeilingSats ?? series.perSwapFeeCeilingSats,
      })
    : {};
  return {
    ...stored,
    ...base,
    genesis: base.genesis || stored.genesis || ISSUER_CONFIG.genesis,
    codeHash: base.codeHash || stored.codeHash || ISSUER_CONFIG.codeHash,
    sensibleId: base.sensibleId ?? stored.sensibleId ?? ISSUER_CONFIG.sensibleId,
    tokenSupply: base.tokenSupply ?? stored.tokenSupply ?? ISSUER_CONFIG.tokenSupply,
    issuerAddress: stored.issuerAddress || ISSUER_CONFIG.issuerAddress,
    collectionName: base.collectionName || stored.collectionName || ISSUER_CONFIG.collectionName,
    vaultAddress: stored.vaultAddress || ISSUER_CONFIG.vaultAddress,
    burnAddress: stored.burnAddress || ISSUER_CONFIG.burnAddress,
    perSwapFeeCeilingSats: stored.perSwapFeeCeilingSats ?? ISSUER_CONFIG.perSwapFeeCeilingSats,
  };
}

export function openLedger(ledgerPath) {
  return new SwapLedger(ledgerPath);
}

export function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

/** Thrown engine/cli errors → stable JSON + exit code. */
export function emitError(error) {
  const code = error?.code || (error instanceof Error ? 'UNEXPECTED' : 'UNEXPECTED');
  const exitCode = code === 'OWNER_CONFIRMATION_REQUIRED' ? 2 : 1;
  emit({
    ok: false,
    error: code,
    detail: error instanceof Error ? error.message : String(error),
    ...(error instanceof SwapEngineError || error instanceof CliError ? { context: error.detail ?? null } : {}),
  });
  process.exitCode = exitCode;
}

/** Standard wrapper: parse → run → emit, with a single error path. */
export async function runCli({ argv, help, flags, main }) {
  if (wantsHelp(argv)) {
    process.stdout.write(help.endsWith('\n') ? help : `${help}\n`);
    return;
  }
  try {
    const args = parseCliArgs(argv, flags);
    const result = await main(args);
    emit(result);
    if (result?.pending) process.exitCode = 3;
  } catch (error) {
    emitError(error);
  }
}
