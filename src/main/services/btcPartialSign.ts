import {
  AddressType,
  BtcWallet,
  CoinType,
  SignType,
} from '@metalet/utxo-wallet-service';
import {
  assertMultisigInputsSignable,
  selectMultisigInputIndexes,
} from './btcMultisigScript';

const SIGHASH_ALL = 1;

export interface BtcPsbtSigner {
  signTx(...args: any[]): { psbtHex?: string; rawTx?: string };
  /** BtcWallet exposes the signing key's public key; optional for stubs. */
  getPublicKey?(): Buffer | Uint8Array;
}

function addressIndexFromPath(path: string | null | undefined): number {
  const match = String(path || '').match(/\/0\/(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

/** Open the same BTC key IDBots already uses for this MetaBot: MVC-path P2PKH. */
export function openMetabotBtcWallet(record: { mnemonic?: string | null; path?: string | null }): BtcWallet {
  const mnemonic = String(record.mnemonic || '').trim();
  if (!mnemonic) throw new Error('mnemonic is required');
  return new BtcWallet({
    coinType: CoinType.MVC,
    addressType: AddressType.SameAsMvc,
    addressIndex: addressIndexFromPath(record.path),
    network: 'livenet',
    mnemonic,
  });
}

/**
 * Add this key's signature to multisig inputs only.
 * Personal P2PKH inputs are refused so this tool cannot spend the bot's own wallet.
 * The wallet is always asked to leave the PSBT unfinished.
 */
export function signBtcPsbtPartial(
  signer: BtcPsbtSigner,
  input: { psbtHex: string; inputIndexes?: number[] },
): { psbtHex: string } {
  const indexes = selectMultisigInputIndexes(input.psbtHex, input.inputIndexes);
  if (indexes.length === 0) {
    throw new Error('no multisig input to sign');
  }
  // Defence in depth: when the signer can name its key, prove the selected
  // inputs are P2WSH(multisig) redeemable by it and that each witnessScript is
  // the script its prevout commits to — before the wallet is touched at all.
  if (typeof signer.getPublicKey === 'function') {
    const publicKey = Buffer.from(signer.getPublicKey()).toString('hex');
    assertMultisigInputsSignable({ psbtHex: input.psbtHex, indexes, publicKey });
  }
  const signed = signer.signTx(SignType.SIGN_PSBT, {
    psbtHex: input.psbtHex,
    autoFinalized: false,
    toSignInputs: indexes.map((index) => ({ index, sighashTypes: [SIGHASH_ALL] })),
  });
  if (String(signed.rawTx || '').trim()) {
    throw new Error('partial sign must not finalize');
  }
  const psbtHex = String(signed.psbtHex || '').trim();
  if (!psbtHex) throw new Error('partial sign returned no psbt');
  return { psbtHex };
}
