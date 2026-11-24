/**
 * commercePromoI18n — self-contained bilingual copy for the commerce bridge
 * surfaces (intent confirm card, promo ammo pack modal, invite attribution
 * hints). Lives outside `src/renderer/services/i18n.ts` on purpose: that file
 * is owned by the parallel WS-A workstream and this feature must not touch it.
 *
 * Language resolution: callers pass the current UI language (`i18nService
 * .getLanguage()`), and `tCommerce` falls back to English for any missing
 * key — matching the repo's "English is the source language" convention
 * (AGENTS.md).
 */

export type CommerceLang = 'en' | 'zh';

export const COMMERCE_LANGS: readonly CommerceLang[] = ['en', 'zh'];

export function resolveCommerceLang(language: unknown): CommerceLang {
  const raw = typeof language === 'string' ? language.trim().toLowerCase() : '';
  return raw.startsWith('zh') ? 'zh' : 'en';
}

const EN = {
  commerceConfirmTitle: 'Confirm with your AI assistant',
  commerceConfirmIntroBuy: 'Your AI will handle this purchase hand-off. Nothing is charged until you approve the actual payment in a later confirmation.',
  commerceConfirmIntroFriend: 'This opens the host private-chat / follow flow for this Bot. Nothing is sent until you confirm there.',
  commerceFieldItem: 'Item',
  commerceFieldCollection: 'Collection',
  commerceFieldSeller: 'Seller',
  commerceFieldOwner: 'Shop owner',
  commerceFieldPrice: 'Points price',
  commerceFieldFiatPrice: 'Reference price',
  commerceFieldMode: 'Intent',
  commerceModeBuy: 'Buy with ME points',
  commerceModeNegotiate: 'Negotiate with the shop owner',
  commerceModeInquire: 'Ask about an unlisted item',
  commerceSendToTwin: 'Send to My Twin',
  commerceCancel: 'Cancel',
  commercePromoTitle: 'Promo ammo pack',
  commercePromoIntro: 'Generate your seed card and compliant copy, then share your shop.',
  commercePromoPoster: 'Seed card (PNG)',
  commercePromoDownload: 'Download PNG',
  commercePromoCopyImage: 'Copy image',
  commercePromoCopied: 'Copied',
  commercePromoTemplates: 'Compliant copy — one click to copy',
  commercePromoTemplate1Label: 'For collector groups',
  commercePromoTemplate2Label: 'For friends / social feed',
  commercePromoTemplate3Label: 'Answering “how do I buy?”',
  commercePromoQrCaption: 'Scan to open this shop (invite attribution included)',
  commercePromoNoItems: 'No featured items yet — the card still carries your shop link.',
  commercePromoClose: 'Close',
  commercePromoPosterFailed: 'Could not render the card image in this environment.',
  commercePromoClipboardFailed: 'Clipboard copy is unavailable here; use Download instead.',
  inviteHintTitle: 'Invited by a friend?',
  inviteHintBody: 'Add the inviting shop owner as a friend to keep your referral.',
  inviteHintAdd: 'Add as friend',
  inviteHintDismiss: 'Not now',
} as const;

const ZH: Record<keyof typeof EN, string> = {
  commerceConfirmTitle: '先跟你的 AI 助手确认',
  commerceConfirmIntroBuy: '确认后由你的 AI 接手这次购买意向。真正的付款还会有一次单独确认，这一步不会扣任何积分。',
  commerceConfirmIntroFriend: '确认后将打开宿主的私聊 / 加好友流程。在你再次确认之前，不会发出任何消息。',
  commerceFieldItem: '商品',
  commerceFieldCollection: '专辑',
  commerceFieldSeller: '卖家',
  commerceFieldOwner: '店主',
  commerceFieldPrice: '积分价',
  commerceFieldFiatPrice: '参考价',
  commerceFieldMode: '意向类型',
  commerceModeBuy: '用 ME 积分购买',
  commerceModeNegotiate: '找店主 AI 议价',
  commerceModeInquire: '求购未上架藏品',
  commerceSendToTwin: '交给我的 AI 助手处理',
  commerceCancel: '取消',
  commercePromoTitle: '分销弹药包',
  commercePromoIntro: '生成种草卡片与合规话术，把小店分享出去。',
  commercePromoPoster: '种草卡（PNG）',
  commercePromoDownload: '下载 PNG',
  commercePromoCopyImage: '复制图片',
  commercePromoCopied: '已复制',
  commercePromoTemplates: '合规话术 · 一键复制',
  commercePromoTemplate1Label: '发老藏家群',
  commercePromoTemplate2Label: '发朋友圈 / 普通群',
  commercePromoTemplate3Label: '答买家「怎么买」',
  commercePromoQrCaption: '扫码打开小店（含邀请归因）',
  commercePromoNoItems: '还没有精选商品——卡片仍会带上你的小店链接。',
  commercePromoClose: '关闭',
  commercePromoPosterFailed: '当前环境无法渲染卡片图片。',
  commercePromoClipboardFailed: '此处无法写入剪贴板，请改用下载。',
  inviteHintTitle: '朋友邀请来的？',
  inviteHintBody: '把邀请你的店主加为好友，即可保留邀请关系。',
  inviteHintAdd: '加为好友',
  inviteHintDismiss: '暂不',
};

const DICTS: Record<CommerceLang, Record<keyof typeof EN, string>> = { en: EN, zh: ZH };

export type CommerceI18nKey = keyof typeof EN;

export function tCommerce(key: CommerceI18nKey, language: unknown): string {
  const lang = resolveCommerceLang(language);
  const dict = DICTS[lang];
  return dict[key] || EN[key];
}

/** Format a milli-ME points price for display (`priceMeMilli / 1000`). */
export function formatMeMilli(priceMeMilli: number | undefined | null): string {
  if (typeof priceMeMilli !== 'number' || !Number.isFinite(priceMeMilli) || priceMeMilli < 0) return '';
  return `⚡ ${trimTrailingZeros(priceMeMilli / 1000)} ME`;
}

/** Format a CNY-cents reference price (`priceCnyCents / 100`). */
export function formatCnyCents(priceCnyCents: number | undefined | null): string {
  if (typeof priceCnyCents !== 'number' || !Number.isFinite(priceCnyCents) || priceCnyCents < 0) return '';
  return `¥${(priceCnyCents / 100).toFixed(2)}`;
}

function trimTrailingZeros(value: number): string {
  const fixed = value.toFixed(2);
  if (fixed.endsWith('.00')) return String(Math.round(value));
  return fixed.replace(/0$/, '').replace(/\.$/, '');
}

/**
 * The three compliant promo templates (REQ-E-04). Hard rule: none of these
 * strings may promise financial returns — only "free upgrade", "my AI runs
 * the shop for me", "on-chain provenance" angles. The banned-word test
 * scans this file; keep it that way.
 */
export interface PromoTemplateInput {
  ownerName: string;
  ownerGlobalMetaId: string;
  shopUri: string;
  featuredLine: string;
}

export function buildPromoTemplates(input: PromoTemplateInput, language: unknown): { key: CommerceI18nKey; text: string }[] {
  const lang = resolveCommerceLang(language);
  const owner = input.ownerName || input.ownerGlobalMetaId;
  if (lang === 'zh') {
    return [
      {
        key: 'commercePromoTemplate1Label',
        text: `以前老钱包里吃灰的 MetaBot Avatar，现在可以免费 1:1 升级成 AI 互联网上的数字商品了。不用懂技术，跟自己的 AI 说句话，就能开一家 24 小时自动接单的小店。我的小店刚开张：${input.shopUri}（店主 ${owner} · ${input.ownerGlobalMetaId}）`,
      },
      {
        key: 'commercePromoTemplate2Label',
        text: `给我的 AI 分身开了家数字商品小店：我睡觉的时候它自己帮我迎客、议价、发货。作品上链后删不掉、抄不走，欢迎来逛我的橱窗：${input.shopUri}${input.featuredLine ? `\n${input.featuredLine}` : ''}`,
      },
      {
        key: 'commercePromoTemplate3Label',
        text: `装好 IDBots 后不用自己找按钮，直接跟你的 AI 说「去 @${owner}（${input.ownerGlobalMetaId}）的小店帮我看看」，两个 AI 几秒钟就能自己交割完，你只管最后点一次确认。`,
      },
    ];
  }
  return [
    {
      key: 'commercePromoTemplate1Label',
      text: `Old MetaBot Avatars gathering dust in legacy wallets can now be upgraded 1:1, free, into AI-internet digital goods. No technical skills needed — tell your AI one sentence and it opens a shop that takes orders around the clock. My shop just opened: ${input.shopUri} (owner ${owner} · ${input.ownerGlobalMetaId})`,
    },
    {
      key: 'commercePromoTemplate2Label',
      text: `I opened a digital-goods shop run by my AI twin: it greets visitors, haggles and ships while I sleep. Works are anchored on-chain — they cannot be deleted or copied. Come browse: ${input.shopUri}${input.featuredLine ? `\n${input.featuredLine}` : ''}`,
    },
    {
      key: 'commercePromoTemplate3Label',
      text: `Once IDBots is installed you never hunt for buttons: just tell your AI "go check @${owner}'s (${input.ownerGlobalMetaId}) shop", the two AIs settle it in seconds, and you make the final confirmation.`,
    },
  ];
}

/** One-line summary of featured items used inside templates 2. */
export function buildFeaturedLine(items: { itemName: string; tokenIndex?: string }[], language: unknown): string {
  const names = items
    .slice(0, 3)
    .map((item) => (item.tokenIndex ? `#${item.tokenIndex} ${item.itemName}` : item.itemName))
    .filter(Boolean);
  if (!names.length) return '';
  return resolveCommerceLang(language) === 'zh' ? `精选：${names.join('、')}` : `Featured: ${names.join(', ')}`;
}
