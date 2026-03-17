import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import type { CoworkRunner, PermissionRequest } from '../libs/coworkRunner';
import type { CoworkStore, CoworkMessage } from '../coworkStore';
import type { MetabotStore } from '../metabotStore';
import type { OrderSource } from './orderPayment';

interface MessageAccumulator {
  messages: CoworkMessage[];
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timeoutId?: NodeJS.Timeout;
}

export interface PrivateChatOrderCoworkOptions {
  coworkRunner: CoworkRunner;
  coworkStore: CoworkStore;
  metabotStore: MetabotStore;
  timeoutMs?: number;
  emitToRenderer?: (channel: string, data: unknown) => void;
}

export interface OrderCoworkRequest {
  metabotId: number;
  source: OrderSource;
  externalConversationId: string;
  prompt: string;
  systemPrompt: string;
  title?: string;
  peerGlobalMetaId?: string | null;
  peerName?: string | null;
  peerAvatar?: string | null;
}

const DEFAULT_TIMEOUT_MS = 120_000;

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

  async runOrder(request: OrderCoworkRequest): Promise<string> {
    const sessionId = this.createOrderSession(request);
    this.sessionIds.add(sessionId);
    const responsePromise = this.createAccumulatorPromise(sessionId);

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
    }).catch((error) => {
      this.rejectAccumulator(sessionId, error instanceof Error ? error : new Error(String(error)));
    });

    return responsePromise;
  }

  private createOrderSession(request: OrderCoworkRequest): string {
    const config = this.coworkStore.getConfig();
    const workspaceRoot = (config.workingDirectory || '').trim();
    if (!workspaceRoot) {
      throw new Error('IM 工作目录未配置，请先在应用中选择任务目录。');
    }
    const resolvedRoot = path.resolve(workspaceRoot);
    if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
      throw new Error(`IM 工作目录不存在或无效: ${resolvedRoot}`);
    }

    const metabot = this.metabotStore.getMetabotById(request.metabotId);
    const metabotName = metabot?.name || `MetaBot-${request.metabotId}`;
    const title = request.title || `Order-${metabotName}-${Date.now()}`;

    const session = this.coworkStore.createSession(
      title,
      resolvedRoot,
      request.systemPrompt,
      'local',
      [],
      request.metabotId,
      'agent_agent',
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
        fromGlobalMetaId: request.peerGlobalMetaId ?? undefined,
        fromName: request.peerName ?? undefined,
        fromAvatar: request.peerAvatar ?? undefined,
        isLocalSender: false,
      },
    });

    // Notify renderer immediately so the session appears without restart
    if (this.emitToRenderer) {
      this.emitToRenderer('cowork:stream:message', { sessionId: session.id, message: initialMessage });
    }

    return session.id;
  }

  private createAccumulatorPromise(sessionId: string): Promise<string> {
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
        this.accumulators.delete(sessionId);
        this.coworkRunner.stopSession(sessionId);
        reject(new Error('Order request timed out'));
      }, this.timeoutMs);

      this.accumulators.set(sessionId, {
        messages: [],
        resolve,
        reject,
        timeoutId,
      });
    });
  }

  private handleMessage(sessionId: string, message: CoworkMessage): void {
    if (!this.sessionIds.has(sessionId)) return;
    const accumulator = this.accumulators.get(sessionId);
    if (accumulator) accumulator.messages.push(message);
  }

  private handleMessageUpdate(sessionId: string, messageId: string, content: string): void {
    if (!this.sessionIds.has(sessionId)) return;
    const accumulator = this.accumulators.get(sessionId);
    if (!accumulator) return;
    const index = accumulator.messages.findIndex((m) => m.id === messageId);
    if (index >= 0) accumulator.messages[index].content = content;
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
    const replyText = this.formatReply(accumulator.messages);
    this.cleanupAccumulator(sessionId);
    accumulator.resolve(replyText);
  }

  private handleError(sessionId: string, error: string): void {
    if (!this.sessionIds.has(sessionId)) return;
    const accumulator = this.accumulators.get(sessionId);
    if (!accumulator) return;
    this.cleanupAccumulator(sessionId);
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

  private formatReply(messages: CoworkMessage[]): string {
    const parts: string[] = [];
    for (const msg of messages) {
      if (msg.type !== 'assistant') continue;
      if (msg.content) parts.push(msg.content);
    }
    return parts.join('\n\n') || '处理完成，但没有生成回复。';
  }
}
