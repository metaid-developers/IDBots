import { z } from 'zod';
import { chainWriteFailureDetail, feeAssistReceiptLines } from './chainFeeAssistReceipt';

/**
 * Control surface the host (main.ts) provides for the send_private_chat tool.
 * Backed by the same create-pin pipeline the retired metabot-chat-privatechat
 * skill drove through RPC: resolve the peer's on-chain chatpubkey, derive the
 * ECDH shared secret, AES-encrypt the plaintext, and broadcast one
 * /protocols/simplemsg pin. All crypto and wallet handling stays host-side;
 * this tool handler is thin.
 */
export type PrivateChatControl = {
  send(input: {
    metabotId: number;
    toGlobalMetaId: string;
    content: string;
    replyPin?: string;
  }): Promise<{ txids: string[]; pinId: string; feeAssist?: unknown }>;
};

export type PrivateChatApprovalCategory =
  | 'friendship'
  | 'payment'
  | 'chain_write'
  | 'file_upload'
  | 'sensitive_data'
  | 'other';

export type PrivateChatApprovalControl = {
  request(input: {
    title: string;
    description: string;
    category: PrivateChatApprovalCategory;
  }): Promise<'approved' | 'denied'>;
  isAllowed?: () => boolean;
};

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

export function isOrdinaryPrivateChatApprovalSession(input: {
  sessionType?: string | null;
  sourceChannel?: string | null;
  hiddenFromSessionList?: boolean | null;
  memoryReadOnly?: boolean | null;
}): boolean {
  return input.sessionType === 'a2a'
    && input.sourceChannel === 'metaweb_private'
    && input.hiddenFromSessionList !== true
    && input.memoryReadOnly !== true;
}

/**
 * Inline MCP tool that sends one encrypted private MetaWeb message
 * (/protocols/simplemsg) to a globalMetaId. Registered for every cowork
 * surface when the host provides PrivateChatControl (see coworkRunner).
 * Replaces the external metabot-chat-privatechat skill; the on-chain
 * semantics (chatpubkey lookup, ECDH+AES encryption, pin tuple) are owned by
 * the host control and unchanged.
 */
export function buildPrivateChatAgentTools(deps: {
  tool: SdkToolFactory;
  control: PrivateChatControl;
  sessionId: string;
  resolveMetabotId: (sessionId: string) => number | undefined;
}): unknown[] {
  const { tool, control, sessionId, resolveMetabotId } = deps;

  const sendPrivateChat = tool(
    'send_private_chat',
    [
      'Send ONE encrypted private MetaWeb message (/protocols/simplemsg) to a globalMetaId. Pass the target and plaintext; the host resolves the peer chatpubkey, encrypts ECDH+AES, and broadcasts.',
      'Use when the user asks to DM or privately message someone on MetaWeb (idq1...), or a remote Bot/MetaBot asks for one private chat message.',
      'The message is on-chain and permanent — do NOT send content the user did not ask for.',
      'NOT for group chat (use group_chat) or public posts (use post_buzz).',
      'To pick a recipient, resolve the identity first — search_metaids by name, or list_online_bots for who is online right now; never invent a globalMetaId.',
      'Returns pinId, txids, and a browser pin link.',
    ].join(' '),
    {
      to: z.string().min(1).describe('Target globalMetaId (idq1...)'),
      content: z
        .string()
        .min(1)
        .describe('Plaintext message; host encrypts ECDH+AES before broadcast'),
      reply_pin: z
        .string()
        .optional()
        .describe('Pin id of the message being replied to, when this is a reply.'),
    },
    async (args: { to: string; content: string; reply_pin?: string }) => {
      const to = asString(args.to);
      if (!to) {
        return textResult('send_private_chat requires `to` (the target globalMetaId, idq1...).', true);
      }
      const content = asString(args.content);
      if (!content) {
        return textResult('send_private_chat requires `content` (the plaintext message).', true);
      }

      const metabotId = resolveMetabotId(sessionId);
      if (metabotId == null) {
        return textResult(
          'send_private_chat could not determine which MetaBot owns this session, so there is no wallet/identity to send with. Ask the user which MetaBot should send the message.',
          true,
        );
      }

      try {
        const result = await control.send({
          metabotId,
          toGlobalMetaId: to,
          content,
          replyPin: asString(args.reply_pin) || undefined,
        });
        return textResult(
          [
            'Private message sent.',
            `- pinId: ${result.pinId}`,
            `- txids: ${(result.txids ?? []).join(', ')}`,
            ...feeAssistReceiptLines(result.feeAssist),
            `- pin link: [pin://${result.pinId}](pin://${result.pinId})`,
          ].join('\n'),
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`Private message send failed: ${msg}${chainWriteFailureDetail(error)}`, true);
      }
    }
  );

  return [sendPrivateChat];
}

export function buildPrivateChatApprovalAgentTools(deps: {
  tool: SdkToolFactory;
  control: PrivateChatApprovalControl;
}): unknown[] {
  const { tool, control } = deps;
  const requestUserPermission = tool(
    'request_user_permission',
    [
      'Request the local owner\'s explicit, one-time permission before a sensitive action negotiated in an ordinary MetaBot private chat.',
      'Use before payments or transfers, paid or irreversible chain writes, large-file publication, sharing sensitive data, or another action whose cost, publicity, or irreversibility deserves human approval.',
      'Do NOT use for ordinary conversation, read-only work, or paid skill-service order execution.',
      'Provide a concrete title and a complete description of the exact action, target, amount/file/fees where relevant, and consequences. This tool only collects permission; it performs no action.',
      'Wait for the result. OWNER_APPROVED authorizes exactly the described action once; OWNER_DENIED forbids the action and any equivalent workaround. Never treat a missing, malformed, or failed result as approval.',
    ].join(' '),
    {
      title: z.string().min(1).max(80).describe('Short human-readable name of the exact action, for example "Transfer 10 SPACE to Peer Bot".'),
      description: z.string().min(1).max(2000).describe('Exact action and its consequences, including target, amount, file size, fees, publicity, and irreversibility where relevant.'),
      category: z.enum(['friendship', 'payment', 'chain_write', 'file_upload', 'sensitive_data', 'other']).optional().describe('Approval category; defaults to other.'),
    },
    async (args: { title: string; description: string; category?: PrivateChatApprovalCategory }) => {
      const title = asString(args.title);
      const description = asString(args.description);
      if (!title) return textResult('request_user_permission requires a concrete `title`.', true);
      if (!description) return textResult('request_user_permission requires a complete `description`.', true);
      if (control.isAllowed && !control.isAllowed()) {
        return textResult(
          'OWNER_APPROVAL_UNAVAILABLE: owner approval requests are available only in ordinary private chats, not skill-service order execution. No action was authorized.',
          true,
        );
      }
      const category = args.category ?? 'other';
      try {
        const outcome = await control.request({ title, description, category });
        if (outcome === 'approved') {
          return textResult([
            'OWNER_APPROVED',
            `The owner explicitly approved "${title}" once.`,
            'You may now perform exactly the described action. Do not expand its scope or repeat it without a new approval.',
          ].join('\n'));
        }
        return textResult([
          'OWNER_DENIED',
          `The owner explicitly rejected "${title}".`,
          'Do NOT perform the described action or any equivalent workaround. Acknowledge the refusal to the peer.',
        ].join('\n'));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult(`OWNER_APPROVAL_ERROR: ${message}. No action was authorized.`, true);
      }
    },
  );
  return [requestUserPermission];
}
