/**
 * MVC Gas Subsidy Service
 * Requests MVC chain fee subsidy from Metaso remote API.
 * Decoupled from wallet creation; accepts mvcAddress (required) and optional mnemonic for full two-step flow.
 */

import {
  BtcWallet,
  AddressType,
  CoinType,
  type Net,
} from '@metalet/utxo-wallet-service';

const DEFAULT_PATH = "m/44'/10001'/0'/0/0";
const ADDRESS_INIT_URL = 'https://www.metaso.network/assist-open-api/v1/assist/gas/mvc/address-init';
const ADDRESS_REWARD_URL = 'https://www.metaso.network/assist-open-api/v1/assist/gas/mvc/address-reward';
const SUBSIDY_WAIT_MS = 5000;
const CREDENTIAL_MESSAGE = 'metaso.network';

export interface RequestMvcGasSubsidyOptions {
  mvcAddress: string;
  mnemonic?: string;
  path?: string;
}

export interface RequestMvcGasSubsidyResult {
  success: boolean;
  step1?: unknown;
  step2?: unknown;
  error?: string;
}

/** Parse addressIndex from BIP44 path (e.g. m/44'/10001'/0'/0/0 -> 0) */
function parseAddressIndexFromPath(path: string): number {
  if (!path || typeof path !== 'string') return 0;
  const m = path.match(/\/0\/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

function getNet(): Net {
  return 'livenet' as Net;
}

async function getBtcWalletForCredential(mnemonic: string, addressIndex: number): Promise<BtcWallet> {
  const network = getNet();
  return new BtcWallet({
    coinType: CoinType.MVC,
    addressType: AddressType.SameAsMvc,
    addressIndex,
    network,
    mnemonic,
  });
}

/** Get credential for signing (X-Signature, X-Public-Key) */
async function getCredential(
  mnemonic: string,
  path: string
): Promise<{ signature: string; publicKey: string }> {
  const addressIndex = parseAddressIndexFromPath(path);
  const wallet = await getBtcWalletForCredential(mnemonic, addressIndex);
  const signature = wallet.signMessage(CREDENTIAL_MESSAGE, 'base64');
  const publicKey = wallet.getPublicKey().toString('hex');
  return { signature, publicKey };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Request MVC gas subsidy for an address.
 * Step 1: address-init (no credential).
 * Step 2 (if mnemonic provided): wait 5s, then address-reward with signature.
 *
 * @param options.mvcAddress - Required MVC address
 * @param options.mnemonic - Optional; if provided, run full flow including address-reward
 * @param options.path - Optional; default m/44'/10001'/0'/0/0
 * @returns Result with success flag and raw responses
 */
export async function requestMvcGasSubsidy(
  options: RequestMvcGasSubsidyOptions
): Promise<RequestMvcGasSubsidyResult> {
  const { mvcAddress, mnemonic, path = DEFAULT_PATH } = options;

  if (!mvcAddress || typeof mvcAddress !== 'string') {
    return { success: false, error: 'mvcAddress is required' };
  }

  const body = { address: mvcAddress, gasChain: 'mvc' as const };
  const initBody = JSON.stringify(body);

  try {
    // Step 1: address-init
    const step1Res = await fetch(ADDRESS_INIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: initBody,
    });
    const step1Data = await step1Res.json();

    if (!step1Res.ok) {
      return {
        success: false,
        step1: step1Data,
        error: `address-init failed: ${step1Res.status} ${step1Res.statusText}`,
      };
    }

    if (!mnemonic || mnemonic.trim() === '') {
      return { success: true, step1: step1Data };
    }

    // Wait for subsidy processing
    await sleep(SUBSIDY_WAIT_MS);

    // Step 2: address-reward with credential
    const { signature, publicKey } = await getCredential(mnemonic.trim(), path);

    const step2Res = await fetch(ADDRESS_REWARD_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': signature,
        'X-Public-Key': publicKey,
      },
      body: initBody,
    });
    const step2Data = await step2Res.json();

    if (!step2Res.ok) {
      return {
        success: false,
        step1: step1Data,
        step2: step2Data,
        error: `address-reward failed: ${step2Res.status} ${step2Res.statusText}`,
      };
    }

    return { success: true, step1: step1Data, step2: step2Data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}
