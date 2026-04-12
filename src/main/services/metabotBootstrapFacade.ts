import path from 'node:path';
import type { MetabotStore } from '../metabotStore';
import type { Metabot, MetabotType } from '../types/metabot';
import { resolveMetabotDistModulePath } from '../libs/runtimePaths';
import {
  createMetaBotWallet,
  type CreateMetaBotWalletResult
} from './metabotWalletService';
import {
  requestMvcGasSubsidy,
  type RequestMvcGasSubsidyResult
} from './mvcSubsidyService';
import {
  syncMetaBotToChain,
  type SyncMetaBotResult
} from './metaidCore';

export interface BootstrapMetabotInput {
  name: string;
  avatar?: string | null;
  role: string;
  soul: string;
  goal?: string | null;
  background?: string | null;
  bossGlobalMetaId?: string | null;
  llmId: string;
  metabotType?: MetabotType;
}

export interface BootstrapMetabotResult {
  success: boolean;
  metabot?: Metabot;
  subsidy: RequestMvcGasSubsidyResult;
  sync?: SyncMetaBotResult;
  error?: string;
  canSkip?: boolean;
  retryable: boolean;
  manualActionRequired: boolean;
}

export interface BootstrapMetabotDeps {
  store: Pick<MetabotStore, 'insertMetabotWallet' | 'createMetabot' | 'getMetabotById'>;
  createWallet?: (options?: { mnemonic?: string; path?: string }) => Promise<CreateMetaBotWalletResult>;
  requestSubsidy?: (options: {
    mvcAddress: string;
    mnemonic?: string;
    path?: string;
  }) => Promise<RequestMvcGasSubsidyResult>;
  syncToChain?: (
    store: Pick<MetabotStore, 'getMetabotById' | 'getMetabotWalletByMetabotId'>,
    metabotId: number
  ) => Promise<SyncMetaBotResult>;
  syncP2PRuntimeConfig?: () => Promise<void>;
  wait?: (ms: number) => Promise<void>;
  syncRetryDelayMs?: number;
}

interface BootstrapFlowModule {
  runBootstrapFlow(options: {
    request: BootstrapMetabotInput;
    createMetabot: (request: BootstrapMetabotInput) => Promise<{
      metabot: Metabot;
      subsidyInput: {
        mvcAddress: string;
        mnemonic?: string;
        path?: string;
      };
    }>;
    requestSubsidy: (context: {
      request: BootstrapMetabotInput;
      metabot: Metabot;
      subsidyInput?: {
        mvcAddress: string;
        mnemonic?: string;
        path?: string;
      };
    }) => Promise<RequestMvcGasSubsidyResult>;
    syncIdentityToChain: (context: {
      request: BootstrapMetabotInput;
      metabot: Metabot;
      subsidy: RequestMvcGasSubsidyResult;
    }) => Promise<SyncMetaBotResult>;
    wait?: (ms: number) => Promise<void>;
    syncRetryDelayMs?: number;
  }): Promise<{
    success: boolean;
    metabot?: Metabot;
    subsidy: RequestMvcGasSubsidyResult;
    sync?: SyncMetaBotResult;
    error?: string;
    canSkip?: boolean;
    retryable: boolean;
    manualActionRequired: boolean;
  }>;
}

let cachedBootstrapFlowModule: BootstrapFlowModule | null = null;

function loadBootstrapFlowModule(): BootstrapFlowModule {
  if (cachedBootstrapFlowModule) {
    return cachedBootstrapFlowModule;
  }

  const modulePath = resolveMetabotDistModulePath('core/bootstrap/bootstrapFlow.js', { startDir: __dirname });
  cachedBootstrapFlowModule = require(modulePath) as BootstrapFlowModule;
  return cachedBootstrapFlowModule;
}

export async function bootstrapMetabot(
  input: BootstrapMetabotInput,
  deps: BootstrapMetabotDeps
): Promise<BootstrapMetabotResult> {
  const createWallet = deps.createWallet ?? createMetaBotWallet;
  const requestSubsidy = deps.requestSubsidy ?? requestMvcGasSubsidy;
  const syncToChain = deps.syncToChain ?? (syncMetaBotToChain as BootstrapMetabotDeps['syncToChain']);
  const runBootstrapFlow = loadBootstrapFlowModule().runBootstrapFlow;

  const result = await runBootstrapFlow({
    request: input,
    wait: deps.wait,
    syncRetryDelayMs: deps.syncRetryDelayMs,
    createMetabot: async (request) => {
      const walletResult = await createWallet({});
      const wallet = deps.store.insertMetabotWallet({
        mnemonic: walletResult.mnemonic,
        path: walletResult.path
      });
      const metabotType = request.metabotType === 'twin' ? 'twin' : 'worker';
      const metabot = deps.store.createMetabot({
        wallet_id: wallet.id,
        mvc_address: walletResult.mvc_address,
        btc_address: walletResult.btc_address,
        doge_address: walletResult.doge_address,
        public_key: walletResult.public_key,
        chat_public_key: walletResult.chat_public_key,
        chat_public_key_pin_id: null,
        name: request.name,
        avatar: request.avatar ?? null,
        enabled: true,
        metaid: walletResult.metaid,
        globalmetaid: walletResult.globalmetaid,
        metabot_info_pinid: null,
        metabot_type: metabotType,
        created_by: '0000',
        role: request.role,
        soul: request.soul,
        goal: request.goal ?? null,
        background: request.background ?? null,
        boss_id: null,
        boss_global_metaid: request.bossGlobalMetaId ?? null,
        llm_id: request.llmId,
        tools: [],
        skills: []
      });
      await deps.syncP2PRuntimeConfig?.();
      return {
        metabot,
        subsidyInput: {
          mvcAddress: metabot.mvc_address,
          mnemonic: walletResult.mnemonic,
          path: walletResult.path
        }
      };
    },
    requestSubsidy: async ({ subsidyInput }) => {
      return requestSubsidy({
        mvcAddress: subsidyInput?.mvcAddress ?? '',
        mnemonic: subsidyInput?.mnemonic,
        path: subsidyInput?.path
      });
    },
    syncIdentityToChain: async ({ metabot }) => {
      return syncToChain(
        deps.store as Pick<MetabotStore, 'getMetabotById' | 'getMetabotWalletByMetabotId'>,
        metabot.id
      );
    }
  });

  const latestMetabot = result.metabot
    ? deps.store.getMetabotById(result.metabot.id) ?? result.metabot
    : undefined;

  return {
    ...result,
    metabot: latestMetabot
  };
}
