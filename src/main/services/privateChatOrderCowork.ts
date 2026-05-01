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
import {
  buildNeedsRatingMessage,
  buildOrderStatusMessage,
  cleanServiceResultText,
} from './serviceOrderProtocols.js';
import {
  buildMetafileDeliverySummary,
  normalizeServiceOutputType,
  resolveServiceDeliveryArtifact,
  uploadVerifiedDeliveryArtifact,
} from './serviceDeliveryArtifacts.js';
import {
  buildA2AChainMetadata,
  type A2AChainMetadata,
} from './a2aChainMetadata';
import {
  buildOrderProtocolDisplayMetadata,
  type SimplemsgProtocolTag,
} from './simplemsgPeerConversation';

interface MessageAccumulator {
  messages: CoworkMessage[];
  mirroredMessageIds: Map<string, string>;
  missingArtifactContinuationAttempts: number;
  activeRunPromise?: Promise<void>;
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
  uploadDeliveryArtifact?: (artifact: Record<string, unknown>, request: OrderCoworkRequest) => Promise<Record<string, unknown>>;
  verifyDeliveryArtifactUpload?: (
    upload: Record<string, unknown>,
    artifact: Record<string, unknown>,
    request: OrderCoworkRequest
  ) => Promise<boolean>;
  buildRatingInvite?: (serviceReply: string, request?: OrderCoworkRequest) => Promise<string>;
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
  displaySessionId?: string | null;
  prompt: string;
  systemPrompt: string;
  title?: string;
  peerGlobalMetaId?: string | null;
  peerName?: string | null;
  peerAvatar?: string | null;
  expectedOutputType?: string | null;
  orderTxid?: string | null;
  orderStartedAt?: number | null;
  processingNotice?: {
    content: string;
    metadata?: Record<string, unknown>;
  };
  sendStatusUpdate?: (content: string) => Promise<unknown>;
}

const DEFAULT_TIMEOUT_MS = 240_000;
const MAX_MISSING_ARTIFACT_CONTINUATION_ATTEMPTS = 1;
const TIMEOUT_FALLBACK_MAX_LINES = 8;
const TIMEOUT_FALLBACK_MAX_CHARS = 900;
const ANSI_ESCAPE_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const HTML_TAG_RE = /<[^>]+>/g;
const HTML_ENTITY_RE = /&(nbsp|amp|lt|gt|quot|#39);/gi;
const EXPLICIT_MEDIA_FAILURE_RE = /(无法|不能|未能|缺少|失败|报错|错误|被拒绝|not able|unable|cannot|can't|failed|failure|missing|error|denied|rejected)/i;

export class PrivateChatOrderCowork extends EventEmitter {
  private coworkRunner: CoworkRunner;
  private coworkStore: CoworkStore;
  private metabotStore: MetabotStore;
  private timeoutMs: number;
  private emitToRenderer?: (channel: string, data: unknown) => void;
  private uploadDeliveryArtifact?: (artifact: Record<string, unknown>, request: OrderCoworkRequest) => Promise<Record<string, unknown>>;
  private verifyDeliveryArtifactUpload?: (
    upload: Record<string, unknown>,
    artifact: Record<string, unknown>,
    request: OrderCoworkRequest
  ) => Promise<boolean>;
  private buildRatingInviteOverride?: (serviceReply: string, request?: OrderCoworkRequest) => Promise<string>;

  private sessionIds: Set<string> = new Set();
  private accumulators: Map<string, MessageAccumulator> = new Map();

  constructor(options: PrivateChatOrderCoworkOptions) {
    super();
    this.coworkRunner = options.coworkRunner;
    this.coworkStore = options.coworkStore;
    this.metabotStore = options.metabotStore;
    this.timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.emitToRenderer = options.emitToRenderer;
    this.uploadDeliveryArtifact = options.uploadDeliveryArtifact;
    this.verifyDeliveryArtifactUpload = options.verifyDeliveryArtifactUpload;
    this.buildRatingInviteOverride = options.buildRatingInvite;
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
    request.orderStartedAt = request.orderStartedAt ?? Date.now();
    const displaySessionId = this.normalizeSessionId(request.displaySessionId);
    const existingSessionId = this.normalizeSessionId(request.existingSessionId);
    let sessionId: string;
    if (displaySessionId) {
      sessionId = this.createExecutionSession(request);
    } else if (existingSessionId) {
      sessionId = existingSessionId;
    } else {
      if (request.source === 'metaweb_private') {
        throw new Error('Missing canonical peer conversation session for metaweb_private order execution');
      }
      sessionId = await this.createOrderSession(request);
    }
    const visibleSessionId = this.getDisplaySessionId(sessionId, request);
    this.injectProcessingNotice(visibleSessionId, request);
    this.sessionIds.add(sessionId);
    const responsePromise = this.createAccumulatorPromise(sessionId, request);

    const session = this.coworkStore.getSession(sessionId);
    if (!session) {
      throw new Error(`Order cowork session ${sessionId} not found`);
    }

    const startPromise = this.coworkRunner.startSession(sessionId, request.prompt, {
      skipInitialUserMessage: true,
      workspaceRoot: session.cwd,
      confirmationMode: 'text',
      systemPrompt: request.systemPrompt,
      autoApprove: true,
      disableMemoryUpdates: true,
      disableRemoteServicesPrompt: true,
    });
    this.setAccumulatorRunPromise(sessionId, startPromise);
    startPromise.catch((error) => {
      this.rejectAccumulator(sessionId, error instanceof Error ? error : new Error(String(error)));
    });

    return responsePromise;
  }

  private normalizeSessionId(value?: string | null): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private getDisplaySessionId(executionSessionId: string, request?: OrderCoworkRequest): string {
    const displaySessionId = this.normalizeSessionId(request?.displaySessionId);
    if (!displaySessionId || displaySessionId === executionSessionId) return executionSessionId;
    return this.coworkStore.getSession(displaySessionId) ? displaySessionId : executionSessionId;
  }

  private hasSeparateDisplaySession(executionSessionId: string, request?: OrderCoworkRequest): boolean {
    return this.getDisplaySessionId(executionSessionId, request) !== executionSessionId;
  }

  private resolveWorkspaceRoot(): string {
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
    return resolvedRoot;
  }

  private createExecutionSession(request: OrderCoworkRequest): string {
    const resolvedRoot = this.resolveWorkspaceRoot();
    const fallbackTitle = request.prompt.split('\n')[0].slice(0, 50) || 'Order Execution';
    const session = this.coworkStore.createSession(
      request.title?.trim() || fallbackTitle,
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
    if (typeof this.coworkStore.setSessionHiddenFromList === 'function') {
      this.coworkStore.setSessionHiddenFromList(session.id, true);
    }
    return session.id;
  }

  private async createOrderSession(request: OrderCoworkRequest): Promise<string> {
    const resolvedRoot = this.resolveWorkspaceRoot();

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
        mirroredMessageIds: new Map(),
        missingArtifactContinuationAttempts: 0,
        resolve,
        reject,
        timeoutId,
        request,
      });
    });
  }

  private setAccumulatorRunPromise(sessionId: string, runPromise: Promise<void>): void {
    const accumulator = this.accumulators.get(sessionId);
    if (accumulator) accumulator.activeRunPromise = runPromise;
  }

  private injectProcessingNotice(sessionId: string, request: OrderCoworkRequest): void {
    const peerName = request.peerName?.trim();
    const transmittedContent = request.processingNotice?.content?.trim();
    const content = transmittedContent || (peerName
      ? `${peerName}，已收到你的服务订单，技能执行可能需要一些时间，正在处理，请耐心等待最终结果。`
      : '已收到服务订单，技能执行可能需要一些时间，正在处理，请耐心等待最终结果。');
    const notice = this.coworkStore.addMessage(sessionId, {
      type: 'assistant',
      content,
      metadata: this.buildDisplayMetadata(request, 'ORDER_STATUS', {
        excludeFromSandboxHistory: true,
        orderProcessingNotice: true,
        ...(request.processingNotice?.metadata ?? {}),
      }),
    });
    if (this.emitToRenderer) {
      this.emitToRenderer('cowork:stream:message', { sessionId, message: notice });
    }
  }

  private handleMessage(sessionId: string, message: CoworkMessage): void {
    if (!this.sessionIds.has(sessionId)) return;
    const accumulator = this.accumulators.get(sessionId);
    if (accumulator) accumulator.messages.push(message);
    // Execution sessions are internal when a canonical peer display session is provided.
    if (accumulator && this.hasSeparateDisplaySession(sessionId, accumulator.request)) {
      this.mirrorExecutionMessageToDisplaySession(sessionId, message, accumulator);
    } else if (this.emitToRenderer) {
      this.emitToRenderer('cowork:stream:message', { sessionId, message });
    }
  }

  private handleMessageUpdate(sessionId: string, messageId: string, content: string): void {
    if (!this.sessionIds.has(sessionId)) return;
    const accumulator = this.accumulators.get(sessionId);
    if (!accumulator) return;
    const index = accumulator.messages.findIndex((m) => m.id === messageId);
    if (index >= 0) accumulator.messages[index].content = content;
    if (this.hasSeparateDisplaySession(sessionId, accumulator.request)) {
      this.updateMirroredExecutionMessage(sessionId, messageId, content, accumulator);
    } else if (this.emitToRenderer) {
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
    const serviceReply = this.formatReply(sessionId, accumulator.messages, accumulator.request);
    const request = accumulator.request;
    if (this.shouldContinueForMissingDeliveryArtifact(sessionId, accumulator)) {
      this.startMissingArtifactContinuation(sessionId, accumulator);
      return;
    }
    this.cleanupAccumulator(sessionId);
    if (this.emitToRenderer && !this.hasSeparateDisplaySession(sessionId, request)) {
      this.emitToRenderer('cowork:stream:complete', { sessionId });
    }
    this.finalizeCompletedOrder(sessionId, serviceReply, accumulator.messages, request).then(async (finalized) => {
      if (!finalized.isDeliverable) {
        accumulator.resolve({
          serviceReply: finalized.serviceReply,
          ratingInvite: '',
          isDeliverable: false,
        });
        return;
      }
      const ratingInvite = await this.buildRatingInvite(finalized.serviceReply, request);
      accumulator.resolve({
        serviceReply: finalized.serviceReply,
        ratingInvite: this.formatNeedsRatingText(request, ratingInvite),
        isDeliverable: true,
      });
    }).catch(() => {
      // Fallback if LLM fails
      if (!serviceReply?.trim()) {
        accumulator.resolve({
          serviceReply: this.buildMissingTextDeliveryFailureReply(),
          ratingInvite: '',
          isDeliverable: false,
        });
        return;
      }
      accumulator.resolve({
        serviceReply,
        ratingInvite: this.formatNeedsRatingText(request, '[NeedsRating] 服务已完成，请给个评价吧！'),
        isDeliverable: true,
      });
    });
  }

  private mirrorExecutionMessageToDisplaySession(
    executionSessionId: string,
    message: CoworkMessage,
    accumulator: MessageAccumulator,
  ): void {
    const displaySessionId = this.getDisplaySessionId(executionSessionId, accumulator.request);
    if (displaySessionId === executionSessionId) return;
    const mirrored = this.coworkStore.addMessage(displaySessionId, {
      type: message.type,
      content: message.content,
      metadata: this.buildExecutionTraceMetadata(message, accumulator.request),
    });
    accumulator.mirroredMessageIds.set(message.id, mirrored.id);
    if (this.emitToRenderer) {
      this.emitToRenderer('cowork:stream:message', { sessionId: displaySessionId, message: mirrored });
    }
  }

  private updateMirroredExecutionMessage(
    executionSessionId: string,
    sourceMessageId: string,
    content: string,
    accumulator: MessageAccumulator,
  ): void {
    const displaySessionId = this.getDisplaySessionId(executionSessionId, accumulator.request);
    const mirroredMessageId = accumulator.mirroredMessageIds.get(sourceMessageId);
    if (!mirroredMessageId || displaySessionId === executionSessionId) return;
    this.coworkStore.updateMessage(displaySessionId, mirroredMessageId, { content });
    if (this.emitToRenderer) {
      this.emitToRenderer('cowork:stream:messageUpdate', {
        sessionId: displaySessionId,
        messageId: mirroredMessageId,
        content,
      });
    }
  }

  private buildExecutionTraceMetadata(
    message: CoworkMessage,
    request?: OrderCoworkRequest,
  ): Record<string, unknown> {
    const metadata = {
      ...(message.metadata ?? {}),
      sourceChannel: 'metaweb_order_execution',
      externalConversationId: request?.externalConversationId,
      orderTxid: request?.orderTxid ?? undefined,
      orderRole: request?.source === 'metaweb_private' ? 'seller' : undefined,
      orderExecutionTrace: true,
      excludeFromSandboxHistory: true,
      suppressRunningStatus: true,
    };
    delete (metadata as Record<string, unknown>).direction;
    delete (metadata as Record<string, unknown>).senderGlobalMetaId;
    delete (metadata as Record<string, unknown>).senderName;
    delete (metadata as Record<string, unknown>).senderAvatar;
    return metadata;
  }

  private shouldContinueForMissingDeliveryArtifact(
    sessionId: string,
    accumulator: MessageAccumulator,
  ): boolean {
    if (accumulator.missingArtifactContinuationAttempts >= MAX_MISSING_ARTIFACT_CONTINUATION_ATTEMPTS) {
      return false;
    }
    const outputType = normalizeServiceOutputType(accumulator.request?.expectedOutputType);
    if (outputType === 'text') return false;

    const session = this.coworkStore.getSession(sessionId);
    const cwd = session?.cwd || this.coworkStore.getConfig().workingDirectory || os.tmpdir();
    const artifactResult = resolveServiceDeliveryArtifact({
      outputType,
      cwd,
      orderStartedAt: accumulator.request?.orderStartedAt ?? Date.now(),
      messages: accumulator.messages,
    });
    if (artifactResult.status !== 'missing') return false;

    const latestAssistant = this.extractLatestAssistantDeliverable(accumulator.messages) || '';
    if (EXPLICIT_MEDIA_FAILURE_RE.test(latestAssistant)) return false;

    return true;
  }

  private startMissingArtifactContinuation(
    sessionId: string,
    accumulator: MessageAccumulator,
  ): void {
    accumulator.missingArtifactContinuationAttempts += 1;
    const request = accumulator.request;
    const session = this.coworkStore.getSession(sessionId);
    const prompt = this.buildMissingArtifactContinuationPrompt(request);
    const previousRun = accumulator.activeRunPromise;
    const startContinuation = () => {
      if (this.accumulators.get(sessionId) !== accumulator) return;
      let continuationPromise: Promise<void>;
      try {
        continuationPromise = this.coworkRunner.startSession(sessionId, prompt, {
          skipInitialUserMessage: true,
          workspaceRoot: session?.cwd,
          confirmationMode: 'text',
          systemPrompt: request?.systemPrompt,
          autoApprove: true,
          disableMemoryUpdates: true,
          disableRemoteServicesPrompt: true,
        });
      } catch (error) {
        this.rejectAccumulator(sessionId, error instanceof Error ? error : new Error(String(error)));
        return;
      }
      accumulator.activeRunPromise = continuationPromise;
      continuationPromise.catch((error) => {
        this.rejectAccumulator(sessionId, error instanceof Error ? error : new Error(String(error)));
      });
    };

    if (previousRun) {
      previousRun.catch(() => undefined).then(startContinuation);
      return;
    }
    queueMicrotask(startContinuation);
  }

  private buildMissingArtifactContinuationPrompt(request?: OrderCoworkRequest): string {
    const outputType = normalizeServiceOutputType(request?.expectedOutputType);
    const orderTxid = typeof request?.orderTxid === 'string' ? request.orderTxid.trim() : '';
    return [
      `The paid service order is not complete yet because no ${outputType} file exists for delivery.`,
      orderTxid ? `Order txid: ${orderTxid}.` : '',
      `Continue executing the required skill now. You MUST generate a real ${outputType} file in the current workspace before giving the final answer.`,
      `Do not answer with only progress, intent, acknowledgement, or "started generating".`,
      `Use the service skill/tool/command now. After the file exists, final answer must include the local file path.`,
      `If you truly cannot generate a valid ${outputType} file, state the concrete failure reason instead of claiming success.`,
    ].filter(Boolean).join('\n');
  }

  private async finalizeCompletedOrder(
    sessionId: string,
    serviceReply: string | null,
    messages: CoworkMessage[],
    request?: OrderCoworkRequest,
  ): Promise<OrderCoworkResult> {
    const displaySessionId = this.getDisplaySessionId(sessionId, request);
    const outputType = normalizeServiceOutputType(request?.expectedOutputType);
    const trimmedServiceReply = String(serviceReply || '').trim();
    if (outputType === 'text') {
      if (!trimmedServiceReply) {
        const failureReply = this.buildMissingTextDeliveryFailureReply();
        this.addOrderDeliveryStatusMessage(displaySessionId, failureReply, {
          orderDeliveryFailed: true,
        }, request);
        return {
          serviceReply: failureReply,
          ratingInvite: '',
          isDeliverable: false,
        };
      }
      return {
        serviceReply: trimmedServiceReply,
        ratingInvite: '',
        isDeliverable: true,
      };
    }

    const session = this.coworkStore.getSession(sessionId);
    const cwd = session?.cwd || this.coworkStore.getConfig().workingDirectory || os.tmpdir();
    const artifactResult = resolveServiceDeliveryArtifact({
      outputType,
      cwd,
      orderStartedAt: request?.orderStartedAt ?? Date.now(),
      messages,
    });

    if (artifactResult.status !== 'found') {
      const reason = artifactResult.status === 'invalid' && artifactResult.reason === 'file_too_large'
        ? '生成文件超过 20MB，无法按约定上传链上交付。'
        : `未找到符合 ${outputType} 交付格式的数字成果。`;
      const failureReply = [
        `服务方未能按约定交付 ${outputType} 数字成果。`,
        reason,
        '系统将自动转入退款流程，请勿对本次服务进行好评确认。',
      ].join('\n');
      this.addOrderDeliveryStatusMessage(displaySessionId, failureReply, {
        orderDeliveryFailed: true,
      }, request);
      return {
        serviceReply: failureReply,
        ratingInvite: '',
        isDeliverable: false,
      };
    }

    if (!this.uploadDeliveryArtifact) {
      const failureReply = [
        `服务方已生成 ${outputType} 数字成果，但当前运行时缺少链上上传能力。`,
        '系统将自动转入退款流程，请稍后重试或联系服务方。',
      ].join('\n');
      this.addOrderDeliveryStatusMessage(displaySessionId, failureReply, {
        orderDeliveryFailed: true,
      }, request);
      return {
        serviceReply: failureReply,
        ratingInvite: '',
        isDeliverable: false,
      };
    }

    const uploadNotice = this.formatOrderStatusText(request, '技能执行完毕，数字成果已生成，正在将数字成果上传链上交付，请耐心等待。');
    const uploadNoticeMessage = this.addOrderDeliveryStatusMessage(displaySessionId, uploadNotice, {
      orderDeliveryUploadNotice: true,
    }, request);
    const uploadNoticeMetadata = await this.sendOrderStatusUpdate(request, uploadNotice);
    this.applyChainMetadataToMessage(displaySessionId, uploadNoticeMessage, uploadNoticeMetadata);

    try {
      const verifiedUpload = await uploadVerifiedDeliveryArtifact({
        artifact: artifactResult.artifact,
        request: request ?? ({} as OrderCoworkRequest),
        uploadDeliveryArtifact: this.uploadDeliveryArtifact,
        verifyDeliveryArtifactUpload: this.verifyDeliveryArtifactUpload,
        maxAttempts: 2,
        onRetry: async () => {
          const retryNotice = this.formatOrderStatusText(request, '数字成果链上上传校验失败，正在重新上传一次。');
          const retryNoticeMessage = this.addOrderDeliveryStatusMessage(displaySessionId, retryNotice, {
            orderDeliveryUploadRetryNotice: true,
          }, request);
          const retryNoticeMetadata = await this.sendOrderStatusUpdate(request, retryNotice);
          this.applyChainMetadataToMessage(displaySessionId, retryNoticeMessage, retryNoticeMetadata);
        },
      });
      if (!verifiedUpload.ok) {
        throw verifiedUpload.error;
      }
      const deliverySummary = buildMetafileDeliverySummary({
        artifact: artifactResult.artifact,
        upload: verifiedUpload.upload,
      });
      return {
        serviceReply: [trimmedServiceReply, '', deliverySummary].filter(Boolean).join('\n\n'),
        ratingInvite: '',
        isDeliverable: true,
      };
    } catch (error) {
      const failureReply = [
        `服务方已生成 ${outputType} 数字成果，但上传链上交付失败。`,
        error instanceof Error ? error.message : String(error),
        '系统将自动转入退款流程，请稍后重试或联系服务方。',
      ].filter(Boolean).join('\n');
      this.addOrderDeliveryStatusMessage(displaySessionId, failureReply, {
        orderDeliveryFailed: true,
      }, request);
      return {
        serviceReply: failureReply,
        ratingInvite: '',
        isDeliverable: false,
      };
    }
  }

  private addOrderDeliveryStatusMessage(
    sessionId: string,
    content: string,
    metadata: Record<string, unknown>,
    request?: OrderCoworkRequest,
  ): CoworkMessage {
    const message = this.coworkStore.addMessage(sessionId, {
      type: 'assistant',
      content,
      metadata: this.buildDisplayMetadata(request, 'ORDER_STATUS', {
        excludeFromSandboxHistory: true,
        ...metadata,
      }),
    });
    if (this.emitToRenderer) {
      this.emitToRenderer('cowork:stream:message', { sessionId, message });
    }
    return message;
  }

  private async sendOrderStatusUpdate(
    request: OrderCoworkRequest | undefined,
    content: string,
  ): Promise<A2AChainMetadata | null> {
    if (!request?.sendStatusUpdate) return null;
    try {
      const result = await request.sendStatusUpdate(this.formatOrderStatusText(request, content));
      if (!result || typeof result !== 'object') return null;
      const record = result as Record<string, unknown>;
      return buildA2AChainMetadata({
        txId: record.txid ?? record.txId,
        txids: record.txids,
        pinId: record.pinId,
      });
    } catch {
      // Status updates are best-effort; final delivery or failure notice still follows.
      return null;
    }
  }

  private formatOrderStatusText(
    request: OrderCoworkRequest | undefined,
    content: string,
  ): string {
    const text = String(content || '').trim();
    const orderTxid = typeof request?.orderTxid === 'string' ? request.orderTxid.trim() : '';
    if (!orderTxid || /^\[ORDER_STATUS:/i.test(text)) return text;
    return buildOrderStatusMessage(orderTxid, text);
  }

  private formatNeedsRatingText(
    request: OrderCoworkRequest | undefined,
    content: string,
  ): string {
    const text = String(content || '').trim();
    const orderTxid = typeof request?.orderTxid === 'string' ? request.orderTxid.trim() : '';
    if (!orderTxid || /^\[NeedsRating:/i.test(text)) return text;
    const withoutLegacyPrefix = text.replace(/^\[NeedsRating\]\s*/i, '').trim();
    return buildNeedsRatingMessage(orderTxid, withoutLegacyPrefix);
  }

  private buildDisplayMetadata(
    request: OrderCoworkRequest | undefined,
    tag: SimplemsgProtocolTag,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    if (request?.source === 'metaweb_private' && request.peerGlobalMetaId) {
      return buildOrderProtocolDisplayMetadata({
        peerGlobalMetaId: request.peerGlobalMetaId,
        direction: 'outgoing',
        tag,
        orderTxid: request.orderTxid,
        orderRole: 'seller',
        orderMappingExternalConversationId: request.externalConversationId,
        extra,
      });
    }
    return {
      sourceChannel: request?.source,
      externalConversationId: request?.externalConversationId,
      direction: 'outgoing',
      ...extra,
    };
  }

  private applyChainMetadataToMessage(
    sessionId: string,
    message: CoworkMessage | null | undefined,
    chainMetadata: A2AChainMetadata | null | undefined,
  ): void {
    if (!message || !chainMetadata || Object.keys(chainMetadata).length === 0) return;
    const metadata = {
      ...(message.metadata ?? {}),
      ...chainMetadata,
    };
    this.coworkStore.updateMessage(sessionId, message.id, { metadata });
    message.metadata = metadata;
    if (this.emitToRenderer) {
      this.emitToRenderer('cowork:stream:messageUpdate', {
        sessionId,
        messageId: message.id,
        metadata,
      });
    }
  }

  private handleError(sessionId: string, error: string): void {
    if (!this.sessionIds.has(sessionId)) return;
    const accumulator = this.accumulators.get(sessionId);
    if (!accumulator) return;
    this.cleanupAccumulator(sessionId);
    if (this.emitToRenderer && !this.hasSeparateDisplaySession(sessionId, accumulator.request)) {
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
    const displaySessionId = this.getDisplaySessionId(sessionId, accumulator.request);
    const fallbackMessage = this.coworkStore.addMessage(displaySessionId, {
      type: 'assistant',
      content: fallbackReply,
      metadata: this.buildDisplayMetadata(accumulator.request, 'ORDER_STATUS', {
        excludeFromSandboxHistory: true,
        orderTimeoutFallback: true,
      }),
    });
    accumulator.messages.push(fallbackMessage);

    if (this.emitToRenderer) {
      this.emitToRenderer('cowork:stream:message', { sessionId: displaySessionId, message: fallbackMessage });
      this.emitToRenderer('cowork:stream:complete', { sessionId: displaySessionId, timeoutFallback: true });
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

  private buildMissingTextDeliveryFailureReply(): string {
    return [
      '服务方未能按约定交付 text 服务结果。',
      '技能执行结束，但没有生成可交付的最终回复。',
      '系统将自动转入退款流程，请勿对本次服务进行好评确认。',
    ].join('\n');
  }

  private formatReply(sessionId: string, messages: CoworkMessage[], request?: OrderCoworkRequest): string | null {
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
        const accumulator = this.accumulators.get(sessionId);
        if (accumulator && this.hasSeparateDisplaySession(sessionId, request)) {
          this.updateMirroredExecutionMessage(sessionId, msg.id, cleaned, accumulator);
        } else if (this.emitToRenderer) {
          this.emitToRenderer('cowork:stream:messageUpdate', {
            sessionId,
            messageId: msg.id,
            content: cleaned,
          });
        }
      }
      return cleaned;
    }
    return null;
  }

  private async buildRatingInvite(serviceReply: string, request?: OrderCoworkRequest): Promise<string> {
    if (this.buildRatingInviteOverride) {
      return this.buildRatingInviteOverride(serviceReply, request);
    }
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
