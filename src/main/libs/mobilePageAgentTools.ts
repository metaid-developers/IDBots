/**
 * `mobile_open_page` — the server-mode tool behind the "移动端 bot 弹页能力"
 * work order (plan A).
 *
 * A bot hands over ONE local page (an .html file, or a directory whose
 * index.html is the entry), a title, an optional description, and an optional
 * TTL. The tool hosts it through the running gateway with an HMAC-signed page
 * token and returns a URL that the mobile chat renders as a tappable card.
 * Tapping the card opens the page in the phone's in-app browser.
 *
 * Boundaries (deliberate, see mobilePages.ts for the enforcement):
 *  - the page root must already live inside the tenant data root — this tool
 *    never copies, transforms or escapes files;
 *  - only HTML + static asset extensions are servable; size/count caps apply;
 *  - the token is the only address into the root, expires (default 24 h, max
 *    7 days) and is re-checked on every request (traversal refuses 404);
 *  - registered in SERVER MODE ONLY (`isServerMode()` at the mount seam), so
 *    the desktop tool surface is byte-identical to before.
 *
 * The card reaches the phone as a fenced `mobile-page-card` block inside the
 * bot's normal reply — the same chat path every other card (nft-card,
 * pay-card, escrow-card) uses, so no new message plumbing is introduced.
 */

import { z } from 'zod';
import fs from 'fs';
import type { GatewayPaths } from '../gateway/restrictions';
import { hostMobilePage } from '../gateway/mobilePages';
import { isGatewayError } from '../gateway/protocol';

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

/** Fence tag the chat surfaces render as a tappable page card. */
export const MOBILE_PAGE_CARD_FENCE_TAG = 'mobile-page-card';

/**
 * Host control surface, wired in main.ts from the running gateway context
 * (the same accessor `gateway:file:sign` uses). Null while the gateway is
 * not running — the tool then refuses instead of minting a dead URL.
 */
export type MobilePageAgentToolsControl = {
  /** Running gateway context (secret, tenant, paths) or null. */
  getGatewayContext: () => { secret: string; tenantId: string; paths: GatewayPaths } | null;
  /** realpath implementation; injected so tests never touch the real fs. */
  realpathSync?: (target: string) => string;
};

/** Payload shape of the fenced card (mirrored by mobilePageCardSyntax.ts). */
export interface MobilePageCardPayload {
  url: string;
  title: string;
  description?: string;
  expiresAt: number;
}

/** One-line guidance so the model puts the fence in its reply verbatim. */
export const MOBILE_PAGE_RESULT_HINT =
  'Now include this fenced block verbatim in your reply — the chat renders it as a tappable page card and the owner opens it on the phone:';

export function buildMobilePageCardFence(payload: MobilePageCardPayload): string {
  const body = JSON.stringify({
    url: payload.url,
    title: payload.title,
    ...(payload.description ? { description: payload.description } : {}),
    expiresAt: payload.expiresAt,
  });
  return ['```' + MOBILE_PAGE_CARD_FENCE_TAG, body, '```'].join('\n');
}

const MAX_TITLE_CHARS = 80;
const MAX_DESCRIPTION_CHARS = 200;

export function buildMobilePageAgentTools(deps: {
  tool: SdkToolFactory;
  control: MobilePageAgentToolsControl;
}): unknown[] {
  return [
    deps.tool(
      'mobile_open_page',
      [
        'Server mode only (the phone chat). Host ONE local page so the owner can open it on their phone in the in-app browser, and get back a tappable card.',
        'Pass `path` = an absolute local .html file, OR a directory whose `index.html` is the entry (a directory page serves its static assets too: css/js/images/fonts/video/audio; a single .html file is hosted ALONE and its sibling files are never exposed).',
        'Safety envelope: the page must live inside the tenant data root; only HTML/static-asset extensions are served; 8 MiB per file, 32 MiB and 256 files per page; dot files are never served.',
        'The link is a temporary grant: `ttlHours` defaults to 24 and is capped at 168 (7 days); a traversal attempt or an expired token answers 404.',
        'The tool already returns a ready-to-post fenced `mobile-page-card` block — include it VERBATIM in your reply (never rewrite the URL or invent one).',
        'Not for: putting a page on-chain or publishing a MetaApp (use the metaapp protocol), sending a downloadable document (the owner can use the file tools), or opening a page on the DESKTOP (desktop has its own surfaces; this tool exists only in server mode).',
      ].join(' '),
      {
        path: z.string().min(1).describe('Absolute local path: an .html/.htm file, or a directory with index.html.'),
        title: z.string().min(1).max(MAX_TITLE_CHARS).describe('Card title shown on the phone (keep it short).'),
        description: z.string().max(MAX_DESCRIPTION_CHARS).optional().describe('Optional one-line description under the title.'),
        ttlHours: z.number().positive().max(168).optional().describe('How long the link stays valid, in hours (default 24, max 168).'),
      },
      async (args: { path: string; title: string; description?: string; ttlHours?: number }) => {
        const context = deps.control.getGatewayContext();
        if (!context) {
          return textResult(
            'mobile_open_page refused: the mobile gateway is not running, so no page can be hosted. Nothing was created. (This tool is for the phone chat; a desktop session has no hosting surface.)',
            true,
          );
        }
        if (args.path.includes('\0')) {
          return textResult('mobile_open_page refused: path contains a NUL byte. Nothing was created.', true);
        }
        const hosted = hostMobilePage(
          {
            secret: context.secret,
            tenantId: context.tenantId,
            paths: context.paths,
            realpathSync: deps.control.realpathSync ?? fs.realpathSync,
          },
          { path: args.path, ttlHours: args.ttlHours },
        );
        if (isGatewayError(hosted)) {
          return textResult(
            `mobile_open_page refused: ${hosted.code} — ${hosted.message} Nothing was created.`,
            true,
          );
        }
        const payload: MobilePageCardPayload = {
          url: hosted.url,
          title: args.title.trim().slice(0, MAX_TITLE_CHARS),
          ...(args.description?.trim() ? { description: args.description.trim().slice(0, MAX_DESCRIPTION_CHARS) } : {}),
          expiresAt: hosted.expiresAt,
        };
        const receipt = [
          `Hosted "${payload.title}" — ${hosted.fileCount} file(s), ${hosted.totalBytes} bytes, entry ${hosted.entry}.`,
          `Card URL: ${hosted.url}`,
          `Expires: ${new Date(hosted.expiresAt).toISOString()} (${Math.round((hosted.expiresAt - Date.now()) / 3_600_000)}h from now).`,
          MOBILE_PAGE_RESULT_HINT,
          '',
          buildMobilePageCardFence(payload),
        ].join('\n');
        return textResult(receipt);
      },
    ),
  ];
}
