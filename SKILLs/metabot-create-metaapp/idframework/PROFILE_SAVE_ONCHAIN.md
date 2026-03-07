# Profile Save (createOrUpdateUserInfo) – On-Chain via Metalet

## Current implementation

**idframework/createOrUpdateUserInfoImpl.js** uses **window.metaidwallet.createPin** only. It does not use metaid.js, TxComposer, or mvc.

- The script always registers the on-chain impl (no wallet check at load). When the user clicks Save, the impl uses `window.__createOrUpdateUserInfoImpl` so profile save writes to the chain.
- When metaidwallet is not available, **idconfig.js**’s default (local-only) remains; no chain write.

## Loading order

- `idconfig.js` (sets default local-only impl).
- `idutils.js`.
- `createOrUpdateUserInfoImpl.js` (overwrites the default with the on-chain impl).
- Then IDFramework core and id-connect-button.

No need to load metaid.js or meta-contract. The wallet (e.g. Metalet extension) must inject `window.metaidwallet.createPin` before or when the user clicks Save.

## createPin payload shape

The impl builds a `dataList` where each item has the shape expected by `metaidwallet.createPin`:

- **name**: `{ metaidData: { operation, path, body, contentType: 'text/plain' } }`
- **bio**: same with path `/info/bio` or `@bioId`
- **avatar**: `{ metaidData: { operation, path, body, encoding: 'base64', contentType } }`  
  - `contentType` is derived from `userData.avatarContentType` (e.g. `image/png` → `image/png;binary`), default `image/jpeg;binary`.

Then it calls:

```js
window.metaidwallet.createPin({ chain: 'mvc', feeRate, dataList });
```

and returns the result so the button can refetch user after save when the call succeeds (no `localOnly`).

## Summary

- **On-chain:** Ensure `window.metaidwallet.createPin` is available (e.g. Metalet), then load `createOrUpdateUserInfoImpl.js` after idconfig. No metaid.js required.
- **Local-only:** Do not load createOrUpdateUserInfoImpl, or load it when metaidwallet is absent; idconfig’s default will be used.
