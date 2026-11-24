/**
 * CJK patterns and display templates for published personal-goods-shop
 * MetaApps (NFT showcase rewrite). This is a dedicated CJK dictionary module
 * like i18n.ts / taskCenterI18n.ts / loginCopy.ts: the mobile i18n static
 * guard (tests/mobileI18nStatic.test.mjs) requires CJK copy to live in
 * dedicated dictionary modules, not inline in component sources.
 *
 * Why this cannot route through t(): the match/strip patterns address
 * externally PUBLISHED Chinese shop titles (the shop pages carry Chinese
 * names by design regardless of the UI language), and the display suffix
 * mirrors those titles, so the strings are UI-language-independent content.
 */

/** Matches the published personal-goods-shop / showcase title family. */
export const NFT_SHOP_TITLE_MATCH_RE =
  /精选头像铺|头像铺|老藏家|清仓小铺|个人数字商品小店|数字商品小店/iu;

/** Strips the shop-name tail (and an optional 的) to recover the owner name. */
export const NFT_SHOP_TITLE_OWNER_STRIP_RE =
  /\s*(?:的)?(?:精选头像铺|头像铺|老藏家清仓小铺|清仓小铺|个人数字商品小店|数字商品小店).*$/iu;

/** Display title for the rewritten showcase page. */
export const nftShowcaseTitle = (owner: string): string =>
  owner ? `${owner} 的 NFT 橱窗` : 'NFT 橱窗';
