/**
 * GlobalMetaId helpers delegated to the shared metabot identity extraction.
 */

import {
  convertSharedAddressToGlobalMetaId,
  normalizeSharedGlobalMetaId
} from '../shared/metabotIdentityBridge';

export const convertToGlobalMetaId = convertSharedAddressToGlobalMetaId;

export function validateGlobalMetaId(globalMetaId: string): boolean {
  return normalizeSharedGlobalMetaId(globalMetaId) !== null;
}
