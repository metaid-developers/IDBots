/** Typed read/write client for the Octopus Bridge v3 HTTP API. */

export interface OctopusAssetPair {
  network: 'BTC' | 'MRC20';
  originName?: string;
  originSymbol: string;
  originTokenId: string;
  targetName?: string;
  targetSymbol: string;
  targetTokenId: string;
  targetTokenCodeHash: string;
  targetTokenGenesis: string;
  feeRateNumeratorMint?: number;
  feeRateConstMint?: number;
  feeRateNumeratorRedeem?: number;
  feeRateConstRedeem?: number;
  decimals: number;
  trimDecimals: number;
  isBeta?: boolean;
  isEnableRedeem?: boolean;
  isEnableMint?: boolean;
  price?: number;
}

export interface OctopusAssetListData {
  net?: string;
  feeBtc: number;
  feeMvc: number;
  amountLimitMaximum: string | number;
  amountLimitMinimum: string | number;
  confirmSequence: Array<[number, number | null | undefined, number, number]>;
  transactionSize?: unknown;
  mintPaused?: boolean;
  mintPausedMessage?: string;
  assetList: OctopusAssetPair[];
}

export interface OctopusFeeQuote {
  scenario: 'btc_mint' | 'mrc20_mint' | 'btc_redeem' | 'mrc20_redeem';
  network: 'BTC' | 'MRC20';
  direction: 'mint' | 'redeem';
  btcFeeRate: number;
  mvcFeeRate: number;
  btcServiceFeeSats: number;
  mvcServiceFeeSats: number;
  estNetworkMinerBtcSats: number;
  estNetworkMinerMvcSats: number;
  btcBridgeMinerFeeSats: number;
  btcPostageSats: number;
  mvcBridgeMinerFeeSats: number;
  btcFeeSats: number;
  btcFeeAddress: string;
  mvcFeeSats: number;
  mvcFeeAddress: string;
  maxSingleMintAmount?: string | null;
  [key: string]: unknown;
}

export interface OctopusCreateOrderInput {
  amount: string;
  originTokenId: string;
  addressType: 'P2PKH';
  publicKey: string;
  publicKeySign: string;
  publicKeyReceive: string;
  publicKeyReceiveSign: string;
  btcFeeRate?: number;
}

export interface OctopusCreatedOrder {
  orderId: string;
  bridgeAddress: string;
  receiveAmount?: string;
  receiveAddress?: string;
  confirmNumber?: number;
  mvcServiceFeeSats?: number;
  mvcBridgeMinerFeeSats?: number;
  mvcFeeSats?: number;
  mvcFeeAddress?: string;
  btcServiceFeeSats?: number;
  btcBridgeMinerFeeSats?: number;
  btcPostageSats?: number;
  btcFeeSats?: number;
  btcFeeAddress?: string;
  btcFeeRate?: number;
  [key: string]: unknown;
}

export interface OctopusOrderStatusView {
  orderId: string;
  type: 'btcToMvc' | 'mrc20ToMvc' | 'mvcToBtc' | 'mvcToMrc20';
  originTokenId: string;
  originSymbol: string | null;
  targetSymbol: string | null;
  amount: string;
  receiveAmount: string;
  fromAddress: string;
  receiveAddress: string;
  status: 'doing' | 'success' | 'failed' | 'cancel';
  stage: 'awaiting_source_tx' | 'confirming' | 'paying_out' | 'completed' | 'failed' | 'cancelled';
  sourceChain: 'btc' | 'mvc';
  sourceTxid: string | null;
  sourceBlockHeight: number | null;
  sourceConfirmations: number | null;
  requiredConfirmations: number;
  targetChain: 'mvc' | 'btc';
  targetTxid: string | null;
  targetTxids: string[];
  failureReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export type OctopusOrderStatusResult =
  | { kind: 'ok'; data: OctopusOrderStatusView }
  | { kind: 'not_found' }
  | { kind: 'unsupported' };

export interface OctopusTransactionListRow {
  orderId?: string;
  originTxid?: string;
  targetTxid?: string;
  txid?: string;
  status?: string;
  type?: string;
  failureReason?: string;
  [key: string]: unknown;
}

export class OctopusBridgeApiError extends Error {
  readonly status: number;
  readonly bodyText: string;

  constructor(status: number, bodyText: string) {
    super(extractOctopusApiErrorMessage(bodyText) || `Octopus API HTTP ${status}`);
    this.status = status;
    this.bodyText = bodyText;
  }
}

export function extractOctopusApiErrorMessage(input: unknown): string {
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    for (const key of ['message', 'msg', 'error']) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (Array.isArray(value) && typeof value[0] === 'string') return value[0].trim();
    }
  }
  if (typeof input === 'string' && input.trim()) {
    try {
      const parsed = JSON.parse(input);
      const extracted = extractOctopusApiErrorMessage(parsed);
      if (extracted) return extracted;
    } catch {
      // fall through
    }
    return input.trim().slice(0, 1000);
  }
  return '';
}

interface ApiEnvelope<T> {
  success?: boolean;
  data?: T;
  msg?: string;
  message?: string;
  list?: T;
  [key: string]: unknown;
}

export interface OctopusBridgeClientDeps {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export class OctopusBridgeClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private unsupportedUntil = 0;

  constructor(deps: OctopusBridgeClientDeps = {}) {
    this.baseUrl = (deps.baseUrl || process.env.IDBOTS_OCTOPUS_API_BASE || 'https://api.octopus.space/api-bridge-v3').replace(/\/+$/, '');
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.timeoutMs = deps.timeoutMs ?? 15_000;
    this.now = deps.now ?? Date.now;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) throw new OctopusBridgeApiError(response.status, text);
      let parsed: ApiEnvelope<T> | T;
      try {
        parsed = text ? JSON.parse(text) : ({} as T);
      } catch {
        throw new Error(`Octopus API returned non-JSON: ${text.slice(0, 200)}`);
      }
      const envelope = parsed as ApiEnvelope<T>;
      if (envelope && typeof envelope === 'object' && envelope.success === false) {
        throw new Error(extractOctopusApiErrorMessage(envelope) || 'Octopus API request failed');
      }
      if (envelope && typeof envelope === 'object' && 'data' in envelope) {
        return envelope.data as T;
      }
      return parsed as T;
    } catch (error) {
      if (error instanceof OctopusBridgeApiError) throw error;
      if (controller.signal.aborted) throw new Error(`Octopus API timeout after ${this.timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async assetList(): Promise<OctopusAssetListData> {
    return this.request<OctopusAssetListData>('GET', '/assetList');
  }

  async feeQuote(params: {
    network: 'BTC' | 'MRC20';
    direction: 'mint' | 'redeem';
    originTokenId?: string;
    btcFeeRate?: number;
  }): Promise<OctopusFeeQuote> {
    const search = new URLSearchParams({ network: params.network, direction: params.direction });
    if (params.originTokenId) search.set('originTokenId', params.originTokenId);
    if (params.btcFeeRate !== undefined) search.set('btcFeeRate', String(params.btcFeeRate));
    return this.request<OctopusFeeQuote>('GET', `/feeQuote?${search}`);
  }

  createPrepayOrder(scenario: 'btc_mint' | 'mrc20_mint' | 'btc_redeem' | 'mrc20_redeem', input: OctopusCreateOrderInput): Promise<OctopusCreatedOrder> {
    const endpoint = {
      btc_mint: 'createPrepayOrderMintBtc',
      mrc20_mint: 'createPrepayOrderMintMrc20',
      btc_redeem: 'createPrepayOrderRedeemBtc',
      mrc20_redeem: 'createPrepayOrderRedeemMrc20',
    }[scenario];
    return this.request<OctopusCreatedOrder>('POST', `/${endpoint}`, input);
  }

  submitPrepayOrder(scenario: 'btc_mint' | 'mrc20_mint' | 'btc_redeem' | 'mrc20_redeem', input: Record<string, unknown>): Promise<{ success?: boolean; msg?: string }> {
    const endpoint = {
      btc_mint: 'submitPrepayOrderMintBtc',
      mrc20_mint: 'submitPrepayOrderMintMrc20',
      btc_redeem: 'submitPrepayOrderRedeemBtc',
      mrc20_redeem: 'submitPrepayOrderRedeemMrc20',
    }[scenario];
    return this.request('POST', `/${endpoint}`, input);
  }

  async getOrderStatus(orderId: string): Promise<OctopusOrderStatusResult> {
    if (this.unsupportedUntil > this.now()) return { kind: 'unsupported' };
    try {
      const data = await this.request<OctopusOrderStatusView>('GET', `/orderStatus?orderId=${encodeURIComponent(orderId)}`);
      return { kind: 'ok', data };
    } catch (error) {
      if (error instanceof OctopusBridgeApiError && error.status === 404) {
        const message = extractOctopusApiErrorMessage(error.bodyText);
        if (message.startsWith('Cannot GET')) {
          this.unsupportedUntil = this.now() + 10 * 60_000;
          return { kind: 'unsupported' };
        }
        return { kind: 'not_found' };
      }
      throw error;
    }
  }

  async queryTransactionsByAddress(params: {
    type: 'btcToMvc' | 'mrc20ToMvc' | 'mvcToBtc' | 'mvcToMrc20';
    address: string;
    size?: number;
  }): Promise<OctopusTransactionListRow[]> {
    const search = new URLSearchParams({
      type: params.type,
      address: params.address,
      size: String(params.size ?? 50),
    });
    const data = await this.request<unknown>('GET', `/queryTransactionsByAddress?${search}`);
    if (Array.isArray(data)) return data as OctopusTransactionListRow[];
    const rows = (data as { txList?: unknown; list?: unknown; data?: unknown })?.txList ?? (data as { list?: unknown; data?: unknown })?.list ?? (data as { data?: unknown })?.data;
    return Array.isArray(rows) ? (rows as OctopusTransactionListRow[]) : [];
  }
}
