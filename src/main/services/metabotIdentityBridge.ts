import path from 'node:path';

export interface SharedDerivedIdentity {
  mnemonic: string;
  path: string;
  publicKey: string;
  chatPublicKey: string;
  mvcAddress: string;
  btcAddress: string;
  dogeAddress: string;
  metaId: string;
  globalMetaId: string;
}

export interface SharedDeriveIdentityOptions {
  mnemonic?: string;
  path?: string;
}

interface SharedIdentityModule {
  DEFAULT_DERIVATION_PATH: string;
  deriveIdentity(options?: SharedDeriveIdentityOptions): Promise<SharedDerivedIdentity>;
  convertToGlobalMetaId(address: string): string;
  normalizeGlobalMetaId(value: unknown): string | null;
}

let cachedIdentityModule: SharedIdentityModule | null = null;

function resolveSharedIdentityModulePath(): string {
  return path.resolve(__dirname, '../../metabot/dist/core/identity/deriveIdentity.js');
}

function loadSharedIdentityModule(): SharedIdentityModule {
  if (cachedIdentityModule) {
    return cachedIdentityModule;
  }

  const modulePath = resolveSharedIdentityModulePath();
  cachedIdentityModule = require(modulePath) as SharedIdentityModule;
  return cachedIdentityModule;
}

export function getDefaultDerivationPath(): string {
  return loadSharedIdentityModule().DEFAULT_DERIVATION_PATH;
}

export function deriveSharedIdentity(
  options: SharedDeriveIdentityOptions = {}
): Promise<SharedDerivedIdentity> {
  return loadSharedIdentityModule().deriveIdentity(options);
}

export function convertSharedAddressToGlobalMetaId(address: string): string {
  return loadSharedIdentityModule().convertToGlobalMetaId(address);
}

export function normalizeSharedGlobalMetaId(value: unknown): string | null {
  return loadSharedIdentityModule().normalizeGlobalMetaId(value);
}
