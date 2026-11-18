/**
 * Vault polling library (PRD §3 measured contract + §5 step 4).
 *
 * wallet-api `utxo-list` does NOT filter by genesis server-side (verified
 * 2026-11-04: the genesis param is ignored) and paginates with a `flag`
 * cursor — polling without full-page flag pagination MISSES deposits
 * (mvcNftService.ts L226-247 is the house implementation this mirrors).
 * All triple filtering (genesis + codeHash + tokenIndex range + sensibleId
 * fallback) happens locally.
 *
 * The vault address is polled EXCLUSIVELY (owner ruling: vault = fixed
 * subaddress m/44'/236'/0'/0/1; the issuer address is never mixed in —
 * prereview #11).
 *
 * Wire shape re-measured 2026-11-16 against
 * `/wallet-api/v4/mvc/address/contract/nft/utxo-list?net=livenet&address=<vault>`:
 * rows are CAMELCASE — `txId` / `txIndex` / `codeHash` (the satoshi amount is
 * singular `satoshi` there; this reader's `satoshis` alias is still legacy and
 * unused by the engine). Reading only the lower-case names silently blanked the
 * triple and misjudged a correct deposit as foreign. Both spellings are now
 * accepted. The same page also repeats its row on the `flag=0` follow-up page,
 * so outpoints are deduped before returning.
 *
 * Cover-preservation fix (2026-11-19, root-cause report §4.2 step 1): the row
 * mapper now also keeps `name` and `imgUrl`. `imgUrl` is the ONLY pre-burn
 * image source the mint-time cover gate consumes, and `name` feeds the
 * engine's partName; both live on the same v4 row and were silently dropped
 * before, which is what produced every cover-less `item_desc` (report §3.2a).
 */

export const VAULT_POLL_PAGE_CAP = 50;
export const MVP_CONFIRMATIONS = 6;

/**
 * Fetch ALL nft UTXO rows for an address via flag-cursor pagination.
 * Mirrors mvcNftService getMvcNftBalance's page loop: up to 50 pages, stop
 * when the list is empty or the flag cursor stops advancing.
 *
 * @param {object} args
 * @param {string} args.address       vault address
 * @param {string} [args.net]        default 'livenet' (PRD §3 measured口径)
 * @param {string} [args.baseUrl]    default https://www.metalet.space
 * @param {(url: string) => Promise<{ json: (any) => object }>} [args.fetchImpl] injectable for tests
 * @returns {Promise<Array<{ txid, outIndex, genesis, codehash, tokenIndex, sensibleId, height, satoshis, name, imgUrl }>>}
 */
export async function fetchVaultTokenRows({ address, net = 'livenet', baseUrl = 'https://www.metalet.space', fetchImpl = fetch }) {
  const rows = [];
  const seenOutpoints = new Set();
  let flag;
  for (let page = 0; page < VAULT_POLL_PAGE_CAP; page++) {
    const params = new URLSearchParams({ net, address });
    if (flag) params.set('flag', flag);
    const res = await fetchImpl(`${baseUrl}/wallet-api/v4/mvc/address/contract/nft/utxo-list?${params.toString()}`);
    const json = await res.json();
    if (json?.code !== 0) {
      throw new Error(`utxo-list failed: ${json?.code} ${json?.message ?? ''}`.trim());
    }
    const list = Array.isArray(json?.data?.list) ? json.data.list : [];
    if (!list.length) break;
    for (const item of list) {
      const row = {
        // real v4 wire names are camelCase (measured 2026-11-16, see header);
        // lower-case aliases cover the mvcNftService-shaped fixture rows
        txid: String(item.txid ?? item.txId ?? ''),
        outIndex: Number(item.outIndex ?? item.vout ?? item.txIndex ?? 0),
        genesis: String(item.genesis || ''),
        codehash: String(item.codehash ?? item.codeHash ?? ''),
        tokenIndex: Number(item.tokenIndex ?? 0),
        sensibleId: item.sensibleId != null ? String(item.sensibleId) : null,
        height: Number(item.height ?? -1),
        satoshis: Number(item.satoshis ?? item.value ?? 0),
        // legacy display fields (2026-11-19 cover-loss fix, report §4.2 step 1):
        // `name` feeds the engine's partName; `imgUrl` is the only pre-burn
        // image source the mint-time cover gate consumes. Both are on the same
        // v4 row and were dropped here before (report §3.2a).
        name: String(item.name || ''),
        imgUrl: String(item.imgUrl ?? item.imageUrl ?? ''),
      };
      // the `flag=0` follow-up page repeats the same row — one outpoint counts once
      const outpoint = `${row.txid}:${row.outIndex}`;
      if (seenOutpoints.has(outpoint)) continue;
      seenOutpoints.add(outpoint);
      rows.push(row);
    }
    const nextFlag = list[list.length - 1]?.flag;
    if (!nextFlag || nextFlag === flag) break; // flag-unchanged termination (house pattern)
    flag = nextFlag;
  }
  return rows;
}

/**
 * Filter rows down to the target album triple (PRD §5.4a; sensibleId as the
 * fallback second key per §6). Non-matching rows are returned separately so
 * the engine can record them as rejected deposits (出账例外仓).
 */
export function classifyVaultRows(rows, album) {
  const matched = [];
  const foreign = [];
  for (const row of rows) {
    const tripleOk =
      row.genesis === album.genesis &&
      row.codehash === album.codeHash &&
      Number.isInteger(row.tokenIndex) &&
      row.tokenIndex >= 1 &&
      row.tokenIndex <= album.tokenSupply;
    const sensibleOk = album.sensibleId != null && row.sensibleId != null && row.sensibleId === album.sensibleId;
    if (tripleOk || (sensibleOk && row.genesis === album.genesis && row.codehash === album.codeHash)) {
      matched.push(row);
    } else {
      foreign.push(row);
    }
  }
  return { matched, foreign };
}

/**
 * One poll pass: fetch → classify → ledger reconciliation.
 *
 * Deposits are only actionable at >= minConfirmations confirmations (MVP 6,
 * PRD §5.4c); unconfirmed matches stay unrecorded until they mature (height
 * -1 = mempool). Foreign rows are recorded as rejected deposits immediately
 * (they sit in OUR vault — the owner must see them; refund is a separate
 * manual/owner-approved step, never automatic).
 *
 * @param {object} args
 * @param {import('./swap-ledger.mjs').SwapLedger} args.ledger
 * @param {object} args.album  { genesis, codeHash, sensibleId, tokenSupply }
 * @param {string} args.vaultAddress
 * @param {number} [args.minConfirmations]
 * @param {number} [args.chainTipHeight]  current chain tip; omit to use height>=0 as "confirmed enough" (test mode)
 * @param {(txid: string) => Promise<number>} [args.confirmationsResolver] authoritative per-tx confirmation
 *        count (manapi `/api/tx/status`); when supplied it overrides the height arithmetic
 * @returns {Promise<{ newDeposits: any[], matured: any[], foreign: any[], unconfirmed: any[], scanned: number }>}
 */
export async function pollVault({
  ledger,
  album,
  vaultAddress,
  minConfirmations = MVP_CONFIRMATIONS,
  chainTipHeight,
  fetchImpl = fetch,
  confirmationsResolver,
}) {
  const rows = await fetchVaultTokenRows({ address: vaultAddress, fetchImpl });
  const { matched, foreign } = classifyVaultRows(rows, album);

  const confirmationsOf = async (row) => {
    if (confirmationsResolver) {
      const confs = Number(await confirmationsResolver(row.txid));
      return Number.isFinite(confs) ? Math.max(0, confs) : 0;
    }
    if (row.height < 0) return 0;
    if (!Number.isFinite(chainTipHeight) || chainTipHeight == null) return MVP_CONFIRMATIONS; // test mode: mined = mature
    return Math.max(0, chainTipHeight - row.height + 1);
  };

  const newDeposits = [];
  const matured = [];
  const unconfirmed = [];

  for (const row of matched) {
    const confs = await confirmationsOf(row);
    const existing = ledger.rowByOutpoint(`${row.txid}:${row.outIndex}`);
    if (confs < minConfirmations) {
      unconfirmed.push({ ...row, confirmations: confs });
      continue;
    }
    if (existing) {
      // refresh confirmations on a tracked deposit
      ledger.recordDetection({
        genesis: album.genesis,
        codeHash: album.codeHash,
        tokenIndex: row.tokenIndex,
        sensibleId: row.sensibleId,
        depositTxid: row.txid,
        depositVout: row.outIndex,
        depositHeight: row.height,
      });
      matured.push({ ...row, ledgerId: existing.id });
      continue;
    }
    const { row: ledgerRow } = ledger.recordDetection({
      genesis: album.genesis,
      codeHash: album.codeHash,
      tokenIndex: row.tokenIndex,
      sensibleId: row.sensibleId,
      depositTxid: row.txid,
      depositVout: row.outIndex,
      depositHeight: row.height,
    });
    if (ledgerRow.state === 'detected') newDeposits.push({ ...row, ledgerId: ledgerRow.id });
    // duplicate-index rows land as rejected (recorded inside recordDetection)
  }

  const foreignRecords = [];
  for (const row of foreign) {
    const outpoint = `${row.txid}:${row.outIndex}`;
    if (ledger.rowByOutpoint(outpoint)) continue; // already recorded
    const { row: ledgerRow } = ledger.recordDetection({
      genesis: row.genesis || album.genesis,
      codeHash: row.codehash || album.codeHash,
      tokenIndex: Number.isInteger(row.tokenIndex) ? row.tokenIndex : -1,
      sensibleId: row.sensibleId,
      depositTxid: row.txid,
      depositVout: row.outIndex,
      depositHeight: row.height,
    });
    if (ledgerRow.state !== 'rejected') {
      ledger.reject(ledgerRow.id, 'foreign token in vault (triple mismatch)');
    }
    foreignRecords.push({ ...row, ledgerId: ledgerRow.id });
  }

  return { newDeposits, matured, foreign: foreignRecords, unconfirmed, scanned: rows.length };
}
