import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import type { MetaFileUploadControl } from './metaFileUploadAgentTools';
import { chainWriteFailureDetail, feeAssistReceiptLines } from './chainFeeAssistReceipt';
import { PIN_REF_TOOL_RULE } from './chainPinRefGuard';

/**
 * Chain-write surface the host (main.ts) provides for on-chain pin creation.
 * Backed by createPin() in services/metaidCore.ts — the same function the
 * /api/metaid/create-pin RPC endpoint calls. The service owns wallet/UTXO
 * selection, fee-rate resolution, and network routing; no routing logic
 * lives here. The narrower metaidData/options shapes mirror
 * MetaidDataPayload/CreatePinOptions with a string-only payload. feeAssist
 * carries the sponsor/self-paid fee-channel trace when the write ran in
 * traffic mode (undefined for plain self-paid writes).
 */
export type ChainWriteCreatePin = (
  metabotId: number,
  metaidData: {
    operation: 'init' | 'create' | 'modify' | 'revoke';
    path?: string;
    encryption?: '0' | '1' | '2';
    version?: string;
    contentType?: string;
    payload: string;
    encoding?: 'utf-8' | 'base64';
  },
  options?: { feeRate?: number; network?: 'mvc' | 'doge' | 'btc' | 'opcat'; origin?: string },
) => Promise<{ txids: string[]; pinId: string; totalCost: number; feeAssist?: unknown }>;

/** Minimal shape of the claude-agent-sdk tool() helper we depend on. */
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

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isMetafileUri(value: string): boolean {
  return value.trim().toLowerCase().startsWith('metafile://');
}

/**
 * Human-readable success sheet mirroring the retired metabot-post-buzz skill's
 * result output (pinId, txids, cost, attachment URIs, view link). Exposed for
 * tests.
 */
export function formatBuzzResult(input: {
  pinId: string;
  txids: string[];
  totalCost: number;
  attachments: string[];
  feeAssist?: unknown;
}): string {
  const lines: string[] = ['Buzz posted on-chain.'];
  if (input.pinId) lines.push(`- pinId: ${input.pinId}`);
  if (input.txids.length) lines.push(`- txids: ${input.txids.join(', ')}`);
  lines.push(`- cost: ${input.totalCost} sats`);
  for (const uri of input.attachments) lines.push(`- attachment: ${uri}`);
  lines.push(...feeAssistReceiptLines(input.feeAssist));
  if (input.pinId) {
    lines.push(`- view link: [pin://${input.pinId}](pin://${input.pinId})`);
  }
  return lines.join('\n');
}

/**
 * Inline MCP tool that posts a SimpleBuzz (short text + optional attachments)
 * on-chain as the session MetaBot. Registered for every cowork surface when
 * the host provides the createPin/upload deps (see coworkRunner). Replaces
 * the external metabot-post-buzz skill; the protocol shape
 * (/protocols/simplebuzz, JSON payload with content/contentType/attachments/
 * quotePin, version 1.0) is unchanged. Local attachment files are uploaded
 * through the same unified upload flow the upload_file tool uses.
 */
export function buildPostBuzzAgentTools(deps: {
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

  const postBuzz = tool(
    'post_buzz',
    [
      'Post a buzz (short text post with optional attachments) on-chain via the simplebuzz protocol, as the MetaBot that owns this session.',
      'Use to post a buzz — a short on-chain message or development-journal entry. Attachments accept local paths (auto-uploaded) and metafile:// URIs; quote_pin quotes/reposts an existing buzz.',
      'Do NOT use for file-only uploads (upload_file), paylike/paycomment (omni_cast), or chat messages.',
      'Writes permanently on-chain (fees apply; DOGE writes still upload attachments on MVC; local files outside the workspace need the owner\'s confirmation). Returns pinId, txids, cost, attachment metafile URIs, and a pin:// link.',
      PIN_REF_TOOL_RULE,
    ].join(' '),
    {
      content: z.string().min(1).describe('Buzz text content. Required and must not be empty.'),
      attachments: z
        .array(z.string())
        .optional()
        .describe('Local absolute file paths and/or metafile:// URIs'),
      content_type: z
        .string()
        .optional()
        .describe('MIME type of the content field. Default: text/plain;utf-8.'),
      network: z
        .enum(['mvc', 'doge', 'btc'])
        .optional()
        .describe('Buzz write network. Default: mvc. DOGE is allowed for the buzz write only; attachments always upload on MVC.'),
      quote_pin: z
        .string()
        .optional()
        .describe('pinId of the buzz being quoted/reposted'),
    },
    async (args: {
      content: string;
      attachments?: string[];
      content_type?: string;
      network?: 'mvc' | 'doge' | 'btc';
      quote_pin?: string;
    }) => {
      const content = asString(args.content);
      if (!content) {
        return textResult('post_buzz requires `content` (non-empty buzz text).', true);
      }

      const metabotId = resolveMetabotId(sessionId);
      if (metabotId == null) {
        return textResult(
          'post_buzz could not determine which MetaBot owns this session, so there is no wallet/identity to post with. Ask the user which MetaBot should post the buzz.',
          true,
        );
      }

      const network = args.network ?? 'mvc';
      const contentType = asString(args.content_type) || 'text/plain;utf-8';
      // File upload does not support DOGE; keep DOGE only for the final buzz write.
      const attachmentNetwork = network === 'doge' ? 'mvc' : network;

      try {
        // Phase 1: upload local attachments and collect metafile:// URIs;
        // existing metafile:// URIs pass through untouched. The upload
        // function itself is the gated wrapper (chainUploadGate): files
        // outside the session workspace throw when the owner declines.
        const attachments: string[] = [];
        for (const raw of args.attachments ?? []) {
          const item = asString(raw);
          if (!item) continue;
          if (isMetafileUri(item)) {
            attachments.push(item);
            continue;
          }
          if (!path.isAbsolute(item)) {
            return textResult(
              `post_buzz requires ABSOLUTE local file paths for attachments. Received a relative path: "${item}". Resolve it to an absolute path first, or pass an existing metafile:// URI.`,
              true,
            );
          }
          if (!fs.existsSync(item)) {
            return textResult(`post_buzz attachment file not found: ${item}`, true);
          }
          const result = await uploadFile({ metabotId, filePath: item, network: attachmentNetwork });
          const metafileUri = asString(result?.metafileUri);
          if (!metafileUri) {
            return textResult(
              `post_buzz failed to get a metafile URI for uploaded attachment: ${item}`,
              true,
            );
          }
          attachments.push(metafileUri);
        }

        // Phase 2: post the SimpleBuzz with attachments.
        const payload = JSON.stringify({
          content,
          contentType,
          attachments,
          quotePin: asString(args.quote_pin),
        });
        const result = await createPin(
          metabotId,
          {
            operation: 'create',
            path: '/protocols/simplebuzz',
            encryption: '0',
            version: '1.0',
            contentType: 'application/json',
            payload,
          },
          { network, origin: 'tool:post_buzz' },
        );
        return textResult(
          formatBuzzResult({
            pinId: result.pinId,
            txids: Array.isArray(result.txids) ? result.txids : [],
            totalCost: result.totalCost,
            attachments,
            feeAssist: result.feeAssist,
          }),
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`Buzz post failed: ${msg}${chainWriteFailureDetail(error)}`, true);
      }
    }
  );

  return [postBuzz];
}
