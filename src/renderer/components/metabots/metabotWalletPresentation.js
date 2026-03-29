const SECTION_DEFS = [
  { key: "nativeAssets", title: "原生币" },
  { key: "mrc20Assets", title: "MRC20 Token" },
  { key: "mvcFtAssets", title: "MVC Token" },
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
        title: section.title,
        state,
        items,
      };
    }),
  };
}

export function validateTokenTransferDraft({ amount, receiver }) {
  const to = String(receiver || "").trim();
  if (!to) return { valid: false, errorKey: "transferReceiverRequired" };
  const amountNum = Number.parseFloat(String(amount || "").trim());
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return { valid: false, errorKey: "transferAmountInvalid" };
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
