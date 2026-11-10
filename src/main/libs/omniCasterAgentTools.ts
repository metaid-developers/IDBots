import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import type { ChainWriteCreatePin } from './postBuzzAgentTools';
import { chainWriteFailureDetail, feeAssistReceiptLines } from './chainFeeAssistReceipt';
import { PIN_REF_TOOL_RULE } from './chainPinRefGuard';

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

/**
 * Extension-to-MIME map for payload_file content-type inference, mirroring
 * the retired metabot-omni-caster skill's inferContentType().
 */
const PAYLOAD_FILE_MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain',
};

function inferContentType(filePath: string): string {
  return PAYLOAD_FILE_MIME_MAP[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** Binary content types are sent base64-encoded unless encoding was given. */
function isBinaryContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return (
    ct.startsWith('image/') ||
    ct.startsWith('video/') ||
    ct.startsWith('audio/') ||
    ct === 'application/octet-stream' ||
    ct.endsWith(';binary')
  );
}

/**
 * Human-readable success sheet mirroring the retired metabot-omni-caster
 * skill's result output (txid, pinId, cost, view link). Exposed for tests.
 */
export function formatCastResult(input: {
  pinId: string;
  txids: string[];
  totalCost: number;
  feeAssist?: unknown;
}): string {
  const lines: string[] = ['Pin cast on-chain.'];
  const txid = input.txids[0];
  if (txid) lines.push(`- txid: ${txid}`);
  if (input.pinId) lines.push(`- pinId: ${input.pinId}`);
  lines.push(`- cost: ${input.totalCost} sats`);
  lines.push(...feeAssistReceiptLines(input.feeAssist));
  if (input.pinId) {
    lines.push(`- view link: [pin://${input.pinId}](pin://${input.pinId})`);
  }
  return lines.join('\n');
}

/**
 * Inline MCP tool that casts one arbitrary MetaID protocol pin on-chain as
 * the session MetaBot. Registered for every cowork surface when the host
 * provides the createPin dep (see coworkRunner). Replaces the external
 * metabot-omni-caster skill; the 7-tuple shape (operation, path, encryption
 * '0', version 1.0, contentType, payload, optional base64 encoding) and the
 * /protocols/simplegroupchat content-encryption special case are unchanged.
 */
export function buildOmniCasterAgentTools(deps: {
  tool: SdkToolFactory;
  createPin: ChainWriteCreatePin;
  encryptGroupMessage: (message: string, groupId: string) => string;
  sessionId: string;
  resolveMetabotId: (sessionId: string) => number | undefined;
  /**
   * Registered MetaBot display-name resolver. The on-chain nickName of a
   * /protocols/simplegroupchat payload is always the registered name, never a
   * model-authored one (incident: sender_name "claude bot" on an otherwise
   * correct pin).
   */
  getMetabotDisplayName?: (metabotId: number) => string;
  /**
   * Owner-approval gate for payload_file (chainUploadGate.checkUploadAllowed):
   * returns null when the file may be published, or the denial message.
   * Publishing a local file on-chain is irreversible, so files outside the
   * session workspace need the owner's confirmation — same gate as the
   * upload tools.
   */
  gateLocalFile?: (filePath: string) => Promise<string | null>;
}): unknown[] {
  const { tool, createPin, encryptGroupMessage, sessionId, resolveMetabotId, gateLocalFile, getMetabotDisplayName } = deps;

  const omniCast = tool(
    'omni_cast',
    [
      'Cast one MetaID protocol pin (arbitrary 7-tuple broadcast) on-chain, as the MetaBot that owns this session.',
      'Use for protocol writes such as paylike, paycomment, simplenote, metaapp, /file, or any other /protocols/* path. Provide exactly one of payload (inline JSON/text) or payload_file (absolute local path; bytes are read and sent base64, with content_type inferred from the extension when omitted). JSON content types are parsed and re-serialized; for /protocols/simplegroupchat the payload content field is group-encrypted automatically (requires a non-empty groupId).',
      'Do NOT use for simplebuzz posts (use post_buzz), metafile:// file uploads (use upload_file), or group chat messaging (use group_chat).',
      'Writes permanently on-chain and costs transaction fees; omit encoding to auto-detect base64 for binary content types. A payload_file outside the session workspace requires the owner\'s explicit confirmation before it is published. Returns txid, pinId, cost in sats, and a pin:// view link.',
      PIN_REF_TOOL_RULE,
    ].join(' '),
    {
      path: z.string().min(1).describe('MetaID protocol path, e.g. /protocols/paylike'),
      payload: z
        .string()
        .optional()
        .describe('Inline payload string. JSON when content_type contains "json". Mutually exclusive with payload_file.'),
      payload_file: z
        .string()
        .optional()
        .describe('Absolute local file path; read and sent base64'),
      operation: z
        .enum(['create', 'modify', 'revoke'])
        .optional()
        .describe('MetaID operation. Default: create.'),
      content_type: z
        .string()
        .optional()
        .describe('Payload MIME type. Default: application/json; inferred from the file extension for payload_file.'),
      encoding: z
        .enum(['utf-8', 'base64'])
        .optional()
        .describe('Payload encoding. Default: utf-8, auto-detected to base64 for binary content types; always base64 for payload_file.'),
      network: z
        .enum(['mvc', 'doge', 'btc'])
        .optional()
        .describe('Write network. Default: mvc.'),
    },
    async (args: {
      path: string;
      payload?: string;
      payload_file?: string;
      operation?: 'create' | 'modify' | 'revoke';
      content_type?: string;
      encoding?: 'utf-8' | 'base64';
      network?: 'mvc' | 'doge' | 'btc';
    }) => {
      const pinPath = asString(args.path);
      if (!pinPath) {
        return textResult('omni_cast requires `path` (a MetaID protocol path, e.g. /protocols/paylike).', true);
      }

      const hasPayload = typeof args.payload === 'string' && args.payload !== '';
      const payloadFile = asString(args.payload_file);
      if (hasPayload && payloadFile) {
        return textResult('omni_cast accepts either `payload` or `payload_file`, not both.', true);
      }
      if (!hasPayload && !payloadFile) {
        return textResult('omni_cast requires exactly one of `payload` or `payload_file`.', true);
      }

      const metabotId = resolveMetabotId(sessionId);
      if (metabotId == null) {
        return textResult(
          'omni_cast could not determine which MetaBot owns this session, so there is no wallet/identity to cast with. Ask the user which MetaBot should cast the pin.',
          true,
        );
      }

      const operation = args.operation ?? 'create';
      let contentType = asString(args.content_type) || 'application/json';
      let cleanPayload: string;
      let encoding: 'utf-8' | 'base64' = args.encoding ?? 'utf-8';

      if (payloadFile) {
        if (!path.isAbsolute(payloadFile)) {
          return textResult(
            `omni_cast requires an ABSOLUTE local path for payload_file. Received a relative path: "${payloadFile}". Resolve it to an absolute path first.`,
            true,
          );
        }
        if (!fs.existsSync(payloadFile)) {
          return textResult(`omni_cast payload file not found: ${payloadFile}`, true);
        }
        if (gateLocalFile) {
          const denied = await gateLocalFile(payloadFile);
          if (denied) {
            return textResult(denied, true);
          }
        }
        try {
          cleanPayload = fs.readFileSync(payloadFile).toString('base64');
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return textResult(`omni_cast failed to read payload file ${payloadFile}: ${msg}`, true);
        }
        encoding = 'base64';
        if (!asString(args.content_type)) {
          contentType = inferContentType(payloadFile);
        }
      } else {
        const payloadStr = args.payload as string;
        if (contentType.toLowerCase().includes('json')) {
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(payloadStr) as Record<string, unknown>;
          } catch {
            return textResult('omni_cast payload is not valid JSON.', true);
          }
          if (pinPath === '/protocols/simplegroupchat') {
            const groupId = typeof parsed.groupId === 'string' ? parsed.groupId.trim() : '';
            if (!groupId) {
              return textResult(
                'omni_cast payload for /protocols/simplegroupchat must include a non-empty groupId.',
                true,
              );
            }
            if (typeof parsed.content !== 'string') {
              return textResult(
                'omni_cast payload for /protocols/simplegroupchat must include a string content field.',
                true,
              );
            }
            parsed.content = encryptGroupMessage(parsed.content, groupId);
            parsed.encryption = 'aes';
            // The on-chain nickName is always the acting MetaBot's registered
            // name — never a model-authored one (incident: sender_name
            // "claude bot" on an otherwise-correct pin).
            delete parsed.nickName;
            const displayName = getMetabotDisplayName?.(metabotId)?.trim();
            if (displayName) {
              parsed.nickName = displayName;
            }
          }
          cleanPayload = JSON.stringify(parsed);
        } else {
          cleanPayload = payloadStr;
          if (args.encoding == null && isBinaryContentType(contentType)) {
            encoding = 'base64';
          }
        }
      }

      const network = args.network ?? 'mvc';
      try {
        const result = await createPin(
          metabotId,
          {
            operation,
            path: pinPath,
            encryption: '0',
            version: '1.0',
            contentType,
            payload: cleanPayload,
            ...(encoding === 'base64' ? { encoding: 'base64' as const } : {}),
          },
          { network, origin: 'tool:omni_cast' },
        );
        return textResult(
          formatCastResult({
            pinId: result.pinId,
            txids: Array.isArray(result.txids) ? result.txids : [],
            totalCost: result.totalCost,
            feeAssist: result.feeAssist,
          }),
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`omni_cast failed: ${msg}${chainWriteFailureDetail(error)}`, true);
      }
    }
  );

  return [omniCast];
}
