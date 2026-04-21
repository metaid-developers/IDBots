/**
 * MetaBot Wallet Creation Service
 * Creates new MetaBot wallets with mnemonic, derives keys and addresses,
 * computes metaid and globalmetaid locally (no remote API).
 */

import * as crypto from 'crypto';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import {
  MvcWallet,
  BtcWallet,
  DogeWallet,
  AddressType,
  CoinType,
  type Net,
} from '@metalet/utxo-wallet-service';
import { mvc } from 'meta-contract';
import { convertToGlobalMetaId } from './globalMetaid';

const DEFAULT_PATH = "m/44'/10001'/0'/0/0";
const MAN_PUB_KEY =
  '048add0a6298f10a97785f7dd069eedb83d279a6f03e73deec0549e7d6fcaac4eef2c279cf7608be907a73c89eb44c28db084c27b588f1bd869321a6f104ec642d';

export interface CreateMetaBotWalletOptions {
  /** BIP44 derivation path, default m/44'/10001'/0'/0/0 */
  path?: string;
  /** Mnemonic; if omitted, a new one is generated */
  mnemonic?: string;
}

export interface CreateMetaBotWalletResult {
  mnemonic: string;
  path: string;
  public_key: string;
  chat_public_key: string;
  mvc_address: string;
  btc_address: string;
  doge_address: string;
  metaid: string;
  globalmetaid: string;
  chat_public_key_pin_id: string;
}

/** Parse addressIndex from BIP44 path (e.g. m/44'/10001'/0'/0/0 -> 0). Exported for transfer service. */
export function parseAddressIndexFromPath(path: string): number {
  if (!path || typeof path !== 'string') return 0;
  const m = path.match(/\/0\/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

function getNet(): Net {
  return 'livenet' as Net;
}

async function getV3AddressType(chain: 'mvc' | 'btc' | 'doge'): Promise<AddressType> {
  if (chain === 'mvc') return AddressType.LegacyMvc;
  if (chain === 'doge') return AddressType.DogeSameAsMvc;
  return AddressType.SameAsMvc;
}

/** Get MVC wallet for given mnemonic and address index. Exported for transfer service. */
export async function getMvcWallet(mnemonic: string, addressIndex: number): Promise<MvcWallet> {
  const network = getNet();
  const addressType = await getV3AddressType('mvc');
  return new MvcWallet({
    coinType: CoinType.MVC,
    addressType,
    addressIndex,
    network,
    mnemonic,
  });
}

async function getBtcWallet(mnemonic: string, addressIndex: number): Promise<BtcWallet> {
  const network = getNet();
  const addressType = await getV3AddressType('btc');
  const coinType = addressType === AddressType.SameAsMvc ? CoinType.MVC : CoinType.BTC;
  return new BtcWallet({
    coinType,
    addressType,
    addressIndex,
    network,
    mnemonic,
  });
}

/** Get DOGE wallet for given mnemonic and address index. Exported for transfer service. */
export async function getDogeWallet(mnemonic: string, addressIndex: number): Promise<DogeWallet> {
  const network = getNet();
  const addressType = await getV3AddressType('doge');
  return new DogeWallet({
    mnemonic,
    network,
    addressIndex,
    addressType,
    coinType: CoinType.MVC,
  });
}

/** Derive chat_public_key via ECDH with MAN pubkey (same as chatpubkey.ts) */
function deriveChatPublicKey(mnemonic: string, addressIndex: number): Promise<string> {
  return getMvcWallet(mnemonic, addressIndex).then((wallet) => {
    const privateKeyBuffer = getPrivateKeyBufferFromWallet(wallet);
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(privateKeyBuffer);
    void ecdh.computeSecret(Buffer.from(MAN_PUB_KEY, 'hex'));
    return ecdh.getPublicKey('hex', 'uncompressed');
  });
}

/**
 * Get 32-byte private key buffer for ECDH (e.g. private chat decrypt/encrypt).
 * Same derivation as chat key: mnemonic + path -> MVC wallet -> raw private key.
 */
export async function getPrivateKeyBufferForEcdh(mnemonic: string, pathStr: string): Promise<Buffer> {
  const addressIndex = parseAddressIndexFromPath(pathStr || DEFAULT_PATH);
  const wallet = await getMvcWallet(mnemonic, addressIndex);
  return getPrivateKeyBufferFromWallet(wallet);
}

function getPrivateKeyBufferFromWallet(wallet: MvcWallet): Buffer {
  const privateKeyWIF = wallet.getPrivateKey();
  const privKey = mvc.PrivateKey.fromWIF(privateKeyWIF);
  return Buffer.from((privKey as { bn: { toArray: (e: string, n: number) => number[] } }).bn.toArray('be', 32));
}

/** Compute metaid locally: SHA256(mvc_address) hex */
function computeMetaId(mvcAddress: string): string {
  return crypto.createHash('sha256').update(mvcAddress, 'utf8').digest('hex');
}

/**
 * Create a new MetaBot wallet.
 * Generates mnemonic if not provided; derives keys/addresses from path; computes metaid and globalmetaid locally.
 *
 * @param options.path - BIP44 path (default m/44'/10001'/0'/0/0)
 * @param options.mnemonic - Optional; if omitted, generates new mnemonic via @scure/bip39
 * @returns Wallet data for MetaBot creation
 */
export async function createMetaBotWallet(
  options: CreateMetaBotWalletOptions = {}
): Promise<CreateMetaBotWalletResult> {
  const path = options.path ?? DEFAULT_PATH;
  let mnemonic = options.mnemonic?.trim();
  if (!mnemonic) {
    mnemonic = bip39.generateMnemonic(wordlist);
  }

  const addressIndex = parseAddressIndexFromPath(path);

  const [mvcWallet, btcWallet, dogeWallet, chatPublicKey] = await Promise.all([
    getMvcWallet(mnemonic, addressIndex),
    getBtcWallet(mnemonic, addressIndex),
    getDogeWallet(mnemonic, addressIndex),
    deriveChatPublicKey(mnemonic, addressIndex),
  ]);

  const mvc_address = mvcWallet.getAddress();
  const btc_address = btcWallet.getAddress();
  const doge_address = dogeWallet.getAddress();
  const public_key = mvcWallet.getPublicKey().toString('hex');
  const metaid = computeMetaId(mvc_address);
  const globalmetaid = convertToGlobalMetaId(mvc_address);

  return {
    mnemonic,
    path,
    public_key,
    chat_public_key: chatPublicKey,
    mvc_address,
    btc_address,
    doge_address,
    metaid,
    globalmetaid,
    chat_public_key_pin_id: '',
  };
}
