# IDBots NFT Avatar Protocol v1

## Purpose

An NFT avatar binds a MetaID profile to an MRC-721 item held by that identity's MVC wallet. Ordinary image avatars remain compatible with existing clients.

## On-chain records

An NFT avatar uses two independent pins, with the latest pin on each path winning:

- `/info/avatar`: the NFT cover image bytes, in the same form as an ordinary avatar. Legacy clients render this image without any NFT meaning.
- `/info/nftAvatar`: an `application/json` declaration:

```json
{
  "protocol": "mrc721",
  "itemPinId": "<64hex>i<n>",
  "ownerAddress": "<MVC address>"
}
```

The declaration creator/address must match `ownerAddress`. An empty payload clears the declaration. Changing to an ordinary image or clearing the avatar publishes the corresponding empty NFT declaration.

## Local reference

Clients may store and exchange an identity-bound reference:

```text
nft://mrc721/<itemPinId>?owner=<MVC address>&metaid=<globalMetaId>
```

`owner` and `metaid` are optional for backward compatibility with the original local-only prototype. A reference without identity facts never receives a verified NFT mark.

## Verification rules

Setting an avatar requires all of the following:

1. The item exists and is not burned.
2. The indexer reports `ownerAddress` as the current holder.
3. The current holder equals the wallet of the MetaBot or human identity being edited.
4. The item cover resolves to a renderable image.

Saving and publishing re-check ownership to reject stale selections and forged references.

Displaying the NFT mark additionally requires:

1. A valid `/info/nftAvatar` declaration by the profile identity.
2. The declaration item and owner match the reference.
3. The item's current on-chain owner still matches that identity.

If declaration or ownership verification fails, clients may show the cover as an ordinary image but must not show an NFT mark. Verification is refreshed rather than cached indefinitely so a transfer revokes the mark.

## Presentation

- A verified, uncertified NFT avatar uses only a small neutral `NFT` badge.
- The rainbow frame is reserved for a verified NFT whose collection is listed in the official IDBots NFT CA registry.
- CA certification and wallet ownership are separate facts; neither can substitute for the other.

## Recovery

Restore reads both records. The ordinary avatar pin supplies the cover fallback, while a valid NFT declaration restores the identity-bound reference and its sync state. Ordinary-image restores remain unchanged.
