#!/usr/bin/env node
/**
 * G1–G3 readings for the chain-write session attribution change.
 * Spec: pin://64fbb0ad049ead723c788c26b9495845190fd49d6fd6e7600006a22e9aa487f8i0 §五.
 *
 * Read-only: opens the database with node:sqlite readOnly. Never writes the
 * live DB. Usage:
 *
 *   node scripts/rpc-attribution-g1.mjs --db <path> [--cutoff <ms|ISO>] [--label before]
 *
 *   G1  bare origin='rpc' rows at/after cutoff                 → expected 0 after rollout
 *   G2  origin LIKE 'rpc#s=%' whose parsed session is missing
 *       or belongs to another metabot                          → expected 0
 *   G3  bare origin='tool:omni_cast' rows at/after cutoff      → expected 0
 *
 * G4 (chain author == ledger metabot) is not computed here: it needs one chain
 * read per pin. The note's sampling rule (20 random rpc#... rows, 20/20) is the
 * manual companion to this script.
 */

import { DatabaseSync } from 'node:sqlite';

function parseArgs(argv) {
  const args = { db: '', cutoff: 0, label: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--db') args.db = argv[++i] ?? '';
    else if (token === '--cutoff') args.cutoff = argv[++i] ?? '0';
    else if (token === '--label') args.label = argv[++i] ?? '';
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

function parseCutoff(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) return Number(text);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw new Error(`invalid --cutoff: ${text}`);
  return parsed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.db) {
    console.log('usage: node scripts/rpc-attribution-g1.mjs --db <sqlite path> [--cutoff <ms|ISO>] [--label <name>]');
    process.exit(args.help ? 0 : 2);
  }
  const cutoff = parseCutoff(args.cutoff);
  const db = new DatabaseSync(args.db, { readOnly: true });
  const count = (sql, ...params) => Number(db.prepare(sql).get(...params)?.c ?? 0);

  try {
    const g1 = count(
      `SELECT COUNT(*) AS c FROM metabot_chain_writes
       WHERE origin = 'rpc' AND occurred_at_ms >= ?`,
      cutoff,
    );
    const g2 = count(
      `WITH parsed AS (
         SELECT metabot_id, origin,
           substr(origin, instr(origin, '#s=') + 3,
                  instr(substr(origin, instr(origin, '#s=') + 3), '#') - 1) AS sid
         FROM metabot_chain_writes
         WHERE origin LIKE 'rpc#s=%' AND occurred_at_ms >= ?
       )
       SELECT COUNT(*) AS c FROM parsed p
       LEFT JOIN cowork_sessions s ON s.id = p.sid
       WHERE s.id IS NULL OR s.metabot_id <> p.metabot_id`,
      cutoff,
    );
    const g3 = count(
      `SELECT COUNT(*) AS c FROM metabot_chain_writes
       WHERE origin = 'tool:omni_cast' AND occurred_at_ms >= ?`,
      cutoff,
    );
    const rpcAll = count(`SELECT COUNT(*) AS c FROM metabot_chain_writes WHERE origin = 'rpc'`);
    const omniAll = count(`SELECT COUNT(*) AS c FROM metabot_chain_writes WHERE origin = 'tool:omni_cast'`);
    const suffixRows = count(`SELECT COUNT(*) AS c FROM metabot_chain_writes WHERE origin LIKE '%#%'`);
    const lastRpc = db
      .prepare(`SELECT MAX(occurred_at_ms) AS ms FROM metabot_chain_writes WHERE origin = 'rpc'`)
      .get()?.ms;

    const label = args.label ? ` [${args.label}]` : '';
    console.log(`rpc-attribution G-readings${label}`);
    console.log(`db=${args.db}`);
    console.log(`cutoff=${cutoff}${cutoff ? ` (${new Date(cutoff).toISOString()})` : ' (all rows)'}`);
    console.log(`G1 bare rpc at/after cutoff: ${g1}`);
    console.log(`G2 rpc#s rows missing/mismatched session: ${g2}`);
    console.log(`G3 bare tool:omni_cast at/after cutoff: ${g3}`);
    console.log(`context: bare rpc total=${rpcAll}; bare omni_cast total=${omniAll}; rows with '#' origin=${suffixRows}`);
    console.log(`context: last bare rpc at=${lastRpc ? new Date(Number(lastRpc)).toISOString() : 'never'}`);
  } finally {
    db.close();
  }
}

main();
