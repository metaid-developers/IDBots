import type {
  CoworkMessage,
  CoworkMessageMetadata,
  CoworkSession,
} from '../coworkStore';
import { CoworkDshSteerWindowClosedError } from '../libs/coworkSteerChannel';
import { buildOwnerTurnInputPrompt, resolveContinueSystemPrompt } from '../libs/coworkPromptStrategy';

export type CoworkSubmitInput = {
  sessionId: string;
  submissionId: string;
  text: string;
  systemPrompt?: string;
  activeSkillIds?: string[];
  /** Set when the text was filled verbatim from a quick action (建议操作) entry. */
  source?: 'quick_action';
  /**
   * Who/what submitted this turn when it did not come from the composer
   * (e.g. a scheduled task injecting into its bound session). Persisted on the
   * user message so the renderer can badge the origin.
   */
  origin?: CoworkMessageMetadata['origin'];
  /** Optional human-readable detail for the origin (e.g. scheduled task name). */
  originLabel?: string;
  /**
   * Ids of the whole messages the composed text quotes (the reply entry).
   * Persisted on the user message as quotedMessageIds so the sent quote blocks
   * can jump back by id — the ordinal in the block label is window-relative
   * copy that shifts when older history pages in.
   */
  quotedMessageIds?: string[];
};

export type CoworkSubmitInputErrorCode =
  | 'invalid_input'
  | 'session_not_found'
  | 'unsupported_session'
  | 'unsupported_execution'
  | 'cancelled'
  | 'delivery_failed';

export type CoworkSubmitInputResult =
  | {
      success: true;
      mode: 'steer' | 'continue';
      message: CoworkMessage;
    }
  | {
      success: false;
      error: string;
      code: CoworkSubmitInputErrorCode;
    };

type CoworkSubmitInputFailure = Extract<CoworkSubmitInputResult, { success: false }>;

type SteerCapability = 'open-local' | 'open-dsh' | 'closing-local' | 'sandbox' | 'inactive';

interface SubmissionStore {
  getSession(sessionId: string): CoworkSession | null;
  getMessageById(sessionId: string, messageId: string): CoworkMessage | null;
  getMessageOwnerSessionId?(messageId: string): string | null;
  addMessageWithId(
    sessionId: string,
    messageId: string,
    message: Omit<CoworkMessage, 'id' | 'timestamp'>
  ): CoworkMessage;
  updateMessage(
    sessionId: string,
    messageId: string,
    updates: { content?: string; metadata?: CoworkMessageMetadata }
  ): void;
}

interface SubmissionRunner {
  getSteerCapability(sessionId: string): SteerCapability;
  trySubmitSteer(
    sessionId: string,
    submissionId: string,
    text: string
  ):
    | { accepted: true; delivered: Promise<void> }
    | { accepted: false; reason: 'inactive' | 'closing' | 'sandbox' };
  waitForActiveTurnSettlement(sessionId: string): Promise<void>;
  interruptKernelTurnForHumanInput(sessionId: string): Promise<boolean>;
  releaseKernelTurnInterrupt(sessionId: string): void;
  wasSessionStopped(sessionId: string): boolean;
  continueSession(
    sessionId: string,
    text: string,
    options?: { systemPrompt?: string; skillIds?: string[]; skipUserMessage?: boolean; acknowledgeOwner?: boolean }
  ): Promise<void>;
  on?: {
    (event: 'steerSettled', listener: (sessionId: string, submissionId: string) => void): unknown;
    (event: 'steerFailed', listener: (sessionId: string, submissionId: string, reason: string) => void): unknown;
    (event: 'steerCancelled', listener: (sessionId: string, submissionId: string, reason: string) => void): unknown;
  };
  off?: {
    (event: 'steerSettled', listener: (sessionId: string, submissionId: string) => void): unknown;
    (event: 'steerFailed', listener: (sessionId: string, submissionId: string, reason: string) => void): unknown;
    (event: 'steerCancelled', listener: (sessionId: string, submissionId: string, reason: string) => void): unknown;
  };
}

export type CoworkTurnSubmissionDependencies = {
  store: SubmissionStore;
  runner: SubmissionRunner;
  /**
   * Pinned-skill backstop at the IPC boundary: intersect renderer-supplied
   * activeSkillIds with the session bot's visible skill set (undefined in,
   * undefined out — "no pins this turn" must stay distinguishable). Wired
   * from main.ts via SkillManager.filterSkillIdsForMetabotView.
   */
  sanitizeSkillIds?: (skillIds: string[] | undefined, metabotId: number | null) => string[] | undefined;
  emitMessage: (sessionId: string, message: CoworkMessage) => void;
  emitMessageUpdate: (
    sessionId: string,
    messageId: string,
    content: string,
    metadata: CoworkMessageMetadata
  ) => void;
};

const SUBMISSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function errorResult(code: CoworkSubmitInputErrorCode, error: string): CoworkSubmitInputFailure {
  return { success: false, code, error };
}

function validateStandardSession(session: CoworkSession | null): CoworkSubmitInputFailure | null {
  if (!session) {
    return errorResult('session_not_found', 'Cowork session not found');
  }
  if (session.sessionType === 'a2a') {
    return errorResult(
      'unsupported_session',
      'Runtime input submission is not supported for A2A sessions'
    );
  }
  return null;
}

function isCompletedSubmission(message: CoworkMessage): boolean {
  const metadata = message.metadata;
  if (metadata?.submissionResult !== 'completed') return false;
  if (metadata.submissionMode === 'continue') return true;
  return metadata.submissionMode === 'steer'
    && (metadata.steerStatus === 'delivered' || metadata.steerStatus === 'settled');
}

function resultFromExisting(message: CoworkMessage): CoworkSubmitInputResult {
  return {
    success: true,
    mode: message.metadata?.submissionMode === 'continue' ? 'continue' : 'steer',
    message,
  };
}

function clearSubmissionState(metadata: CoworkMessageMetadata | undefined): CoworkMessageMetadata {
  const {
    interactionKind: _interactionKind,
    submissionMode: _submissionMode,
    submissionResult: _submissionResult,
    submissionErrorCode: _submissionErrorCode,
    submissionFailureReason: _submissionFailureReason,
    steerStatus: _steerStatus,
    steerDeliveredAt: _steerDeliveredAt,
    steerSettledAt: _steerSettledAt,
    steerFailedAt: _steerFailedAt,
    steerCancelledAt: _steerCancelledAt,
    steerErrorCode: _steerErrorCode,
    steerFailureReason: _steerFailureReason,
    ...rest
  } = metadata ?? {};
  return rest;
}

function toContinueMetadata(
  metadata: CoworkMessageMetadata | undefined,
  submissionResult: 'pending' | 'completed' | 'failed'
): CoworkMessageMetadata {
  return {
    ...clearSubmissionState(metadata),
    submissionMode: 'continue',
    submissionResult,
  };
}

function toQueuedSteerMetadata(
  metadata: CoworkMessageMetadata | undefined,
  submissionId: string
): CoworkMessageMetadata {
  return {
    ...clearSubmissionState(metadata),
    interactionKind: 'steer',
    submissionId,
    submissionMode: 'steer',
    submissionResult: 'pending',
    steerStatus: 'queued',
  };
}

export class CoworkTurnSubmissionController {
  private readonly store: SubmissionStore;
  private readonly runner: SubmissionRunner;
  private readonly sanitizeSkillIds: CoworkTurnSubmissionDependencies['sanitizeSkillIds'];
  private readonly emitMessage: CoworkTurnSubmissionDependencies['emitMessage'];
  private readonly emitMessageUpdate: CoworkTurnSubmissionDependencies['emitMessageUpdate'];
  private readonly inFlightSubmissions = new Map<string, {
    sessionId: string;
    text: string;
    promise: Promise<CoworkSubmitInputResult>;
  }>();
  private readonly handleSteerSettled = (sessionId: string, submissionId: string): void => {
    this.markSteerSettled(sessionId, submissionId);
  };
  private readonly handleSteerFailed = (
    sessionId: string,
    submissionId: string,
    reason: string
  ): void => {
    this.markSteerFailed(sessionId, submissionId, reason);
  };
  private readonly handleSteerCancelled = (
    sessionId: string,
    submissionId: string,
    reason: string
  ): void => {
    this.markSteerCancelled(sessionId, submissionId, reason);
  };

  constructor(dependencies: CoworkTurnSubmissionDependencies) {
    this.store = dependencies.store;
    this.runner = dependencies.runner;
    this.sanitizeSkillIds = dependencies.sanitizeSkillIds;
    this.emitMessage = dependencies.emitMessage;
    this.emitMessageUpdate = dependencies.emitMessageUpdate;

    this.runner.on?.('steerSettled', this.handleSteerSettled);
    this.runner.on?.('steerFailed', this.handleSteerFailed);
    this.runner.on?.('steerCancelled', this.handleSteerCancelled);
  }

  submit(input: CoworkSubmitInput): Promise<CoworkSubmitInputResult> {
    const sessionId = typeof input?.sessionId === 'string' ? input.sessionId.trim() : '';
    const submissionId = typeof input?.submissionId === 'string' ? input.submissionId.trim() : '';
    const requestedText = typeof input?.text === 'string' ? input.text.trim() : '';
    if (!sessionId || !SUBMISSION_ID_RE.test(submissionId) || !requestedText) {
      return Promise.resolve(
        errorResult('invalid_input', 'Session ID, submission UUID, and text are required')
      );
    }

    const inFlight = this.inFlightSubmissions.get(submissionId);
    if (inFlight) {
      if (inFlight.sessionId === sessionId && inFlight.text === requestedText) {
        return inFlight.promise;
      }
      return Promise.resolve(errorResult(
        'invalid_input',
        'Submission UUID is already associated with different input'
      ));
    }

    let resolvePending!: (result: CoworkSubmitInputResult) => void;
    let rejectPending!: (reason?: unknown) => void;
    const pending = new Promise<CoworkSubmitInputResult>((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });
    this.inFlightSubmissions.set(submissionId, { sessionId, text: requestedText, promise: pending });
    const clear = () => {
      if (this.inFlightSubmissions.get(submissionId)?.promise === pending) {
        this.inFlightSubmissions.delete(submissionId);
      }
    };
    void pending.then(clear, clear);
    // Start only after publishing the deferred promise. Store and renderer
    // callbacks may synchronously reenter submit() with the same UUID.
    void this.submitOnce(input).then(resolvePending, rejectPending);
    return pending;
  }

  dispose(): void {
    this.runner.off?.('steerSettled', this.handleSteerSettled);
    this.runner.off?.('steerFailed', this.handleSteerFailed);
    this.runner.off?.('steerCancelled', this.handleSteerCancelled);
  }

  private async submitOnce(input: CoworkSubmitInput): Promise<CoworkSubmitInputResult> {
    const sessionId = typeof input?.sessionId === 'string' ? input.sessionId.trim() : '';
    const submissionId = typeof input?.submissionId === 'string' ? input.submissionId.trim() : '';
    const requestedText = typeof input?.text === 'string' ? input.text.trim() : '';
    if (!sessionId || !SUBMISSION_ID_RE.test(submissionId) || !requestedText) {
      return errorResult('invalid_input', 'Session ID, submission UUID, and text are required');
    }

    const ownerSessionId = this.store.getMessageOwnerSessionId?.(submissionId);
    if (ownerSessionId && ownerSessionId !== sessionId) {
      return errorResult(
        'invalid_input',
        'Submission UUID is already associated with different input'
      );
    }

    const existing = this.store.getMessageById(sessionId, submissionId);
    if (existing) {
      const isMatchingUserInput = existing.type === 'user'
        && existing.content === requestedText
        && (!existing.metadata?.submissionId || existing.metadata.submissionId === submissionId);
      if (!isMatchingUserInput) {
        return errorResult(
          'invalid_input',
          'Submission UUID is already associated with different input'
        );
      }
    }
    if (existing && isCompletedSubmission(existing)) {
      return resultFromExisting(existing);
    }
    if (existing) {
      const isRetryableFailedSteer = existing.metadata?.interactionKind === 'steer'
        && existing.metadata.submissionMode === 'steer'
        && existing.metadata.submissionResult === 'failed'
        && existing.metadata.steerStatus === 'failed';
      if (!isRetryableFailedSteer) {
        return errorResult(
          'invalid_input',
          'Submission UUID is not retryable'
        );
      }
    }

    const initialSession = this.store.getSession(sessionId);
    const sessionError = validateStandardSession(initialSession);
    if (sessionError) return sessionError;

    // This synchronous capability -> persistence -> admission segment is the
    // authority for the steer/Continue race. Do not add an await inside it.
    const capability = this.runner.getSteerCapability(sessionId);
    if (capability === 'sandbox') {
      return errorResult(
        'unsupported_execution',
        'Runtime steer currently supports local execution only'
      );
    }

    // Steers admitted live into a running turn (both kernels).
    const steerAdmission = capability === 'open-local' || capability === 'open-dsh';
    const interactionKind = steerAdmission || capability === 'closing-local'
      ? 'steer'
      : undefined;
    const sourceMetadata = input.source ? { source: input.source } : {};
    const originMetadata = input.origin
      ? { origin: input.origin, ...(input.originLabel ? { originLabel: input.originLabel } : {}) }
      : {};
    // Jump anchors for the sent quote blocks (see CoworkSubmitInput). Only
    // non-empty string ids ever persist, so a malformed input degrades to the
    // renderer's ordinal fallback instead of writing junk metadata.
    const quotedIds = Array.isArray(input.quotedMessageIds)
      ? input.quotedMessageIds.filter((id) => typeof id === 'string' && id.trim() !== '')
      : [];
    const quotedMetadata = quotedIds.length > 0 ? { quotedMessageIds: quotedIds } : {};
    const message = existing ?? this.store.addMessageWithId(sessionId, submissionId, {
      type: 'user',
      content: requestedText,
      metadata: interactionKind
        ? {
            ...sourceMetadata,
            ...originMetadata,
            ...quotedMetadata,
            interactionKind,
            submissionId,
            submissionMode: 'steer',
            submissionResult: 'pending',
            steerStatus: 'queued',
          }
        : {
            ...sourceMetadata,
            ...originMetadata,
            ...quotedMetadata,
            submissionId,
            submissionMode: 'continue',
            submissionResult: 'pending',
          },
    });
    if (!existing) {
      this.emitMessage(sessionId, message);
    } else if (message.metadata?.submissionResult !== 'pending') {
      const retryMetadata: CoworkMessageMetadata = interactionKind
        ? toQueuedSteerMetadata(message.metadata, submissionId)
        : toContinueMetadata(message.metadata, 'pending');
      this.persistAndEmit(sessionId, message, retryMetadata);
    }

    // An idempotency retry keeps the originally persisted visible text.
    const text = message.content;
    // Set when a human message interrupted a kernel-initiated turn below; the
    // follow-up Continue owns the gate once startSession begins, so only a
    // failed Continue must release it.
    let interruptedKernelTurn = false;
    if (steerAdmission) {
      const admission = this.runner.trySubmitSteer(sessionId, submissionId, text);
      if (admission.accepted) {
        let degradedToContinue = false;
        try {
          await admission.delivered;
        } catch (error) {
          if (error instanceof CoworkDshSteerWindowClosedError) {
            // DSH best-effort steer (official semantics): the window closed
            // before the RPC landed. Degrade to the Continue flow below so
            // the text becomes the next turn's input instead of erroring —
            // but a terminal steer state that already landed wins.
            const current = this.store.getMessageById(sessionId, submissionId) ?? message;
            if (current.metadata?.steerStatus === 'cancelled') {
              return errorResult(
                'cancelled',
                String(current.metadata.steerFailureReason || 'Cowork session stopped')
              );
            }
            if (current.metadata?.steerStatus === 'failed') {
              return errorResult(
                'delivery_failed',
                String(current.metadata.steerFailureReason || 'Steer delivery failed')
              );
            }
            if (current.metadata?.steerStatus === 'settled') {
              return { success: true, mode: 'steer', message: current };
            }
            degradedToContinue = true;
          } else {
            const reason = error instanceof Error ? error.message : 'Steer delivery failed';
            const current = this.store.getMessageById(sessionId, submissionId) ?? message;
            if (current.metadata?.steerStatus === 'cancelled') {
              return errorResult(
                'cancelled',
                String(current.metadata.steerFailureReason || reason)
              );
            }
            this.markSteerFailed(sessionId, submissionId, reason);
            return errorResult('delivery_failed', reason);
          }
        }

        if (degradedToContinue) {
          // The turn whose window closed must fully settle before the
          // fallback Continue can start its own turn.
          await this.runner.waitForActiveTurnSettlement(sessionId);
        } else {
          const delivered = this.store.getMessageById(sessionId, submissionId) ?? message;
          if (delivered.metadata?.steerStatus === 'cancelled') {
            return errorResult(
              'cancelled',
              String(delivered.metadata.steerFailureReason || 'Cowork session stopped')
            );
          }
          if (delivered.metadata?.steerStatus === 'failed') {
            return errorResult(
              'delivery_failed',
              String(delivered.metadata.steerFailureReason || 'Steer delivery failed')
            );
          }
          if (delivered.metadata?.steerStatus === 'settled') {
            return { success: true, mode: 'steer', message: delivered };
          }
          const deliveredMetadata: CoworkMessageMetadata = {
            ...delivered.metadata,
            interactionKind: 'steer',
            submissionId,
            submissionMode: 'steer',
            submissionResult: 'completed',
            steerStatus: 'delivered',
            steerDeliveredAt: Date.now(),
          };
          this.persistAndEmit(sessionId, delivered, deliveredMetadata);
          return {
            success: true,
            mode: 'steer',
            message: this.store.getMessageById(sessionId, submissionId) ?? delivered,
          };
        }
      } else {
        await this.runner.waitForActiveTurnSettlement(sessionId);
      }
    } else if (capability === 'closing-local') {
      await this.runner.waitForActiveTurnSettlement(sessionId);
    } else if (capability === 'inactive') {
      // Kernel-initiated turns (subagent wakes, scheduled nudges) have no
      // host turn to steer, but a human interjection still interrupts: abort
      // at the kernel, then the Continue flow below starts the human's turn.
      // Machine-originated messages never reach this path (they queue behind
      // the cross-session gate).
      interruptedKernelTurn = await this.runner.interruptKernelTurnForHumanInput(sessionId);
    }

    if (interactionKind === 'steer' && this.runner.wasSessionStopped(sessionId)) {
      const reason = 'Cowork session stopped';
      this.markSteerCancelled(sessionId, submissionId, reason);
      return errorResult('cancelled', reason);
    }

    const currentSession = this.store.getSession(sessionId);
    const currentSessionError = validateStandardSession(currentSession);
    if (currentSessionError) {
      this.markSubmissionFailed(sessionId, message, currentSessionError.code, currentSessionError.error);
      return currentSessionError;
    }

    const continuing = this.store.getMessageById(sessionId, submissionId) ?? message;
    this.persistAndEmit(
      sessionId,
      continuing,
      toContinueMetadata(continuing.metadata, 'pending')
    );

    try {
      // Guard the cacheable prompt head: the renderer's rebuilt combined
      // prompt embeds the LIVE MetaApp/Skill catalogs, so forwarding it every
      // turn would let catalog drift reset the SDK session and re-cache the
      // whole context. Keep the persisted prompt unless the skill set actually
      // changed this turn (see coworkPromptStrategy). currentSession is the
      // freshest read — the steer wait above can span a whole prior turn.
      // Pinned-skill backstop first: renderer-supplied ids are intersected
      // with the session bot's visible set before any consumer below.
      const requestedSkillIds = this.sanitizeSkillIds
        ? this.sanitizeSkillIds(input.activeSkillIds, currentSession.metabotId ?? null)
        : input.activeSkillIds;
      const resolvedSystemPrompt = resolveContinueSystemPrompt({
        persistedSystemPrompt: currentSession.systemPrompt,
        requestedSystemPrompt: input.systemPrompt,
        activeSkillIds: requestedSkillIds,
        persistedActiveSkillIds: currentSession.activeSkillIds,
      });
      await this.runner.continueSession(sessionId, buildOwnerTurnInputPrompt(text), {
        skipUserMessage: true,
        // The owner typed this in the composer: mark the turn owner-initiated
        // so the assistant-mode first-sentence bubble fires on follow-ups too
        // (the message is already persisted above, hence skipUserMessage).
        acknowledgeOwner: true,
        systemPrompt: resolvedSystemPrompt,
        skillIds: requestedSkillIds,
      });
    } catch (error) {
      // The Continue never started its turn, so it cannot release the gate
      // held since the kernel-turn interrupt — release it here or queued
      // cross-session messages would stay parked forever.
      if (interruptedKernelTurn) this.runner.releaseKernelTurnInterrupt(sessionId);
      const reason = error instanceof Error ? error.message : 'Failed to continue Cowork session';
      this.markSubmissionFailed(sessionId, message, 'delivery_failed', reason);
      return errorResult('delivery_failed', reason);
    }

    const continued = this.store.getMessageById(sessionId, submissionId) ?? message;
    const continuedMetadata = toContinueMetadata(continued.metadata, 'completed');
    this.persistAndEmit(sessionId, continued, continuedMetadata);
    return {
      success: true,
      mode: 'continue',
      message: this.store.getMessageById(sessionId, submissionId) ?? continued,
    };
  }

  private markSteerSettled(sessionId: string, submissionId: string): void {
    const message = this.store.getMessageById(sessionId, submissionId);
    if (!message || message.metadata?.interactionKind !== 'steer') return;
    if (message.metadata.steerStatus === 'settled') return;
    if (message.metadata.steerStatus === 'failed' || message.metadata.steerStatus === 'cancelled') return;
    const metadata: CoworkMessageMetadata = {
      ...message.metadata,
      submissionMode: 'steer',
      submissionResult: 'completed',
      steerStatus: 'settled',
      steerSettledAt: Date.now(),
    };
    this.persistAndEmit(sessionId, message, metadata);
  }

  private markSteerFailed(sessionId: string, submissionId: string, reason: string): void {
    const message = this.store.getMessageById(sessionId, submissionId);
    if (!message || message.metadata?.interactionKind !== 'steer') return;
    if (message.metadata.steerStatus === 'failed') return;
    if (
      message.metadata.steerStatus === 'settled'
      || message.metadata.steerStatus === 'cancelled'
    ) return;
    const metadata: CoworkMessageMetadata = {
      ...message.metadata,
      submissionMode: 'steer',
      submissionResult: 'failed',
      steerStatus: 'failed',
      steerFailedAt: Date.now(),
      steerErrorCode: 'delivery_failed',
      steerFailureReason: reason,
    };
    this.persistAndEmit(sessionId, message, metadata);
  }

  private markSteerCancelled(sessionId: string, submissionId: string, reason: string): void {
    const message = this.store.getMessageById(sessionId, submissionId);
    if (!message || message.metadata?.interactionKind !== 'steer') return;
    if (message.metadata.steerStatus !== 'queued') return;
    const metadata: CoworkMessageMetadata = {
      ...message.metadata,
      submissionMode: 'steer',
      submissionResult: 'failed',
      submissionErrorCode: 'cancelled',
      submissionFailureReason: reason,
      steerStatus: 'cancelled',
      steerCancelledAt: Date.now(),
      steerErrorCode: 'cancelled',
      steerFailureReason: reason,
    };
    this.persistAndEmit(sessionId, message, metadata);
  }

  private markSubmissionFailed(
    sessionId: string,
    message: CoworkMessage,
    code: CoworkSubmitInputErrorCode,
    reason: string
  ): void {
    const current = this.store.getMessageById(sessionId, message.id) ?? message;
    const metadata: CoworkMessageMetadata = current.metadata?.interactionKind === 'steer'
      ? {
          ...clearSubmissionState(current.metadata),
          interactionKind: 'steer',
          submissionId: current.metadata.submissionId,
          submissionMode: 'steer',
          submissionResult: 'failed',
          steerStatus: 'failed',
          steerFailedAt: Date.now(),
          steerErrorCode: code,
          steerFailureReason: reason,
          submissionErrorCode: code,
          submissionFailureReason: reason,
        }
      : {
          ...toContinueMetadata(current.metadata, 'failed'),
          submissionErrorCode: code,
          submissionFailureReason: reason,
        };
    this.persistAndEmit(sessionId, current, metadata);
  }

  private persistAndEmit(
    sessionId: string,
    message: CoworkMessage,
    metadata: CoworkMessageMetadata
  ): void {
    this.store.updateMessage(sessionId, message.id, { metadata });
    message.metadata = metadata;
    this.emitMessageUpdate(sessionId, message.id, message.content, metadata);
  }
}
