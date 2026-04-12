import path from 'node:path';
import { resolveMetabotDistModulePath } from '../libs/runtimePaths';

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
  return resolveMetabotDistModulePath('core/identity/deriveIdentity.js', { startDir: __dirname });
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
