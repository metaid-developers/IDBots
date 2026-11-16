---
name: nft-swap
description: MetaContract NFT → MRC-721 swap pilot for the MetaBot Avatar album. Issuer import gate, identity restore, and the swap engine CLI (vault-poll / verify-claim / mint-and-send / burn-batch). Only the MetaBot Avatar album is in scope; every fund/token action goes through host confirmation gates per PRD §9.
version: 0.1.0
---

# NFT Swap (MetaContract → MRC-721 pilot, MetaBot Avatar album)

Managed swap service for the legacy (MetaContract) NFT album **MetaBot
Avatar**: users deposit old tokens into the vault address, the engine
verifies on-chain, mints the same-numbered MRC-721 item **as the original
issuer identity**, sends it to the user, and periodically burns the
deposited old tokens one-tx-per-token to the black hole. Free of charge
(owner ruling 2026-11-04).

Governed by `PRD-metacontract-to-mrc721-v1.md` (v1.2) and
`REVIEW-ama-prereview-v1.md`; the 16 review corrections are hard
requirements, none may be weakened.

## Status

- **M0 tooling**: issuer import gate + identity restore + vault
  configuration + collection registration. Rehearsed on a scratch store;
  production run happens with the app closed.
- **M1 engine (this release)**: the four CLI modes `vault-poll`,
  `verify-claim`, `mint-and-send`, `burn-batch`, wired into one resumable
  pipeline on top of `cli/lib/swap-ledger.mjs` (state machine) and
  `cli/lib/vault-poll-lib.mjs` (flag-paged vault reader). Unit-tested
  end-to-end with injected readers/writers — no test broadcasts a chain tx.
- **M2/M3 (later)**: chat UX and the daily three-bucket recon report.

## Fixed configuration (owner-ratified, do not edit)

See `cli/lib/issuer-config.mjs` — genesis/codeHash/sensibleId, issuer
address + 236 BIP44 path, vault = `m/44'/236'/0'/0/1`, collection name
`metabot-avatar` (totalSupply 9560), black hole
`1111111111111111111114oLvT2`, net `livenet`, per-swap fee ceiling
5000 sats.

## Security rules (PRD §9/§9b — violation ends the engagement)

1. The issuer mnemonic only lives inside this package's CLI processes and
   the host signing workers (env-injected). It never appears in chat, logs,
   docs, screenshots, or error output; `import-issuer` runs a word-level
   contamination guard over its own output.
2. The mnemonic is read directly from the owner-managed source file inside
   the CLI process (owner-ratified handoff, 2026-11-05). No copy is kept.
3. The restore hard-fails unless the derived address equals the ratified
   issuer address AND the globalmetaid guard passes (`BOT_IDENTITY_MISMATCH`
   otherwise).
4. collection_desc modifications always require a per-action owner
   confirmation card; burn batches always require owner sign-off.
5. Host safety gates are not to be bypassed or re-implemented in weaker
   form (ownerAddress check, burned-refuse, chain check, collection
   createAddress check).

## CLI reference

All CLIs print public fingerprint evidence only (addresses, globalmetaid,
signatures, word counts — never mnemonic words).

```bash
# 1. Import gate — parse the owner's notes file inside this process, pick the
#    commented "endorse"-led group, derive at the 236 issuer path and gate on
#    the ratified issuer address; verify the same-origin binding signature.
node cli/import-issuer.mjs --file /path/to/metacontract_nft_issuer.md

# 2. Restore — create the swap Bot from the issuer identity in the IDBots
#    store (app must be closed). --dry-run runs read-only pre-flight checks.
node cli/restore-issuer.mjs [--user-data "<IDBots userData dir>"] [--dry-run]

# Self-test (public throwaway fixture only):
node cli/selftest.mjs
```

## M1 pipeline (vault-poll → verify-claim → mint-and-send → burn-batch)

One resumable pipeline, one CLI per stage. Every mode prints structured JSON;
exit codes: `0` done/dry-run, `1` refused/failed, `2` human gate, `3` pending
(retry later). Chain writes are OFF by default — `--broadcast` is required,
and the burn batch additionally requires `--confirm-owner`.

```bash
# 1. Vault inspection — flag-paged full fetch + local triple filter.
#    --dry-run never even creates the ledger file.
node cli/vault-poll.mjs --dry-run
node cli/vault-poll.mjs                     # records matured deposits (>=6 conf)

# 2. Verify + claim — live re-read of the vault outpoint (still there? triple
#    match? >=6 confirmations?) then the exact itemPath pre-check, then
#    detected → claimed. A foreign pin at item-#### aborts (stop-and-alert).
node cli/verify-claim.mjs --token-index 817 --claimant <user bot MVC address>

# 3. Mint + send — dry-run plan first; --broadcast needs the app build
#    (dist-electron) so every write goes through the host services/gates.
node cli/mint-and-send.mjs --token-index 817
node cli/mint-and-send.mjs --token-index 817 --broadcast
node cli/mint-and-send.mjs --token-index 817 --broadcast   # re-run = resume

# 4. Burn — only sent rows with a stable transferCount and a live vault
#    outpoint; one tx per token; owner sign-off required to broadcast.
node cli/burn-batch.mjs                                   # plan only
node cli/burn-batch.mjs --batch-id burn-20261117 --broadcast --confirm-owner
```

Resume semantics (PRD §5.7 crash-recovery invariant):

- `mint_pending` resumes from the recorded `mint_pin_id`; the mint is **never**
  repeated. If a crash happened between broadcast and the ledger write, the
  exact-path probe finds the issuer pin and **adopts** it instead of minting.
- `item_desc` is a retryable display layer recorded in its own column; a
  failed item_desc never invalidates the mint.
- `item/info` missing `output`/`outputValue` is index lag: the row stays
  `mint_pending` and the command exits `3` (pending), not an error.
- `creatorMinted` / `collection createAddress` mismatch halts with the pin
  kept in `mint_pending` (human review; never auto-reject).
- A `burn_pending` row with no txid whose token has left the vault blocks the
  batch (`BURN_RECOVERY_TXID_UNKNOWN`) — the txid is reconciled manually, the
  burn is never blindly re-broadcast.

Fee control: mint pins are estimated before broadcast and any estimate over
`--fee-ceiling` (default 5000 sats, COST-BUDGET §5-1) pauses the row. Transfer
legs are measured from the signed raw tx after broadcast (the host transfer
service does not expose a pre-broadcast estimate) and any over-ceiling fee is
flagged in the batch output.

The engine never reads key material: mint/transfer go through the host's own
services, where the mnemonic is injected into the signing worker only
(PRD §9). The pipeline CLIs load no mnemonic source file at all.

Operational notes:

- `--broadcast` opens its own `SqliteStore` handle on the IDBots userData;
  run engine writes with the app closed or idle. The app's in-process
  spent-UTXO session cache is not shared across processes.
- The mint-pin fee is gated before broadcast. Legacy-token transfer fees
  (delivery / burn) are decoded from the signed raw tx after broadcast; an
  over-ceiling fee is flagged in the output (`feeOverCeiling`), not undone.
- A crash between an item_desc broadcast and its ledger write can cost one
  extra item_desc pin on retry (display fields are first-write-wins, so the
  result is unchanged). The mint pin itself is never re-broadcast.

### Known finding: chat key rotation

The identity's on-chain chatpubkey was registered from a key outside this
mnemonic's standard derivations (measured 2026-11-05: no match at 236/10001
or sibling indexes). M0 therefore re-registers (rotates) the identity chat
key from the 236 issuer key via the host sync flow, one extra pin; senders
then encrypt to the rotated key and the bot can decrypt private chats.

## Vault

The vault is the fixed subaddress `m/44'/236'/0'/0/1` of the issuer
account, written into the bot config at M0
(`cowork_config` key `nft_swap_pilot_config`). Polling filters the
wallet-api `utxo-list` to THIS address only, with flag-cursor full-page
pagination and local genesis/codeHash/tokenIndex filtering (PRD §3).
