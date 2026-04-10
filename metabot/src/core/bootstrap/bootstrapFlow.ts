import {
  runCreateMetabotStep,
  type BootstrapCreateRequest,
  type BootstrapCreateStep
} from './createMetabot';
import {
  runRequestSubsidyStep,
  type BootstrapRequestSubsidyStep,
  type BootstrapSubsidyContext,
  type BootstrapSubsidyResult
} from './requestSubsidy';
import {
  runSyncIdentityToChainStep,
  type BootstrapSyncContext,
  type BootstrapSyncResult,
  type BootstrapSyncStep
} from './syncIdentityToChain';

export type BootstrapPhase = 'identity_created' | 'subsidy_requested' | 'syncing' | 'ready' | 'failed';

export interface BootstrapProgress {
  phase: BootstrapPhase;
  retryable: boolean;
  manualActionRequired: boolean;
}

export interface BootstrapFlowOptions<TRequest extends BootstrapCreateRequest, TMetabot> {
  request: TRequest;
  createMetabot: BootstrapCreateStep<TRequest, TMetabot>;
  requestSubsidy: BootstrapRequestSubsidyStep<TRequest, TMetabot>;
  syncIdentityToChain: BootstrapSyncStep<TRequest, TMetabot>;
  onProgress?: (progress: BootstrapProgress) => void;
  wait?: (ms: number) => Promise<void>;
  syncRetryDelayMs?: number;
}

export interface BootstrapFlowResult<TMetabot> extends BootstrapProgress {
  success: boolean;
  metabot?: TMetabot;
  subsidy: BootstrapSubsidyResult;
  sync?: BootstrapSyncResult;
  canSkip?: boolean;
  error?: string;
}

const DEFAULT_SYNC_RETRY_DELAY_MS = 2_500;

function emitProgress(
  onProgress: BootstrapFlowOptions<BootstrapCreateRequest, unknown>['onProgress'],
  phase: BootstrapPhase,
  retryable: boolean,
  manualActionRequired: boolean
): BootstrapProgress {
  const progress = { phase, retryable, manualActionRequired };
  onProgress?.(progress);
  return progress;
}

export async function runBootstrapFlow<TRequest extends BootstrapCreateRequest, TMetabot>(
  options: BootstrapFlowOptions<TRequest, TMetabot>
): Promise<BootstrapFlowResult<TMetabot>> {
  const wait = options.wait ?? (async () => {});
  const syncRetryDelayMs = options.syncRetryDelayMs ?? DEFAULT_SYNC_RETRY_DELAY_MS;

  try {
    const created = await runCreateMetabotStep(options.createMetabot, options.request);
    emitProgress(options.onProgress, 'identity_created', false, false);

    const subsidyContext: BootstrapSubsidyContext<TRequest, TMetabot> = {
      request: options.request,
      metabot: created.metabot,
      subsidyInput: created.subsidyInput
    };
    const subsidy = await runRequestSubsidyStep(options.requestSubsidy, subsidyContext);
    emitProgress(options.onProgress, 'subsidy_requested', false, false);

    const syncContext: BootstrapSyncContext<TRequest, TMetabot> = {
      request: options.request,
      metabot: created.metabot,
      subsidy
    };
    emitProgress(options.onProgress, 'syncing', false, false);

    let sync = await runSyncIdentityToChainStep(options.syncIdentityToChain, syncContext);
    if (!sync.success) {
      await wait(syncRetryDelayMs);
      sync = await runSyncIdentityToChainStep(options.syncIdentityToChain, syncContext);
    }

    if (sync.success) {
      const ready = emitProgress(options.onProgress, 'ready', false, false);
      return {
        success: true,
        metabot: created.metabot,
        subsidy,
        sync,
        ...ready
      };
    }

    const failed = emitProgress(options.onProgress, 'failed', true, Boolean(sync.canSkip));
    return {
      success: false,
      metabot: created.metabot,
      subsidy,
      sync,
      canSkip: sync.canSkip,
      error: sync.error,
      ...failed
    };
  } catch (error) {
    const failed = emitProgress(options.onProgress, 'failed', false, false);
    return {
      success: false,
      subsidy: { success: false },
      error: error instanceof Error ? error.message : String(error),
      ...failed
    };
  }
}
