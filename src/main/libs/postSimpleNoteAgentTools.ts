import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import type { ChainWriteCreatePin } from './postBuzzAgentTools';
import type { MetaFileUploadControl } from './metaFileUploadAgentTools';
import { markdownSelfLink } from './metawebUri';
import { chainWriteFailureDetail, feeAssistReceiptLines } from './chainFeeAssistReceipt';
import { PIN_REF_TOOL_RULE } from './chainPinRefGuard';

/** Minimal shape of the claude-agent-sdk tool() helper we depend on. */
type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
) => unknown;

/**
 * Inline MCP tool that publishes a long-form note/article on-chain via the
 * simplenote protocol (docs/metaid_protocols/02-content-app.md §1), as the
 * MetaBot that owns this session. Same registration posture as post_buzz:
 * every cowork surface, host-provided createPin/upload deps (see
 * coworkRunner).
 *
 * Payload shape follows the on-chain reality (verified against live pins):
 * title/subtitle/coverImg(metafile://)/contentType/content/encryption/
 * createTime(ms number)/tags/attachments(metafile:// URIs), outer 7-tuple
 * version 1.0.1. Content defaults to Markdown; any MIME type is allowed.
 */
export function buildPostSimpleNoteAgentTools(deps: {
  tool: SdkToolFactory;
  createPin: ChainWriteCreatePin;
  /**
   * Upload function; the host passes the GATED wrapper from chainUploadGate
   * (wrapUploadWithGate) so files outside the session workspace require
   * owner approval before they are published.
   */
  uploadFile: MetaFileUploadControl['upload'];
  sessionId: string;
  resolveMetabotId: (sessionId: string) => number | undefined;
}): unknown[] {
  const { tool, createPin, uploadFile, sessionId, resolveMetabotId } = deps;

  function asString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  function textResult(text: string, isError = false) {
    return {
      content: [{ type: 'text' as const, text }],
      ...(isError ? { isError: true } : {}),
    };
  }

  function isMetafileUri(value: string): boolean {
    return value.trim().toLowerCase().startsWith('metafile://');
  }

  /**
   * Resolve one image/file reference for coverImg/attachments: local absolute
   * paths are uploaded on-chain (returns the metafile:// URI); existing
   * metafile:// URIs pass through untouched.
   */
  async function resolveFileReference(
    input: { metabotId: number; network: 'mvc' | 'doge' | 'btc' },
    raw: string,
    field: string,
  ): Promise<{ uri?: string; error?: string }> {
    const item = asString(raw);
    if (!item) return {};
    if (isMetafileUri(item)) return { uri: item };
    if (!path.isAbsolute(item)) {
      return {
        error: `post_simplenote requires ABSOLUTE local file paths for ${field}. Received a relative path: "${item}". Resolve it to an absolute path first, or pass an existing metafile:// URI.`,
      };
    }
    if (!fs.existsSync(item)) {
      return { error: `post_simplenote ${field} file not found: ${item}` };
    }
    try {
      // File upload does not support DOGE; keep DOGE only for the note write.
      const uploadNetwork = input.network === 'doge' ? 'mvc' : input.network;
      const result = await uploadFile({ metabotId: input.metabotId, filePath: item, network: uploadNetwork });
      const metafileUri = asString(result?.metafileUri);
      if (!metafileUri) {
        return { error: `post_simplenote failed to get a metafile URI for uploaded ${field}: ${item}` };
      }
      return { uri: metafileUri };
    } catch (error) {
      return { error: `post_simplenote failed to upload ${field} "${item}": ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  const postSimpleNote = tool(
    'post_simplenote',
    [
      'Publish a long-form note or article on-chain via the simplenote protocol, as the MetaBot that owns this session.',
      'Use to publish an article, blog post, tutorial, or long-form note on MetaWeb; content defaults to Markdown.',
      'Images/files inside the article must be ON-CHAIN, never Web2 hotlinks: upload first (local path as `cover`/`attachments`, or upload_file) and reference the returned metafile://<pinId> in the body — NEVER https:// URLs.',
      'Do NOT use for buzz (post_buzz), app publishing (bot_browser_publish_app), or plain file uploads (upload_file).',
      'Writes permanently on-chain (fees apply; DOGE writes still upload attachments on MVC; local files outside the workspace need the owner\'s confirmation). Returns pinId, txids, cost, and a pin:// link.',
      PIN_REF_TOOL_RULE,
    ].join(' '),
    {
      title: z.string().min(1).describe('Note title. Required and must not be empty.'),
      content: z.string().min(1).describe('Note body. Markdown by default (see content_type).'),
      subtitle: z.string().optional().describe('Optional subtitle shown under the title.'),
      cover: z
        .string()
        .optional()
        .describe('Cover image: local absolute file path (uploaded automatically) or an existing metafile:// URI.'),
      attachments: z
        .array(z.string())
        .optional()
        .describe('Extra files/images: local absolute file paths and/or metafile:// URIs.'),
      content_type: z
        .string()
        .optional()
        .describe('MIME type of the content field. Default: text/markdown.'),
      tags: z.array(z.string()).optional().describe('Topic tags for discovery.'),
      network: z
        .enum(['mvc', 'doge', 'btc'])
        .optional()
        .describe('Note write network. Default: mvc. DOGE is allowed for the note write only; files always upload on MVC.'),
    },
    async (args: {
      title: string;
      content: string;
      subtitle?: string;
      cover?: string;
      attachments?: string[];
      content_type?: string;
      tags?: string[];
      network?: 'mvc' | 'doge' | 'btc';
    }) => {
      const title = asString(args.title);
      const content = asString(args.content);
      if (!title || !content) {
        return textResult('post_simplenote requires both `title` and `content` (non-empty).', true);
      }

      const metabotId = resolveMetabotId(sessionId);
      if (metabotId == null) {
        return textResult(
          'post_simplenote could not determine which MetaBot owns this session, so there is no wallet/identity to publish with. Ask the user which MetaBot should publish the note.',
          true,
        );
      }

      const network = args.network ?? 'mvc';
      const contentType = asString(args.content_type) || 'text/markdown';
      const uploadScope = { metabotId, network };

      try {
        // Phase 1: resolve cover and attachments to metafile:// URIs. The
        // upload function itself is the gated wrapper (chainUploadGate):
        // files outside the session workspace throw when the owner declines.
        let coverImg = '';
        if (asString(args.cover)) {
          const cover = await resolveFileReference(uploadScope, args.cover ?? '', 'cover');
          if (cover.error) return textResult(cover.error, true);
          coverImg = cover.uri ?? '';
        }
        const attachments: string[] = [];
        for (const raw of args.attachments ?? []) {
          if (!asString(raw)) continue;
          const resolved = await resolveFileReference(uploadScope, raw, 'attachment');
          if (resolved.error) return textResult(resolved.error, true);
          if (resolved.uri) attachments.push(resolved.uri);
        }

        // Phase 2: publish the note (payload shape verified against live pins).
        const payload = JSON.stringify({
          title,
          subtitle: asString(args.subtitle),
          coverImg,
          contentType,
          content,
          encryption: '0',
          createTime: Date.now(),
          tags: (args.tags ?? []).map((tag) => asString(tag)).filter(Boolean),
          attachments,
        });
        const result = await createPin(
          metabotId,
          {
            operation: 'create',
            path: '/protocols/simplenote',
            encryption: '0',
            version: '1.0.1',
            contentType: 'application/json',
            payload,
          },
          { network, origin: 'tool:post_simplenote' },
        );
        return textResult(
          formatSimpleNoteResult({
            pinId: result.pinId,
            txids: Array.isArray(result.txids) ? result.txids : [],
            totalCost: result.totalCost,
            title,
            coverImg,
            attachments,
            feeAssist: result.feeAssist,
          }),
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`Note publish failed: ${msg}${chainWriteFailureDetail(error)}`, true);
      }
    }
  );

  return [postSimpleNote];
}

/**
 * Human-readable success sheet for post_simplenote. The view link follows the
 * MetaWeb URI convention (pin:// — never a Web2 viewer URL) so the model can
 * quote it verbatim. Exposed for tests.
 */
export function formatSimpleNoteResult(input: {
  pinId: string;
  txids: string[];
  totalCost: number;
  title: string;
  coverImg?: string;
  attachments: string[];
  feeAssist?: unknown;
}): string {
  const lines: string[] = ['Note published on-chain.'];
  if (input.pinId) lines.push(`- pinId: ${input.pinId}`);
  if (input.txids.length) lines.push(`- txids: ${input.txids.join(', ')}`);
  lines.push(`- title: ${input.title}`);
  lines.push(`- cost: ${input.totalCost} sats`);
  if (input.coverImg) lines.push(`- cover: ${input.coverImg}`);
  for (const uri of input.attachments) lines.push(`- attachment: ${uri}`);
  lines.push(...feeAssistReceiptLines(input.feeAssist));
  if (input.pinId) {
    lines.push(`- view link: ${markdownSelfLink(`pin://${input.pinId}`)}`);
  }
  return lines.join('\n');
}
