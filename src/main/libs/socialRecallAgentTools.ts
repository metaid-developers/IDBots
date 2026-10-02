import { z } from 'zod';
import type { SocialPostItem, SocialCommentItem } from '../services/socialRecallService';
import { buildPinBrowserUri, markdownSelfLink } from './metawebUri';
import { truncateUtf16Units } from './llmSafeText';
import { readInputFromSocialPost, recordChainReadSafe } from './chainReadLedger';

/** A feed candidate from the Social Recall API, marked when authored by one of the user's own MetaBots. */
export type SocialPostCandidate = SocialPostItem & { isOwn?: boolean };

/**
 * Control surface the host (main.ts) provides for on-chain social search
 * tools. Backed by the metaso-p2p Social Recall API
 * (so.metaid.io/api/social/*); feed items are pre-marked with isOwn when the
 * author belongs to one of the user's MetaBots, and `scope=following` has its
 * `user` resolved host-side to the identity the user acts as.
 */
export type SocialRecallControl = {
  feed(input: {
    keywords?: string[];
    publisher?: string;
    publishers?: string[];
    since?: number;
    until?: number;
    sort?: 'newest' | 'hot';
    scope?: 'following';
    user?: string;
    chainName?: string;
    size?: number;
    cursor?: string;
  }): Promise<{ items: SocialPostCandidate[]; hasMore: boolean; nextCursor?: string | null }>;
  post(pinId: string): Promise<SocialPostCandidate>;
  comments(input: { pinId: string; size?: number; cursor?: string }): Promise<{
    items: SocialCommentItem[];
    hasMore: boolean;
    nextCursor?: string | null;
  }>;
};

/** Minimal shape of the claude-agent-sdk `tool()` helper we depend on. */
type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
) => unknown;

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function metaIdUri(globalMetaId: string): string {
  return `metaid://${globalMetaId}`;
}

function sanitizeLinkLabel(value: string): string {
  return value.replace(/[[\]]/g, '');
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${truncateUtf16Units(value, max)}…` : value;
}

/** UTC "YYYY-MM-DD HH:MM" — the Social Recall API timestamps are Unix seconds. */
function formatTime(ts: number): string {
  return ts ? `${new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
}

function postSnippet(post: SocialPostItem): string {
  const content = post.payload?.content?.trim();
  if (!content) return '(no text content)';
  return truncate(content.replace(/\s+/g, ' '), 120);
}

function authorName(post: SocialPostItem): string {
  return post.author.globalMetaId || post.author.address || post.author.metaId || 'unknown';
}

/** Ready-to-quote markdown bullets for social feed candidates. Post snippets are pin:// links, author names metaid:// links. */
export function formatSocialPostBullets(items: SocialPostItem[]): string {
  return items.map((item) => {
    const name = authorName(item);
    const label = sanitizeLinkLabel(name);
    const namePart = item.author.globalMetaId ? `[${label}](${metaIdUri(item.author.globalMetaId)})` : label;
    const own = (item as SocialPostCandidate).isOwn ? ' (your post)' : '';
    // The snippet links to pin://<pinId> — the ready-to-quote citation form;
    // the plain `pin:` id stays in the meta line for tool calls.
    const snippet = sanitizeLinkLabel(postSnippet(item));
    const snippetPart = item.pinId
      ? `[${snippet}](${buildPinBrowserUri({ pinId: item.pinId, path: item.protocolPath })})`
      : snippet;
    const head = `- **${snippetPart}** — by ${namePart} · ${formatTime(item.createdAt)}${own}`;
    const c = (v: number | null) => (v === null ? 'unavailable' : String(v));
  const meta = [
      `likes ${c(item.likeCount)}`,
      `comments ${c(item.commentCount)}`,
      `quotes ${c(item.quoteCount)}`,
      item.hotScore != null ? `hot ${item.hotScore}` : '',
      item.chainName ? `chain: ${item.chainName}` : '',
      item.pinId ? `pin: ${item.pinId}` : '',
    ].filter(Boolean).join(' | ');
    return meta ? `${head}\n  ${meta}` : head;
  }).join('\n');
}

/** Human-readable sheet for social_post_detail; the author line is a ready-to-quote metaid:// link. */
export function formatSocialPostDetail(post: SocialPostCandidate): string {
  const name = authorName(post);
  const label = sanitizeLinkLabel(name);
  const namePart = post.author.globalMetaId ? `[${label}](${metaIdUri(post.author.globalMetaId)})` : label;
  const own = post.isOwn ? ' (your post)' : '';
  const lines = [
    `Post ${post.pinId}:`,
    `- author: ${namePart}${own}`,
  ];
  if (post.chainName) lines.push(`- chain: ${post.chainName}`);
  if (post.protocolPath) lines.push(`- protocol: ${post.protocolPath}`);
  const viewLink = markdownSelfLink(buildPinBrowserUri({ pinId: post.pinId, path: post.protocolPath }));
  if (viewLink) lines.push(`- view: ${viewLink}`);
  if (post.createdAt) {
    const created = formatTime(post.createdAt);
    const updated = post.updatedAt && post.updatedAt !== post.createdAt ? formatTime(post.updatedAt) : '';
    lines.push(`- ${[`created: ${created}`, updated ? `updated: ${updated}` : ''].filter(Boolean).join(' | ')}`);
  }
  const cc = (v: number | null) => (v === null ? `unavailable (${post.countsCaliber})` : String(v));
  lines.push(`- engagement: likes ${cc(post.likeCount)} | comments ${cc(post.commentCount)} | quotes ${cc(post.quoteCount)} | donates ${cc(post.donateCount)}`);
  const content = post.payload?.content?.trim();
  if (content) lines.push(`- content: ${truncate(content, 1500)}`);
  if (post.payload?.attachments?.length) lines.push(`- attachments: ${post.payload.attachments.join(', ')}`);
  return lines.join('\n');
}

/** Ready-to-quote markdown bullets for post comments; author names are metaid:// links, comment pins pin:// links. */
export function formatSocialComments(items: SocialCommentItem[]): string {
  return items.map((comment) => {
    const name = comment.authorGlobalMetaId || comment.authorAddress || comment.authorMetaId || 'unknown';
    const label = sanitizeLinkLabel(name);
    const namePart = comment.authorGlobalMetaId ? `[${label}](${metaIdUri(comment.authorGlobalMetaId)})` : label;
    const content = comment.content ? truncate(comment.content.replace(/\s+/g, ' '), 200) : '(empty comment)';
    const pinPart = comment.pinId
      ? ` · pin: ${markdownSelfLink(buildPinBrowserUri({ pinId: comment.pinId }))}`
      : '';
    return `- ${content} — ${namePart} · ${formatTime(comment.timestamp)}${pinPart}`;
  }).join('\n');
}

/** Human-readable filter summary used in headers and empty-result messages. */
function filtersLabel(args: {
  query?: string;
  keywords?: string[];
  publisher?: string;
  publishers?: string[];
  sinceDays?: number;
  sort?: 'newest' | 'hot';
  following?: boolean;
  chainName?: string;
}, keywords: string[]): string {
  const parts: string[] = [];
  if (keywords.length) parts.push(`matching "${keywords.join('", "')}"`);
  const authors = [...(args.publisher ? [args.publisher] : []), ...(args.publishers ?? [])];
  if (authors.length) parts.push(`by ${authors.join(', ')}`);
  if (args.following) parts.push('by people you follow');
  if (args.sort === 'hot') parts.push('hot-ranked (last 48h)');
  if (args.sinceDays) parts.push(`within the last ${args.sinceDays} day(s)`);
  if (args.chainName) parts.push(`on ${args.chainName}`);
  return parts.length ? ` (${parts.join('; ')})` : '';
}

/** Merge the free-text query (split into OR terms) with the explicit keyword list. */
function mergeKeywords(query: string | undefined, keywords: string[] | undefined): string[] {
  const terms: string[] = [];
  for (const term of [...(query ? query.split(/[\s,，、]+/) : []), ...(keywords ?? [])]) {
    const trimmed = term.trim();
    if (trimmed && !terms.includes(trimmed)) terms.push(trimmed);
  }
  // Coarse recall only — cap the OR set so the request stays meaningful.
  return terms.slice(0, 5);
}

/**
 * Inline MCP tools that let any cowork session search on-chain social posts
 * (simplebuzz) through the MetaSo Social Recall API. Registered for every
 * session type when the host provides SocialRecallControl (see coworkRunner).
 * Triggering is intentionally loose: any "what's happening on-chain" phrasing
 * (topic, author, time window, hot, following) routes here; the tools return a
 * coarse candidate set and the Agent ranks/picks 3-5 for the user.
 */
export function buildSocialRecallAgentTools(deps: {
  tool: SdkToolFactory;
  socialRecall: SocialRecallControl;
  /** True for browser-type sessions (Bot Browser side panel with bot_browser_open_uri available). */
  openBestMatchInBrowser: boolean;
  /** Session attribution for the chain-read ledger; omit to disable recording. */
  sessionId?: string;
  resolveMetabotId?: (sessionId: string) => number | null | undefined;
}): unknown[] {
  const { tool, socialRecall, openBestMatchInBrowser, sessionId, resolveMetabotId } = deps;

  const candidatesGuidance = openBestMatchInBrowser
    ? 'Pick the 3-5 posts most relevant to the user and rank them by the user\'s interest — the list above is an unranked coarse candidate set. In your reply, REUSE the bullet lines above verbatim: post snippets MUST remain pin:// links, author names MUST remain metaid:// links, and pinIds must stay intact (they are needed for social_post_detail / social_post_comments). When the user wants to view an author, open their page with bot_browser_open_uri on the metaid:// URI (prefer newTab=true). Never invent posts, authors, or engagement numbers, and never turn an on-chain pin into a Web2 URL.'
    : 'Pick the 3-5 posts most relevant to the user and rank them by the user\'s interest — the list above is an unranked coarse candidate set. In your reply, REUSE the bullet lines above verbatim: post snippets MUST remain clickable pin:// links, author names MUST remain clickable metaid:// links, and pinIds must stay intact; never invent posts, authors, or engagement numbers, and never turn an on-chain pin into a Web2 URL. Do NOT open anything in the Bot Browser yourself: the user works in this chat view and will click links. For a post\'s aggregated engagement (likes/comments/quotes) use social_post_detail; for its replies use social_post_comments.';

  const detailGuidance = openBestMatchInBrowser
    ? 'Present these fields to the user with the author name kept as a clickable metaid:// link, and open the author\'s bot page with bot_browser_open_uri on that URI when the user asks to view them. For the post\'s replies use social_post_comments.'
    : 'Present these fields to the user with the author name kept as a clickable metaid:// link and the post cited via its pin:// view link. Do NOT open the Bot Browser yourself — the user clicks the links to view. For the post\'s replies use social_post_comments.';

  const searchSocialPosts = tool(
    'search_social_posts',
    'Search on-chain social posts (simplebuzz) — trigger liberally for post/buzz questions: topic, author, time window, hot, or following feed. Returns up to `size` coarse candidates newest-first (sort=hot: hot-ranked); you pick/rank the top 3-5. Filters AND-combine; multiple keywords/publishers match OR. Time via sinceDays (today=1) or since/until Unix seconds; publisher takes GlobalMetaID/MetaID/address (resolve names via search_metaids first). Engagement: social_post_detail; replies: social_post_comments. Not identity lookup (search_metaids) or apps (search_metaapps).',
    {
      query: z.string().optional(),
      keywords: z.array(z.string()).optional(),
      publisher: z.string().optional(),
      publishers: z.array(z.string()).optional(),
      sinceDays: z.number().optional(),
      since: z.number().optional(),
      until: z.number().optional(),
      sort: z.enum(['newest', 'hot']).optional(),
      following: z.boolean().optional(),
      chainName: z.string().optional(),
      size: z.number().optional(),
      cursor: z.string().optional(),
    },
    async (args: {
      query?: string;
      keywords?: string[];
      publisher?: string;
      publishers?: string[];
      sinceDays?: number;
      since?: number;
      until?: number;
      sort?: 'newest' | 'hot';
      following?: boolean;
      chainName?: string;
      size?: number;
      cursor?: string;
    }) => {
      const size = Math.min(50, Math.max(1, Math.floor(args.size ?? 20)));
      const keywords = mergeKeywords(args.query, args.keywords);
      const since = typeof args.sinceDays === 'number' && args.sinceDays > 0
        ? Math.floor(Date.now() / 1000) - Math.floor(args.sinceDays) * 86400
        : args.since;
      const request = {
        keywords,
        publisher: args.publisher,
        publishers: args.publishers,
        since,
        until: args.until,
        sort: args.sort,
        scope: args.following === true ? ('following' as const) : undefined,
        chainName: args.chainName,
        size,
        cursor: args.cursor,
      };
      try {
        let { items, hasMore, nextCursor } = await socialRecall.feed(request);
        // Empty-result degradation: drop the weakest (last) keyword once and retry.
        if (!items.length && !args.cursor && keywords.length > 1) {
          ({ items, hasMore, nextCursor } = await socialRecall.feed({
            ...request,
            keywords: keywords.slice(0, -1),
          }));
        }
        if (!items.length) {
          return textResult(`No on-chain social posts matched${filtersLabel(args, keywords)}. Tell the user honestly; do NOT invent posts.`);
        }
        const ordering = args.sort === 'hot' ? 'hot-ranked first' : 'newest first';
        const sections = [
          `${items.length} on-chain post(s)${filtersLabel(args, keywords)}, ${ordering}:`,
          formatSocialPostBullets(items),
          candidatesGuidance,
        ];
        if (hasMore && nextCursor) {
          sections.push(`More results are available — call search_social_posts again with cursor="${nextCursor}" if the user wants them.`);
        }
        return textResult(sections.join('\n\n'));
      } catch (error) {
        return textResult(`Social post search failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  );

  const socialPostDetail = tool(
    'social_post_detail',
    'Get one on-chain post by pinId: full content, author, timestamps, attachments, engagement (likes, comments, quotes, donates). For questions about a concrete post; find posts first with search_social_posts (your own latest: publisher=your identity, then detail its pinId). Reply thread: social_post_comments. Missing/hidden posts are reported honestly.',
    {
      pinId: z.string().min(1),
    },
    async (args: { pinId: string }) => {
      const pinId = (args.pinId ?? '').trim();
      if (!pinId) {
        return textResult('social_post_detail requires a non-empty pinId.', true);
      }
      try {
        const post = await socialRecall.post(pinId);
        // Fire-and-forget chain-read ledger entry (metabot_chain_reads);
        // only the full detail read is recorded — search and comments are not.
        recordChainReadSafe(readInputFromSocialPost(post, resolveMetabotId?.(sessionId ?? '')));
        return textResult([
          formatSocialPostDetail(post),
          detailGuidance,
        ].join('\n\n'));
      } catch (error) {
        if (error instanceof Error && error.name === 'SocialRecallNotFoundError') {
          return textResult(`No on-chain post matches pinId "${pinId}" (missing or hidden). Tell the user honestly; do NOT invent post data.`);
        }
        return textResult(`Failed to fetch the social post: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  );

  const socialPostComments = tool(
    'social_post_comments',
    'List a specific post\'s comments/replies by pinId (paged, size default 20) — for questions about a post\'s discussion. Aggregated engagement totals (likes/comments/quotes) are social_post_detail instead; to discover posts in the first place use search_social_posts (this needs an existing pinId).',
    {
      pinId: z.string().min(1),
      size: z.number().optional(),
      cursor: z.string().optional(),
    },
    async (args: { pinId: string; size?: number; cursor?: string }) => {
      const pinId = (args.pinId ?? '').trim();
      if (!pinId) {
        return textResult('social_post_comments requires a non-empty pinId.', true);
      }
      try {
        const { items, hasMore, nextCursor } = await socialRecall.comments({
          pinId,
          size: args.size,
          cursor: args.cursor,
        });
        if (!items.length) {
          return textResult(`No comments on post "${pinId}" yet. Tell the user honestly; do NOT invent comments.`);
        }
        const sections = [
          `${items.length} comment(s) on post "${pinId}":`,
          formatSocialComments(items),
          'Present these comments; keep author names as clickable metaid:// links and comment pins as pin:// links.',
        ];
        if (hasMore && nextCursor) {
          sections.push(`More comments are available — call social_post_comments again with cursor="${nextCursor}" if the user wants them.`);
        }
        return textResult(sections.join('\n\n'));
      } catch (error) {
        if (error instanceof Error && error.name === 'SocialRecallNotFoundError') {
          return textResult(`No on-chain post matches pinId "${pinId}" (missing or hidden). Tell the user honestly.`);
        }
        return textResult(`Failed to fetch the post comments: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  );

  return [searchSocialPosts, socialPostDetail, socialPostComments];
}
