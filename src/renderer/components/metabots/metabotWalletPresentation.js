import Decimal from 'decimal.js';
import { buildNftArtworkSources } from './metabotNftPresentation.js';

const SECTION_DEFS = [
  { key: "nativeAssets", titleKey: "metabotWalletNativeAssets" },
  { key: "mrc20Assets", titleKey: "metabotWalletMrc20Assets" },
  { key: "mvcFtAssets", titleKey: "metabotWalletMvcFtAssets" },
  { key: "mvcNftAssets", titleKey: "metabotWalletMvcNftAssets" },
];
function toItems(value) {
  return Array.isArray(value) ? value : [];
}

export function buildWalletAssetsSectionsViewModel({ assets, loading, error }) {
  return {
    sections: SECTION_DEFS.map((section) => {
      const items = toItems(assets?.[section.key]);
      let state = "loaded";
      if (loading) state = "loading";
      else if (error) state = "error";
      else if (items.length === 0) state = "empty";
      return {
        key: section.key,
        titleKey: section.titleKey,
        state,
        items,
      };
    }),
  };
}

/**
 * Tile view model for one MVC MetaContract NFT held in a wallet asset series:
 * title (item name → #tokenIndex → NFT), badge serial, and the ordered
 * artwork candidate chain (imgUrl https direct → icon metafile content
 * routes → initials placeholder) shared with the NFT wallet modal tiles.
 */
export function buildMvcNftItemTileViewModel(item) {
  const tokenIndex = item?.tokenIndex != null && String(item.tokenIndex).trim() !== ''
    ? String(item.tokenIndex).trim()
    : '';
  const badge = tokenIndex ? `#${tokenIndex}` : '';
  const name = item?.name?.trim() || '';
  return {
    key: tokenIndex,
    title: name || badge || 'NFT',
    badge,
    artworkSources: buildNftArtworkSources({ imageUrl: item?.imgUrl, imageRef: item?.icon }),
    artworkInitials: (name || 'NFT').slice(0, 2).toUpperCase(),
  };
}

const MVC_NFT_DETAIL_MONO_FIELDS = new Set([
  'metabotNftFieldTokenIndex',
  'metabotNftFieldGenesis',
  'metabotNftFieldCodeHash',
  'metabotNftFieldOwner',
]);

/**
 * Detail field rows for one held MVC MetaContract NFT (labelKeys map onto
 * i18n; mono rows get the copy affordance in the modal). Issuance facts come
 * from the series (supply), the item (satoshi) and the wallet (holder).
 */
export function buildMvcNftItemDetailRows(asset, item) {
  const rows = [];
  const push = (labelKey, value) => {
    const text = value == null ? '' : String(value).trim();
    if (!text) return;
    rows.push({ labelKey, value: text, mono: MVC_NFT_DETAIL_MONO_FIELDS.has(labelKey) });
  };

  push('metabotNftFieldSeries', asset?.seriesName);
  push('metabotNftFieldTokenIndex', item?.tokenIndex != null && String(item.tokenIndex).trim() !== ''
    ? `#${String(item.tokenIndex).trim()}`
    : '');
  push('metabotNftFieldSupply', asset?.tokenSupply != null ? String(asset.tokenSupply) : '');
  push('metabotNftFieldNetwork', 'MVC');
  push('metabotNftFieldSatoshi', item?.satoshi != null && item.satoshi > 0 ? `${item.satoshi} sats` : '');
  push('metabotNftFieldGenesis', asset?.genesis);
  push('metabotNftFieldCodeHash', asset?.codeHash);
  push('metabotNftFieldOwner', asset?.address);
  return rows;
}

export function validateTokenTransferDraft({ amount, receiver, maxDisplayBalance }) {
  const to = String(receiver || "").trim();
  if (!to) return { valid: false, errorKey: "transferReceiverRequired" };

  let amountValue;
  try {
    amountValue = new Decimal(String(amount || "").trim());
  } catch {
    return { valid: false, errorKey: "transferAmountInvalid" };
  }
  if (!amountValue.isFinite() || amountValue.lte(0)) {
    return { valid: false, errorKey: "transferAmountInvalid" };
  }

  const balanceText = String(maxDisplayBalance || "").trim();
  if (balanceText) {
    try {
      const balanceValue = new Decimal(balanceText);
      if (balanceValue.isFinite() && amountValue.gt(balanceValue)) {
        return { valid: false, errorKey: "transferAmountExceedsBalance" };
      }
    } catch {
      // Ignore malformed balance strings and fall back to amount-only validation.
    }
  }

  return { valid: true };
}

export function buildTokenTransferPreviewPayload({
  metabotId,
  kind,
  asset,
  receiver,
  amount,
  feeRate,
}) {
  return {
    kind,
    metabotId,
    asset,
    toAddress: String(receiver || "").trim(),
    amount: String(amount || "").trim(),
    feeRate,
  };
}

export function buildTokenTransferExecutePayload({
  metabotId,
  kind,
  asset,
  receiver,
  amount,
  feeRate,
}) {
  return buildTokenTransferPreviewPayload({
    metabotId,
    kind,
    asset,
    receiver,
    amount,
    feeRate,
  });
}
