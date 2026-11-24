import { ecdhEncrypt, computeEcdhSharedSecretSha256 } from './metaWebCrypto';
import { getPrivateKeyBufferForEcdh } from './metabotWalletService';
import type { MetaidDataPayload } from './metaidCore';
import { assertNoSecretEgressText } from '../security/secretEgressGuard';

const DEFAULT_WALLET_PATH = "m/44'/10001'/0'/0/0";
const DEFAULT_CONTENT_TYPE = 'text/markdown';

export interface SimplemsgWalletInput {
  mnemonic: string;
  path?: string | null;
}

export type MetaidDataPayloadInput = MetaidDataPayload;

export interface BuildPrivateMessagePayloadInput {
  to: string;
  encryptedContent: string;
  replyPin?: string | null;
  contentType?: string | null;
  nowSeconds?: number | (() => number);
}

export interface SendEncryptedSimplemsgInput {
  metabotId: number;
  wallet: SimplemsgWalletInput;
  peerGlobalMetaId: string;
  peerChatPubkey: string;
  plaintext: string;
  replyPin?: string | null;
  contentType?: string | null;
  nowSeconds?: number | (() => number);
  createPin: (
    metabotId: number,
    payload: MetaidDataPayloadInput
  ) => Promise<SendEncryptedSimplemsgResult> | SendEncryptedSimplemsgResult;
}

export interface SendEncryptedSimplemsgResult {
  txids: string[];
  pinId: string;
  /** createPin passthrough fields (traffic-mode fee-channel trace); optional. */
  totalCost?: number;
  feeAssist?: unknown;
}

const nowSecondsValue = (nowSeconds?: number | (() => number)): number => {
  const value = typeof nowSeconds === 'function'
    ? nowSeconds()
    : nowSeconds ?? Math.floor(Date.now() / 1000);
  const timestamp = Math.floor(Number(value));
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw new Error('simplemsg timestamp must be a positive finite Unix seconds value');
  }
  return timestamp;
};

const requireNonEmpty = (value: unknown, field: string): string => {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    throw new Error(`${field} is required`);
  }
  return trimmed;
};

export const buildPrivateMessagePayload = (input: BuildPrivateMessagePayloadInput): string => {
  const to = requireNonEmpty(input.to, 'to');
  const encryptedContent = requireNonEmpty(input.encryptedContent, 'encryptedContent');
  const body = {
    to,
    timestamp: nowSecondsValue(input.nowSeconds),
    content: encryptedContent,
    contentType: String(input.contentType ?? DEFAULT_CONTENT_TYPE).trim() || DEFAULT_CONTENT_TYPE,
    encrypt: 'ecdh',
    replyPin: String(input.replyPin ?? '').trim(),
  };
  return JSON.stringify(body);
};

export const sendEncryptedSimplemsg = async (input: SendEncryptedSimplemsgInput): Promise<SendEncryptedSimplemsgResult> => {
  if (!Number.isInteger(input.metabotId) || input.metabotId <= 0) {
    throw new Error('metabotId must be a positive integer');
  }

  const mnemonic = requireNonEmpty(input.wallet?.mnemonic, 'wallet mnemonic');
  const peerGlobalMetaId = requireNonEmpty(input.peerGlobalMetaId, 'peerGlobalMetaId');
  const peerChatPubkey = requireNonEmpty(input.peerChatPubkey, 'peerChatPubkey');
  requireNonEmpty(input.plaintext, 'plaintext');
  const plaintext = String(input.plaintext);
  assertNoSecretEgressText(plaintext, {
    channel: 'private_chat',
    extraMnemonics: [mnemonic],
  });
  const walletPath = String(input.wallet.path || '').trim() || DEFAULT_WALLET_PATH;

  const privateKeyBuffer = await getPrivateKeyBufferForEcdh(mnemonic, walletPath);
  const encryptedContent = ecdhEncrypt(
    plaintext,
    computeEcdhSharedSecretSha256(privateKeyBuffer, peerChatPubkey)
  );
  const payload = buildPrivateMessagePayload({
    to: peerGlobalMetaId,
    encryptedContent,
    replyPin: input.replyPin,
    contentType: input.contentType,
    nowSeconds: input.nowSeconds,
  });

  return input.createPin(input.metabotId, {
    operation: 'create',
    path: '/protocols/simplemsg',
    encryption: '0',
    version: '1.0.0',
    contentType: 'application/json',
    payload,
  });
};
