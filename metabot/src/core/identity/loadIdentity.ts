import {
  DEFAULT_DERIVATION_PATH,
  deriveIdentity,
  normalizeGlobalMetaId,
  type DerivedIdentity
} from './deriveIdentity';

export type IdentitySource = Partial<DerivedIdentity> & {
  public_key?: string;
  chat_public_key?: string;
  mvc_address?: string;
  btc_address?: string;
  doge_address?: string;
  metaid?: string;
  globalmetaid?: string;
};

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readGlobalMetaId(value: unknown): string | undefined {
  const normalized = normalizeGlobalMetaId(value);
  return normalized ?? undefined;
}

function hasDerivedFields(source: IdentitySource): boolean {
  return Boolean(
    readString(source.publicKey ?? source.public_key) &&
      readString(source.chatPublicKey ?? source.chat_public_key) &&
      readString(source.mvcAddress ?? source.mvc_address) &&
      readString(source.btcAddress ?? source.btc_address) &&
      readString(source.dogeAddress ?? source.doge_address) &&
      readString(source.metaId ?? source.metaid) &&
      readGlobalMetaId(source.globalMetaId ?? source.globalmetaid)
  );
}

export async function loadIdentity(source: IdentitySource): Promise<DerivedIdentity> {
  const mnemonic = readString(source.mnemonic);
  const path = readString(source.path) ?? DEFAULT_DERIVATION_PATH;

  if (hasDerivedFields(source) && mnemonic) {
    return {
      mnemonic,
      path,
      publicKey: readString(source.publicKey ?? source.public_key) as string,
      chatPublicKey: readString(source.chatPublicKey ?? source.chat_public_key) as string,
      mvcAddress: readString(source.mvcAddress ?? source.mvc_address) as string,
      btcAddress: readString(source.btcAddress ?? source.btc_address) as string,
      dogeAddress: readString(source.dogeAddress ?? source.doge_address) as string,
      metaId: readString(source.metaId ?? source.metaid) as string,
      globalMetaId: readGlobalMetaId(source.globalMetaId ?? source.globalmetaid) as string
    };
  }

  if (!mnemonic) {
    throw new Error('Identity source is missing mnemonic');
  }

  return deriveIdentity({
    mnemonic,
    path
  });
}
