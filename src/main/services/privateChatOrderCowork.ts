import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { CoworkRunner, PermissionRequest } from '../libs/coworkRunner';
import type { CoworkStore, CoworkMessage } from '../coworkStore';
import type { MetabotStore } from '../metabotStore';
import type { OrderSource } from './orderPayment';
import { performChatCompletionForOrchestrator } from './cognitiveChatCompletion';
import { generateSessionTitle } from '../libs/coworkUtil';
import { cleanServiceResultText } from './serviceOrderProtocols.js';

interface MessageAccumulator {
  messages: CoworkMessage[];
  resolve: (result: OrderCoworkResult) => void;
  reject: (error: Error) => void;
  timeoutId?: NodeJS.Timeout;
  request?: OrderCoworkRequest;
}

export interface PrivateChatOrderCoworkOptions {
  coworkRunner: CoworkRunner;
  coworkStore: CoworkStore;
  metabotStore: MetabotStore;
  timeoutMs?: number;
  emitToRenderer?: (channel: string, data: unknown) => void;
}

export interface OrderCoworkResult {
  serviceReply: string;
  ratingInvite: string;
  isDeliverable: boolean;
}

export interface OrderCoworkRequest {
  metabotId: number;
  source: OrderSource;
  externalConversationId: string;
  existingSessionId?: string | null;
  prompt: string;
  systemPrompt: string;
  title?: string;
  peerGlobalMetaId?: string | null;
  peerName?: string | null;
  peerAvatar?: string | null;
}

const DEFAULT_TIMEOUT_MS = 240_000;
const TIMEOUT_FALLBACK_MAX_LINES = 8;
const TIMEOUT_FALLBACK_MAX_CHARS = 900;
const ANSI_ESCAPE_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const HTML_TAG_RE = /<[^>]+>/g;
const HTML_ENTITY_RE = /&(nbsp|amp|lt|gt|quot|#39);/gi;

export class PrivateChatOrderCowork extends EventEmitter {
  private coworkRunner: CoworkRunner;
  private coworkStore: CoworkStore;
  private metabotStore: MetabotStore;
  private timeoutMs: number;
  private emitToRenderer?: (channel: string, data: unknown) => void;

  private sessionIds: Set<string> = new Set();
  private accumulators: Map<string, MessageAccumulator> = new Map();

  constructor(options: PrivateChatOrderCoworkOptions) {
    super();
    this.coworkRunner = options.coworkRunner;
    this.coworkStore = options.coworkStore;
    this.metabotStore = options.metabotStore;
    this.timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.emitToRenderer = options.emitToRenderer;
    this.setupListeners();
  }

  private setupListeners(): void {
    this.coworkRunner.on('message', this.handleMessage.bind(this));
    this.coworkRunner.on('messageUpdate', this.handleMessageUpdate.bind(this));
    this.coworkRunner.on('permissionRequest', this.handlePermissionRequest.bind(this));
    this.coworkRunner.on('complete', this.handleComplete.bind(this));
    this.coworkRunner.on('error', this.handleError.bind(this));
  }

  async runOrder(request: OrderCoworkRequest): Promise<OrderCoworkResult> {
    const sessionId = request.existingSessionId?.trim()
      || await this.createOrderSession(request);
    this.injectProcessingNotice(sessionId, request);
    this.sessionIds.add(sessionId);
    const responsePromise = this.createAccumulatorPromise(sessionId, request);

    const session = this.coworkStore.getSession(sessionId);
    if (!session) {
      throw new Error(`Order cowork session ${sessionId} not found`);
    }

    this.coworkRunner.startSession(sessionId, request.prompt, {
      skipInitialUserMessage: true,
      workspaceRoot: session.cwd,
      confirmationMode: 'text',
      systemPrompt: request.systemPrompt,
      autoApprove: true,
      disableRemoteServicesPrompt: true,
    }).catch((error) => {
      this.rejectAccumulator(sessionId, error instanceof Error ? error : new Error(String(error)));
    });

    return responsePromise;
  }

  private async createOrderSession(request: OrderCoworkRequest): Promise<string> {
    const config = this.coworkStore.getConfig();
    let workspaceRoot = (config.workingDirectory || '').trim();
    // Fall back to the OS temp directory so orders can execute even without a configured workspace.
    if (!workspaceRoot) {
      workspaceRoot = os.tmpdir();
    }
    const resolvedRoot = path.resolve(workspaceRoot);
    if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
      throw new Error(`IM 工作目录不存在或无效: ${resolvedRoot}`);
    }

    const fallbackTitle = request.prompt.split('\n')[0].slice(0, 50) || 'New Session';
    const generatedTitle = await generateSessionTitle(request.prompt).catch(() => null);
    const title = generatedTitle?.trim() || request.title?.trim() || fallbackTitle;

    const session = this.coworkStore.createSession(
      title,
      resolvedRoot,
      request.systemPrompt,
      'local',
      [],
      request.metabotId,
      'a2a',
      request.peerGlobalMetaId ?? null,
      request.peerName ?? null,
      request.peerAvatar ?? null
    );

    this.coworkStore.upsertConversationMapping({
      channel: 'metaweb_order',
      externalConversationId: request.externalConversationId,
      metabotId: request.metabotId,
      coworkSessionId: session.id,
    });

    const initialMessage = this.coworkStore.addMessage(session.id, {
      type: 'user',
      content: request.prompt,
      metadata: {
        sourceChannel: request.source,
        externalConversationId: request.externalConversationId,
        senderGlobalMetaId: request.peerGlobalMetaId ?? undefined,
        senderName: request.peerName ?? undefined,
        senderAvatar: request.peerAvatar ?? undefined,
        direction: 'incoming',
      },
    });

    // Notify renderer immediately so the session appears without restart
    if (this.emitToRenderer) {
      this.emitToRenderer('cowork:stream:message', { sessionId: session.id, message: initialMessage });
    }

    return session.id;
  }

  private createAccumulatorPromise(sessionId: string, request?: OrderCoworkRequest): Promise<OrderCoworkResult> {
    return new Promise((resolve, reject) => {
      const existing = this.accumulators.get(sessionId);
      if (existing?.timeoutId) clearTimeout(existing.timeoutId);
      if (existing) {
        this.accumulators.delete(sessionId);
        existing.reject(new Error('Replaced by a newer order request'));
      }

      const timeoutId = setTimeout(() => {
        const acc = this.accumulators.get(sessionId);
        if (!acc) return;
        this.cleanupAccumulator(sessionId);
        this.resolveTimeoutFallback(sessionId, acc);
      }, this.timeoutMs);

      this.accumulators.set(sessionId, {
        messages: [],
        resolve,
        reject,
        timeoutId,
        request,
      });
    });
  }

  private injectProcessingNotice(sessionId: string, request: OrderCoworkRequest): void {
    const peerName = request.peerName?.trim();
    const content = peerName
      ? `${peerName}，已收到你的服务订单，正在处理，稍后返回结果。`
      : '已收到服务订单，正在处理，稍后返回结果。';
    const notice = this.coworkStore.addMessage(sessionId, {
      type: 'assistant',
      content,
      metadata: {
        sourceChannel: request.source,
        externalConversationId: request.externalConversationId,
        direction: 'outgoing',
        excludeFromSandboxHistory: true,
        orderProcessingNotice: true,
      },
    });
    if (this.emitToRenderer) {
      this.emitToRenderer('cowork:stream:message', { sessionId, message: notice });
    }
  }

  private handleMessage(sessionId: string, message: CoworkMessage): void {
    if (!this.sessionIds.has(sessionId)) return;
    const accumulator = this.accumulators.get(sessionId);
    if (accumulator) accumulator.messages.push(message);
    // Forward to renderer so the A2A session updates live in the UI
    if (this.emitToRenderer) {
      this.emitToRenderer('cowork:stream:message', { sessionId, message });
    }
  }

  private handleMessageUpdate(sessionId: string, messageId: string, content: string): void {
    if (!this.sessionIds.has(sessionId)) return;
    const accumulator = this.accumulators.get(sessionId);
    if (!accumulator) return;
    const index = accumulator.messages.findIndex((m) => m.id === messageId);
    if (index >= 0) accumulator.messages[index].content = content;
    // Forward streaming content updates to renderer
    if (this.emitToRenderer) {
      this.emitToRenderer('cowork:stream:messageUpdate', { sessionId, messageId, content });
    }
  }

  private handlePermissionRequest(sessionId: string, request: PermissionRequest): void {
    if (!this.sessionIds.has(sessionId)) return;
    this.coworkRunner.respondToPermission(request.requestId, {
      behavior: 'allow',
      updatedInput: request.toolInput,
    });
  }

  private handleComplete(sessionId: string): void {
    if (!this.sessionIds.has(sessionId)) return;
    const accumulator = this.accumulators.get(sessionId);
    if (!accumulator) return;
    const serviceReply = this.formatReply(sessionId, accumulator.messages);
    const request = accumulator.request;
    this.cleanupAccumulator(sessionId);
    if (this.emitToRenderer) {
      this.emitToRenderer('cowork:stream:complete', { sessionId });
    }
    // Generate [NeedsRating] invite asynchronously, then resolve
    this.buildRatingInvite(serviceReply, request).then((ratingInvite) => {
      accumulator.resolve({ serviceReply, ratingInvite, isDeliverable: true });
    }).catch(() => {
      // Fallback if LLM fails
      accumulator.resolve({
        serviceReply,
        ratingInvite: '[NeedsRating] 服务已完成，请给个评价吧！',
        isDeliverable: true,
      });
    });
  }

  private handleError(sessionId: string, error: string): void {
    if (!this.sessionIds.has(sessionId)) return;
    const accumulator = this.accumulators.get(sessionId);
    if (!accumulator) return;
    this.cleanupAccumulator(sessionId);
    if (this.emitToRenderer) {
      this.emitToRenderer('cowork:stream:error', { sessionId, error });
    }
    accumulator.reject(new Error(error));
  }

  private rejectAccumulator(sessionId: string, error: Error): void {
    const accumulator = this.accumulators.get(sessionId);
    if (!accumulator) return;
    this.cleanupAccumulator(sessionId);
    accumulator.reject(error);
  }

  private cleanupAccumulator(sessionId: string): void {
    const accumulator = this.accumulators.get(sessionId);
    if (accumulator?.timeoutId) clearTimeout(accumulator.timeoutId);
    this.accumulators.delete(sessionId);
  }

  private resolveTimeoutFallback(sessionId: string, accumulator: MessageAccumulator): void {
    this.coworkRunner.stopSession(sessionId, { finalStatus: 'completed' });
    const fallbackReply = this.buildTimeoutFallbackReply(accumulator.messages);
    const fallbackMessage = this.coworkStore.addMessage(sessionId, {
      type: 'assistant',
      content: fallbackReply,
      metadata: {
        sourceChannel: accumulator.request?.source,
        externalConversationId: accumulator.request?.externalConversationId,
        direction: 'outgoing',
        excludeFromSandboxHistory: true,
        orderTimeoutFallback: true,
      },
    });
    accumulator.messages.push(fallbackMessage);

    if (this.emitToRenderer) {
      this.emitToRenderer('cowork:stream:message', { sessionId, message: fallbackMessage });
      this.emitToRenderer('cowork:stream:complete', { sessionId, timeoutFallback: true });
    }

    accumulator.resolve({
      serviceReply: fallbackReply,
      ratingInvite: '',
      isDeliverable: false,
    });
  }

  private buildTimeoutFallbackReply(messages: CoworkMessage[]): string {
    const assistantReply = this.extractLatestAssistantDeliverable(messages);
    if (assistantReply) {
      return [
        '本次服务执行超时，先同步当前可用结果（可能不完整）：',
        '',
        assistantReply,
        '',
        '若稍后仍未收到正式交付，系统会自动发起退款。',
      ].join('\n');
    }

    const toolSnippet = this.extractLatestToolResultSnippet(messages);
    if (toolSnippet) {
      return [
        '本次服务执行超时，先同步当前可用信息（可能不完整）：',
        '',
        toolSnippet,
        '',
        '若稍后仍未收到正式交付，系统会自动发起退款。',
      ].join('\n');
    }

    return '本次服务执行超时，暂未生成可交付结果。若稍后仍未收到正式交付，系统会自动发起退款。';
  }

  private extractLatestAssistantDeliverable(messages: CoworkMessage[]): string | null {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.type !== 'assistant') continue;
      if (message.metadata?.isThinking) continue;
      if (message.metadata?.orderProcessingNotice === true) continue;
      const text = String(message.content || '').trim();
      if (!text) continue;
      const cleaned = cleanServiceResultText(text) || text;
      return this.truncateTimeoutFallbackText(cleaned);
    }
    return null;
  }

  private extractLatestToolResultSnippet(messages: CoworkMessage[]): string | null {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.type !== 'tool_result') continue;
      const normalized = this.normalizeTimeoutSnippetText(message.content || '');
      if (!normalized) continue;
      return normalized;
    }
    return null;
  }

  private normalizeTimeoutSnippetText(raw: string): string {
    let text = String(raw || '')
      .replace(/\r\n?/g, '\n')
      .replace(ANSI_ESCAPE_RE, '');
    if (!text.trim()) {
      return '';
    }

    if (/<\/?[a-z][\s\S]*>/i.test(text)) {
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(HTML_TAG_RE, ' ')
        .replace(HTML_ENTITY_RE, (_match, entity: string) => {
          const normalized = String(entity || '').toLowerCase();
          if (normalized === 'nbsp') return ' ';
          if (normalized === 'amp') return '&';
          if (normalized === 'lt') return '<';
          if (normalized === 'gt') return '>';
          if (normalized === 'quot') return '"';
          if (normalized === '#39') return '\'';
          return ' ';
        });
    }

    const lines = text
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .filter((line) => !/^\d+\s*→/.test(line))
      .slice(0, TIMEOUT_FALLBACK_MAX_LINES);

    if (lines.length === 0) {
      return '';
    }

    return this.truncateTimeoutFallbackText(lines.join('\n'));
  }

  private truncateTimeoutFallbackText(value: string): string {
    const text = String(value || '').trim();
    if (!text) return '';
    if (text.length <= TIMEOUT_FALLBACK_MAX_CHARS) {
      return text;
    }
    return `${text.slice(0, TIMEOUT_FALLBACK_MAX_CHARS)}\n...[已截断]`;
  }

  private formatReply(sessionId: string, messages: CoworkMessage[]): string {
    // Find the last non-thinking assistant message with content — that's the final answer.
    // We deliberately skip thinking blocks and intermediate streaming chunks so the buyer
    // only sees the clean result, not the full execution trace.
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type !== 'assistant') continue;
      if (msg.metadata?.isThinking) continue;
      if (msg.metadata?.orderProcessingNotice === true) continue;
      const text = (msg.content || '').trim();
      if (!text) continue;
      const cleaned = cleanServiceResultText(text) || text;
      if (cleaned !== text) {
        this.coworkStore.updateMessage(sessionId, msg.id, {
          content: cleaned,
          metadata: msg.metadata,
        });
        messages[i].content = cleaned;
        if (this.emitToRenderer) {
          this.emitToRenderer('cowork:stream:messageUpdate', {
            sessionId,
            messageId: msg.id,
            content: cleaned,
          });
        }
      }
      return cleaned;
    }
    return '处理完成，但没有生成回复。';
  }

  private async buildRatingInvite(serviceReply: string, request?: OrderCoworkRequest): Promise<string> {
    const metabot = request?.metabotId != null
      ? this.metabotStore.getMetabotById(request.metabotId)
      : null;
    const personaLines = metabot ? [
      metabot.name ? `Your name is ${metabot.name}.` : '',
      metabot.role ? `Your role: ${metabot.role}.` : '',
      metabot.soul ? `Your personality: ${metabot.soul}.` : '',
      metabot.background ? `Background: ${metabot.background}.` : '',
    ].filter(Boolean).join(' ') : '';

    const systemPrompt = [
      personaLines,
      'You just completed a paid service order. Write a short, natural message in your own voice inviting the client to rate your service.',
      'The message should reflect your personality and reference the service you just delivered.',
      'Keep it to 1-2 sentences. Be genuine, not robotic.',
      `The service result you delivered: "${serviceReply.slice(0, 200)}"`,
    ].filter(Boolean).join('\n');

    const llmId = metabot && typeof metabot.llm_id === 'string' ? metabot.llm_id.trim() || undefined : undefined;

    const text = await performChatCompletionForOrchestrator(systemPrompt, '请生成邀评消息。', llmId);
    return `[NeedsRating] ${text.trim()}`;
  }
}
