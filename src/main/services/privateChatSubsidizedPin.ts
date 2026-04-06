import { requestMvcGasSubsidy, type RequestMvcGasSubsidyResult } from './mvcSubsidyService';

type WalletLike = {
  mnemonic?: string | null;
  path?: string | null;
};

type MetabotLike = {
  name?: string | null;
  mvc_address?: string | null;
};

export interface CreatePinWithMvcSubsidyRetryParams<T> {
  metabot: MetabotLike;
  wallet: WalletLike | null | undefined;
  createPin: () => Promise<T>;
  requestMvcGasSubsidy?: (options: {
    mvcAddress: string;
    mnemonic?: string;
    path?: string;
  }) => Promise<RequestMvcGasSubsidyResult>;
}

const DEFAULT_PATH = "m/44'/10001'/0'/0/0";

const toSafeString = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
};

export function isMvcInsufficientBalanceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /not enough balance|余额不足/i.test(message);
}

export async function createPinWithMvcSubsidyRetry<T>(
  params: CreatePinWithMvcSubsidyRetryParams<T>,
): Promise<T> {
  try {
    return await params.createPin();
  } catch (error) {
    if (!isMvcInsufficientBalanceError(error)) {
      throw error;
    }

    const mvcAddress = toSafeString(params.metabot?.mvc_address);
    const mnemonic = toSafeString(params.wallet?.mnemonic);
    if (!mvcAddress || !mnemonic) {
      throw error;
    }

    const subsidy = await (params.requestMvcGasSubsidy ?? requestMvcGasSubsidy)({
      mvcAddress,
      mnemonic,
      path: toSafeString(params.wallet?.path) || DEFAULT_PATH,
    });
    if (!subsidy.success) {
      throw new Error(subsidy.error || 'MVC gas subsidy request failed');
    }

    return await params.createPin();
  }
}
