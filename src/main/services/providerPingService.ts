import { normalizeRawGlobalMetaId } from '../shared/globalMetaId';
import { resolveMetabotDistModulePath } from '../libs/runtimePaths';

type PendingPrivateMessage = {
  id?: number | null;
  from_global_metaid?: string | null;
  from_metaid?: string | null;
  to_global_metaid?: string | null;
  content?: string | null;
  from_chat_pubkey?: string | null;
};

type WalletLike = {
  mnemonic?: string | null;
  path?: string | null;
} | null | undefined;

export interface ProviderPingServiceDeps {
  getWallet(metabotId: number): WalletLike;
  getLocalGlobalMetaId(metabotId: number): string | null | undefined;
  derivePrivateKeyBuffer(mnemonic: string, path: string): Promise<Buffer>;
  computeSharedSecretSha256(privateKeyBuffer: Buffer, peerPubkey: string): string;
  computeSharedSecret(privateKeyBuffer: Buffer, peerPubkey: string): string;
  encrypt(plainText: string, sharedSecret: string): string;
  decrypt(cipherText: string, sharedSecret: string): string;
  buildPrivateMessagePayload(to: string, encryptedContent: string, replyPin?: string): string;
  createPin(metabotId: number, payload: string): Promise<void>;
  listPendingMessages(): PendingPrivateMessage[];
  listRecentMessages?: () => PendingPrivateMessage[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
}

export interface PingProviderParams {
  metabotId: number;
  toGlobalMetaId: string;
  toChatPubkey: string;
  timeoutMs?: number;
}

export type DelegationOrderabilityStatus = 'available' | 'offline' | 'missing';

export interface ResolveDelegationOrderabilityParams {
  availableServices: any[];
  allServices: any[];
  servicePinId: string;
  providerGlobalMetaId: string;
}

export interface ResolveDelegationOrderabilityResult {
  status: DelegationOrderabilityStatus;
  service: any | null;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_DERIVATION_PATH = "m/44'/10001'/0'/0/0";

const toSafeString = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
};

const normalizeComparableGlobalMetaId = (value: unknown): string => {
  return normalizeRawGlobalMetaId(value) ?? toSafeString(value);
};

const normalizeWord = (value: string): string => value.toLowerCase().replace(/[^a-z]/g, '');

const isPongPlaintext = (value: string): boolean => {
  return Boolean(value && normalizeWord(value.trim()) === 'pong');
};

const getServicePinCandidates = (service: any): string[] => (
  [...new Set([
    service?.id,
    service?.pinId,
    service?.servicePinId,
    service?.currentPinId,
    service?.sourceServicePinId,
    ...(Array.isArray(service?.chainPinIds) ? service.chainPinIds : []),
  ].map((value) => toSafeString(value)).filter(Boolean))]
);

const serviceMatches = (service: any, servicePinId: string, providerGlobalMetaId: string): boolean => {
  return (
    getServicePinCandidates(service).includes(toSafeString(servicePinId)) &&
    normalizeComparableGlobalMetaId(service?.providerGlobalMetaId || service?.globalMetaId)
      === normalizeComparableGlobalMetaId(providerGlobalMetaId)
  );
};

const resolveMessageCursor = (messages: PendingPrivateMessage[]): number => {
  let latestId = 0;
  for (const message of messages) {
    const messageId = typeof message?.id === 'number' && Number.isFinite(message.id)
      ? Math.trunc(message.id)
      : 0;
    if (messageId > latestId) {
      latestId = messageId;
    }
  }
  return latestId;
};

export function resolveDelegationOrderability(
  params: ResolveDelegationOrderabilityParams,
): ResolveDelegationOrderabilityResult {
  const availableService = params.availableServices.find((service) => (
    serviceMatches(service, params.servicePinId, params.providerGlobalMetaId)
  ));
  if (availableService) {
    return { status: 'available', service: availableService };
  }

  const dbService = params.allServices.find((service) => (
    serviceMatches(service, params.servicePinId, params.providerGlobalMetaId)
  ));
  if (dbService) {
    return { status: 'offline', service: null };
  }

  return { status: 'missing', service: null };
}

export class ProviderPingService {
  private readonly deps: Required<Pick<ProviderPingServiceDeps, 'now' | 'sleep' | 'pollIntervalMs'>> & ProviderPingServiceDeps;

  constructor(deps: ProviderPingServiceDeps) {
    this.deps = {
      ...deps,
      now: deps.now ?? (() => Date.now()),
      sleep: deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
      pollIntervalMs: deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    };
  }

  async pingProvider(params: PingProviderParams): Promise<boolean> {
    const metabotId = typeof params.metabotId === 'number' ? params.metabotId : -1;
    const toGlobalMetaId = normalizeComparableGlobalMetaId(params.toGlobalMetaId);
    const toChatPubkey = toSafeString(params.toChatPubkey);
    const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : DEFAULT_TIMEOUT_MS;

    if (metabotId < 0 || !toGlobalMetaId || !toChatPubkey) {
      throw new Error('Missing required params');
    }

    const wallet = this.deps.getWallet(metabotId);
    if (!wallet?.mnemonic?.trim()) {
      throw new Error('MetaBot wallet mnemonic is missing');
    }

    const privateKeyBuffer = await this.deps.derivePrivateKeyBuffer(
      wallet.mnemonic,
      wallet.path || DEFAULT_DERIVATION_PATH,
    );
    const sharedSecret = this.deps.computeSharedSecretSha256(privateKeyBuffer, toChatPubkey);
    const encryptedPing = this.deps.encrypt('ping', sharedSecret);
    const pingPayload = this.deps.buildPrivateMessagePayload(toGlobalMetaId, encryptedPing, '');
    const listRecentMessages = this.deps.listRecentMessages ?? this.deps.listPendingMessages;
    const initialMessageCursor = resolveMessageCursor(listRecentMessages());

    await this.deps.createPin(metabotId, pingPayload);

    const deadline = this.deps.now() + timeoutMs;
    const myGlobalMetaId = normalizeComparableGlobalMetaId(this.deps.getLocalGlobalMetaId(metabotId));

    while (true) {
      const messages = listRecentMessages();
      for (const message of messages) {
        const messageId = typeof message?.id === 'number' && Number.isFinite(message.id)
          ? Math.trunc(message.id)
          : null;
        if (messageId != null && messageId <= initialMessageCursor) continue;

        const fromGlobal = normalizeComparableGlobalMetaId(message.from_global_metaid || message.from_metaid);
        const toGlobal = normalizeComparableGlobalMetaId(message.to_global_metaid);
        if (fromGlobal !== toGlobalMetaId) continue;
        if (myGlobalMetaId && toGlobal && toGlobal !== myGlobalMetaId) continue;

        const cipherText = toSafeString(message.content);
        const peerPubkey = toSafeString(message.from_chat_pubkey) || toChatPubkey;

        if (isPongPlaintext(cipherText)) {
          return true;
        }
        if (this.tryDecryptPong(cipherText, privateKeyBuffer, peerPubkey, true)) {
          return true;
        }
        if (this.tryDecryptPong(cipherText, privateKeyBuffer, peerPubkey, false)) {
          return true;
        }
      }

      if (this.deps.now() >= deadline) {
        return false;
      }

      await this.deps.sleep(this.deps.pollIntervalMs);
    }
  }

  private tryDecryptPong(
    cipherText: string,
    privateKeyBuffer: Buffer,
    peerPubkey: string,
    useSha256: boolean,
  ): boolean {
    try {
      const sharedSecret = useSha256
        ? this.deps.computeSharedSecretSha256(privateKeyBuffer, peerPubkey)
        : this.deps.computeSharedSecret(privateKeyBuffer, peerPubkey);
      const plain = this.deps.decrypt(cipherText, sharedSecret);
      return Boolean(plain && normalizeWord(plain.trim()) === 'pong');
    } catch {
      return false;
    }
  }
}
