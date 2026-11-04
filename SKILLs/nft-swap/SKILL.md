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

- **M0 tooling (this release)**: issuer import gate + identity restore +
  vault configuration. Rehearsed on a scratch store; production run happens
  with the app closed.
- **M1-M3 engine modes**: `vault-poll`, `verify-claim`, `mint-and-send`,
  `burn-batch` — land in later releases on the same branch.

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
