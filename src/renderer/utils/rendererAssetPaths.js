function getDefaultBaseHref() {
  const href = globalThis?.location?.href;
  return typeof href === 'string' && href.trim() ? href : 'http://localhost/';
}

export function getRendererBundledAssetUrl(assetName, baseHref = getDefaultBaseHref()) {
  const normalized = typeof assetName === 'string' ? assetName.replace(/^\.?\//, '').trim() : '';
  if (!normalized) return '';
  return new URL(normalized, baseHref).toString();
}

export function getDefaultMetabotAvatarUrl(baseHref) {
  return getRendererBundledAssetUrl('default_metabot.png', baseHref);
}
