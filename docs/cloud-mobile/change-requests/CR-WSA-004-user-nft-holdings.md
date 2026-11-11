# CR-WSA-004 — Read-only user-wallet MRC-721 holdings

- **Status:** Approved by the owner (2026-11-11); implemented in the same change per the `00` process
- **Date:** 2026-11-11
- **Contract:** `02-ipc-allowlist-v1.md`; allowlist version 1.0.1 → 1.0.2
- **Affected parties:** WS-A (gateway/allowlist), WS-E (mobile client), acceptance
- **Compatibility:** Backward-compatible addition; no existing channel or payload is removed or narrowed

## Current text

`userIdentity:get` and `userIdentity:updateAvatar` exist at P1, and `idbots:getMetabotNfts` exposes a specific Bot wallet's holdings. No read-only channel exposes the signed-in human user's own MRC-721 holdings.

## Problem

The mobile and desktop profile pages must let the user choose an NFT avatar only from the user's own wallet. Reusing a Bot wallet would select the wrong asset and violate the ownership rule. A new read is therefore required; `userIdentity:updateAvatar` continues to perform the authoritative ownership check before saving and publishing.

## Proposed change

Add `userIdentity:getNfts` at tier **P1**. It takes no arguments and returns the same normalized item shape as `idbots:getMetabotNfts({kind:'mrc721'})`, sourced from the signed-in user's MVC address. It exposes no mnemonic, private key, signing capability, transfer, or other fund movement.

Allowlist version bumps **1.0.1 → 1.0.2**.

The existing `userIdentity:updateAvatar` accepts an identity-bound `nft://mrc721/...` reference in addition to an ordinary image data URL. The main process must reject an item not currently held by the user and must publish the NFT cover plus `/info/nftAvatar` declaration described in `docs/nft-avatar-protocol.md`.

## Migration and acceptance

1. `02` and `src/main/gateway/allowlist.ts` carry the new P1 row and version 1.0.2.
2. The regenerated mobile IPC contract includes `userIdentity.getNfts`.
3. Gateway tests confirm the new read is allowed at P1 and requires no wallet secret.
4. A user can select only an NFT currently held by the user wallet; a forged or transferred item is rejected by the main process.
