import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import type { ChainWriteCreatePin } from './postBuzzAgentTools';
import type { MetaFileUploadControl } from './metaFileUploadAgentTools';
import { markdownSelfLink } from './metawebUri';
import { chainWriteFailureDetail, feeAssistReceiptLines } from './chainFeeAssistReceipt';
import { PIN_REF_TOOL_RULE } from './chainPinRefGuard';
import {
  listSimpleQaAnswers,
  recordSimpleQaAnswer,
  type SimpleQaAnswerLedgerEntry,
} from './simpleQaAnswerLedger';
import type { QaAnswerItem } from '../services/qaRecallService';

/** Minimal shape of the claude-agent-sdk tool() helper we depend on. */
type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
) => unknown;

/**
 * Inline MCP tools for the on-chain Q&A protocols (docs/metaid_protocols/
 * 08-qanda.md): post_simplequestion (/protocols/simplequestion 1.0.0) and
 * post_simpleanswer (/protocols/simpleanswer 1.0.0). Same registration
 * posture as post_buzz / post_simplenote: every cowork surface, host-provided
 * createPin/upload deps (see coworkRunner).
 *
 * Payload design follows declarative minimalism: only what a reader cannot
 * derive is required, no self-declared timestamps (block time and indexer
 * witness time are authoritative), and empty optional fields are omitted
 * entirely instead of written as empty strings/arrays.
 */
export function buildPostSimpleQaAgentTools(deps: {
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
  /** Host/test overrides for the local answer ledger (defaults: kv-backed module ledger). */
  listPriorAnswers?: (metabotId: number, questionPinId: string) => SimpleQaAnswerLedgerEntry[];
  recordAnswer?: (metabotId: number, questionPinId: string, entry: SimpleQaAnswerLedgerEntry) => void;
  /**
   * Cross-machine prior-answer lookup against the on-chain Q&A index
   * (/api/qa/questions/:pinId/answers?publisher=…). When provided together
   * with resolveActingGlobalMetaId, the already-answered notice prefers index
   * data (complete across machines) and falls back to the local ledger when
   * the index is unreachable.
   */
  fetchPriorAnswersRemote?: (input: { questionPinId: string; publisher: string }) => Promise<QaAnswerItem[]>;
  resolveActingGlobalMetaId?: (sessionId: string) => string | undefined;
}): unknown[] {
  const {
    tool,
    createPin,
    uploadFile,
    sessionId,
    resolveMetabotId,
    listPriorAnswers = listSimpleQaAnswers,
    recordAnswer = recordSimpleQaAnswer,
    fetchPriorAnswersRemote,
    resolveActingGlobalMetaId,
  } = deps;

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

  /** Resolve one attachment reference: local absolute paths are uploaded on-chain; metafile:// URIs pass through. */
  async function resolveFileReference(
    input: { metabotId: number; network: 'mvc' | 'doge' | 'btc' },
    raw: string,
    toolName: string,
    field: string,
  ): Promise<{ uri?: string; error?: string }> {
    const item = asString(raw);
    if (!item) return {};
    if (isMetafileUri(item)) return { uri: item };
    if (!path.isAbsolute(item)) {
      return {
        error: `${toolName} requires ABSOLUTE local file paths for ${field}. Received a relative path: "${item}". Resolve it to an absolute path first, or pass an existing metafile:// URI.`,
      };
    }
    if (!fs.existsSync(item)) {
      return { error: `${toolName} ${field} file not found: ${item}` };
    }
    try {
      // File upload does not support DOGE; keep DOGE only for the pin write.
      const uploadNetwork = input.network === 'doge' ? 'mvc' : input.network;
      const result = await uploadFile({ metabotId: input.metabotId, filePath: item, network: uploadNetwork });
      const metafileUri = asString(result?.metafileUri);
      if (!metafileUri) {
        return { error: `${toolName} failed to get a metafile URI for uploaded ${field}: ${item}` };
      }
      return { uri: metafileUri };
    } catch (error) {
      return {
        error: `${toolName} failed to upload ${field} "${item}": ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Collect the acting bot's prior answers to one question. The on-chain Q&A
   * index is authoritative when reachable (complete across machines); the
   * local ledger covers indexer outages and pins too fresh to be indexed.
   * Both are FACTS for the bot's own decision — never a gate.
   */
  async function collectPriorAnswers(
    metabotId: number,
    questionPinId: string,
  ): Promise<{ answers: SimpleQaAnswerLedgerEntry[]; source: 'index' | 'local' }> {
    const local = listPriorAnswers(metabotId, questionPinId);
    if (fetchPriorAnswersRemote && resolveActingGlobalMetaId) {
      const publisher = resolveActingGlobalMetaId(sessionId);
      if (publisher) {
        try {
          const remote = await fetchPriorAnswersRemote({ questionPinId, publisher });
          const seen = new Set<string>();
          const answers: SimpleQaAnswerLedgerEntry[] = [];
          for (const item of remote) {
            if (!item?.pinId || seen.has(item.pinId)) continue;
            seen.add(item.pinId);
            answers.push({
              answerPinId: item.pinId,
              content: item.summary || '(indexed answer; open it via the view link)',
              postedAt: item.createdAt ? item.createdAt * 1000 : 0,
              network: item.chainName || '',
            });
          }
          for (const entry of local) {
            if (!seen.has(entry.answerPinId)) {
              seen.add(entry.answerPinId);
              answers.push(entry);
            }
          }
          return { answers, source: 'index' };
        } catch (error) {
          // Unknown question (not indexed) has no indexed answers: keep it as
          // an empty-but-authoritative result. Other failures fall back to
          // the local ledger below.
          if (!(error instanceof Error && error.name === 'QaRecallNotFoundError')) {
            return { answers: local, source: 'local' };
          }
          return { answers: local, source: 'index' };
        }
      }
    }
    return { answers: local, source: 'local' };
  }

  const postSimpleQuestion = tool(
    'post_simplequestion',
    [
      'Publish a question on-chain via the simplequestion protocol, as the MetaBot that owns this session.',
      'Use for knowledge gaps you cannot resolve yourself (stuck task, repeated failures). A clear specific title alone is a complete question; `content` and `tags` are optional context.',
      'The title MUST be an actual question ending with a question mark — `?` or full-width `？` (the tool rejects titles without one).',
      'Attachments (local absolute paths) upload automatically; error screenshots help. Returns the question pinId — answers reference it via `answer_to`; keep it to check answers later.',
      'Do NOT use for notes/articles (post_simplenote), buzz (post_buzz), or plain file uploads (upload_file).',
      'Writes permanently on-chain (fees apply; DOGE writes still upload attachments on MVC; local files outside the workspace need the owner\'s confirmation). Returns pinId, txids, cost, and a pin:// link.',
      PIN_REF_TOOL_RULE,
    ].join(' '),
    {
      title: z.string().min(1).describe('Question title, plain text, MUST end with a question mark (`?` or `？`). Required — the only required field.'),
      content: z.string().optional().describe('Optional question description/supplement (markdown).'),
      tags: z.array(z.string()).optional().describe('Topic tags for discovery.'),
      content_type: z
        .string()
        .optional()
        .describe('MIME type of the content field. Default: text/markdown. Ignored when content is empty.'),
      attachments: z
        .array(z.string())
        .optional()
        .describe('Files/images (error screenshots etc.): local absolute file paths and/or metafile:// URIs.'),
      network: z
        .enum(['mvc', 'doge', 'btc'])
        .optional()
        .describe('Write network. Default: mvc. DOGE is allowed for the pin write only; files always upload on MVC.'),
    },
    async (args: {
      title: string;
      content?: string;
      tags?: string[];
      content_type?: string;
      attachments?: string[];
      network?: 'mvc' | 'doge' | 'btc';
    }) => {
      const title = asString(args.title);
      if (!title) {
        return textResult(
          'post_simplequestion requires `title` (non-empty). The description `content` is optional — a title alone is a complete question.',
          true,
        );
      }
      // A title IS a question (ZhiHu/Quora convention): without the ending
      // mark the surface slowly degrades into a mixed notice board. The
      // chain itself stays permissionless — this is the IDBots tool contract,
      // mirrored by the Q&A index (see docs/metaid_protocols/08-qanda.md).
      if (!/[?？]$/.test(title)) {
        return textResult(
          'post_simplequestion `title` must end with a question mark — half-width `?` or full-width `？` (a title is a question, like ZhiHu/Quora). Rewrite the title as a question and retry; nothing was published.',
          true,
        );
      }

      const metabotId = resolveMetabotId(sessionId);
      if (metabotId == null) {
        return textResult(
          'post_simplequestion could not determine which MetaBot owns this session, so there is no wallet/identity to publish with. Ask the user which MetaBot should publish the question.',
          true,
        );
      }

      const network = args.network ?? 'mvc';
      const uploadScope = { metabotId, network };

      try {
        const attachments: string[] = [];
        for (const raw of args.attachments ?? []) {
          if (!asString(raw)) continue;
          const resolved = await resolveFileReference(uploadScope, raw, 'post_simplequestion', 'attachment');
          if (resolved.error) return textResult(resolved.error, true);
          if (resolved.uri) attachments.push(resolved.uri);
        }

        // Declarative minimalism: empty optional fields are omitted entirely.
        const payloadObject: Record<string, unknown> = { title };
        const content = asString(args.content);
        if (content) {
          payloadObject.content = content;
          payloadObject.contentType = asString(args.content_type) || 'text/markdown';
        }
        const tags = (args.tags ?? []).map((tag) => asString(tag)).filter(Boolean);
        if (tags.length) payloadObject.tags = tags;
        if (attachments.length) payloadObject.attachments = attachments;

        const result = await createPin(
          metabotId,
          {
            operation: 'create',
            path: '/protocols/simplequestion',
            encryption: '0',
            version: '1.0.0',
            contentType: 'application/json',
            payload: JSON.stringify(payloadObject),
          },
          { network, origin: 'tool:post_simplequestion' },
        );
        return textResult(
          formatSimpleQuestionResult({
            pinId: result.pinId,
            txids: Array.isArray(result.txids) ? result.txids : [],
            totalCost: result.totalCost,
            title,
            attachments,
            feeAssist: result.feeAssist,
          }),
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`Question publish failed: ${msg}${chainWriteFailureDetail(error)}`, true);
      }
    }
  );

  const postSimpleAnswer = tool(
    'post_simpleanswer',
    [
      'Answer a question published on-chain via the simplequestion protocol, as the MetaBot that owns this session.',
      '`answer_to` must be the pinId of a simplequestion pin. Answer only with something clear and useful — ranking is by community likes.',
      'If you already answered from this host, the tool returns your previous answers WITHOUT publishing; re-call with allow_repeat=true only when the new answer substantially improves the old one (small additions belong in a comment on the existing answer).',
      'Do NOT use for buzz (post_buzz), notes/articles (post_simplenote), or plain file uploads (upload_file).',
      'Writes permanently on-chain (fees apply; DOGE writes still upload attachments on MVC; local files outside the workspace need the owner\'s confirmation). Returns pinId, txids, cost, and a pin:// link.',
      PIN_REF_TOOL_RULE,
    ].join(' '),
    {
      answer_to: z.string().min(1).describe('pinId of the simplequestion pin being answered. Required.'),
      content: z.string().min(1).describe('Answer body. Markdown by default (see content_type).'),
      tags: z.array(z.string()).optional().describe('Topic tags.'),
      content_type: z
        .string()
        .optional()
        .describe('MIME type of the content field. Default: text/markdown.'),
      attachments: z
        .array(z.string())
        .optional()
        .describe('Files/images: local absolute file paths and/or metafile:// URIs.'),
      allow_repeat: z
        .boolean()
        .optional()
        .describe('Set true to publish even when this host already recorded a previous answer from you to this question.'),
      network: z
        .enum(['mvc', 'doge', 'btc'])
        .optional()
        .describe('Write network. Default: mvc. DOGE is allowed for the pin write only; files always upload on MVC.'),
    },
    async (args: {
      answer_to: string;
      content: string;
      tags?: string[];
      content_type?: string;
      attachments?: string[];
      allow_repeat?: boolean;
      network?: 'mvc' | 'doge' | 'btc';
    }) => {
      const answerTo = asString(args.answer_to);
      const content = asString(args.content);
      if (!answerTo || !content) {
        return textResult(
          'post_simpleanswer requires both `answer_to` (pinId of the question pin) and `content` (non-empty).',
          true,
        );
      }

      const metabotId = resolveMetabotId(sessionId);
      if (metabotId == null) {
        return textResult(
          'post_simpleanswer could not determine which MetaBot owns this session, so there is no wallet/identity to publish with. Ask the user which MetaBot should publish the answer.',
          true,
        );
      }

      const network = args.network ?? 'mvc';
      const uploadScope = { metabotId, network };

      try {
        // Fact-first repeat notice (host bookkeeping only, never a protocol
        // constraint): surface prior answers BEFORE spending sats; the bot
        // decides whether to proceed with allow_repeat=true.
        const { answers: priorAnswers, source: priorSource } = await collectPriorAnswers(metabotId, answerTo);
        if (priorAnswers.length && args.allow_repeat !== true) {
          return textResult(formatAlreadyAnsweredNotice(answerTo, priorAnswers, priorSource));
        }

        const attachments: string[] = [];
        for (const raw of args.attachments ?? []) {
          if (!asString(raw)) continue;
          const resolved = await resolveFileReference(uploadScope, raw, 'post_simpleanswer', 'attachment');
          if (resolved.error) return textResult(resolved.error, true);
          if (resolved.uri) attachments.push(resolved.uri);
        }

        const payloadObject: Record<string, unknown> = { answerTo, content };
        const contentType = asString(args.content_type);
        if (contentType) payloadObject.contentType = contentType;
        const tags = (args.tags ?? []).map((tag) => asString(tag)).filter(Boolean);
        if (tags.length) payloadObject.tags = tags;
        if (attachments.length) payloadObject.attachments = attachments;

        const result = await createPin(
          metabotId,
          {
            operation: 'create',
            path: '/protocols/simpleanswer',
            encryption: '0',
            version: '1.0.0',
            contentType: 'application/json',
            payload: JSON.stringify(payloadObject),
          },
          { network, origin: 'tool:post_simpleanswer' },
        );

        recordAnswer(metabotId, answerTo, {
          answerPinId: result.pinId,
          content,
          postedAt: Date.now(),
          network,
        });

        return textResult(
          formatSimpleAnswerResult({
            pinId: result.pinId,
            txids: Array.isArray(result.txids) ? result.txids : [],
            totalCost: result.totalCost,
            questionPinId: answerTo,
            attachments,
            priorAnswerCount: priorAnswers.length,
            feeAssist: result.feeAssist,
          }),
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`Answer publish failed: ${msg}${chainWriteFailureDetail(error)}`, true);
      }
    }
  );

  return [postSimpleQuestion, postSimpleAnswer];
}

/**
 * Human-readable success sheet for post_simplequestion. The view link follows
 * the MetaWeb URI convention (pin:// — never a Web2 viewer URL). Exposed for
 * tests.
 */
export function formatSimpleQuestionResult(input: {
  pinId: string;
  txids: string[];
  totalCost: number;
  title: string;
  attachments: string[];
  feeAssist?: unknown;
}): string {
  const lines: string[] = ['Question published on-chain.'];
  if (input.pinId) {
    lines.push(`- question pinId: ${input.pinId}`);
    lines.push('- others answer this question by referencing this pinId as `answer_to` in post_simpleanswer');
  }
  if (input.txids.length) lines.push(`- txids: ${input.txids.join(', ')}`);
  lines.push(`- title: ${input.title}`);
  lines.push(`- cost: ${input.totalCost} sats`);
  for (const uri of input.attachments) lines.push(`- attachment: ${uri}`);
  lines.push(...feeAssistReceiptLines(input.feeAssist));
  if (input.pinId) {
    lines.push(`- view link: ${markdownSelfLink(`pin://${input.pinId}`)}`);
  }
  return lines.join('\n');
}

/**
 * Human-readable success sheet for post_simpleanswer. Exposed for tests.
 */
export function formatSimpleAnswerResult(input: {
  pinId: string;
  txids: string[];
  totalCost: number;
  questionPinId: string;
  attachments: string[];
  priorAnswerCount: number;
  feeAssist?: unknown;
}): string {
  const lines: string[] = ['Answer published on-chain.'];
  if (input.pinId) lines.push(`- answer pinId: ${input.pinId}`);
  if (input.txids.length) lines.push(`- txids: ${input.txids.join(', ')}`);
  lines.push(`- question pinId: ${input.questionPinId}`);
  lines.push(`- cost: ${input.totalCost} sats`);
  for (const uri of input.attachments) lines.push(`- attachment: ${uri}`);
  lines.push(...feeAssistReceiptLines(input.feeAssist));
  if (input.priorAnswerCount > 0) {
    lines.push(`- note: this is answer #${input.priorAnswerCount + 1} you published to this question from this host`);
  }
  if (input.pinId) {
    lines.push(`- view link: ${markdownSelfLink(`pin://${input.pinId}`)}`);
  }
  return lines.join('\n');
}

/**
 * Informational (non-error) notice shown when prior answers exist. States
 * facts and options; the publish/not-publish decision stays with the bot.
 * `source` says where the facts came from: the on-chain Q&A index (complete
 * across machines) or this host's local records (index unreachable).
 * Exposed for tests.
 */
export function formatAlreadyAnsweredNotice(
  questionPinId: string,
  answers: SimpleQaAnswerLedgerEntry[],
  source: 'index' | 'local' = 'local',
): string {
  const lines: string[] = [
    `Not published yet — you already have ${answers.length === 1 ? '1 previous answer' : `${answers.length} previous answers`} to question ${questionPinId}:`,
  ];
  for (const answer of answers) {
    lines.push(`- answer pinId: ${answer.answerPinId}${answer.network ? ` (${answer.network})` : ''}`);
    const excerpt = answer.content.length > 400 ? `${answer.content.slice(0, 400)}…` : answer.content;
    lines.push(`  content: ${excerpt.replace(/\n+/g, ' ')}`);
    lines.push(`  view link: ${markdownSelfLink(`pin://${answer.answerPinId}`)}`);
  }
  lines.push(
    source === 'index'
      ? 'Source: on-chain Q&A index — complete across machines.'
      : 'Source: this host\'s local posting records only (the on-chain Q&A index was unreachable).',
  );
  lines.push(
    'The protocol allows multiple answers per bot and nothing here forbids another one — publishing again is your decision. If the new answer substantially improves the old one, call post_simpleanswer again with allow_repeat=true. For small additions, a PayComment on your existing answer (omni_cast with /protocols/paycomment) usually serves better.',
  );
  return lines.join('\n');
}
