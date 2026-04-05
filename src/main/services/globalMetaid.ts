/**
 * GlobalMetaId helpers delegated to the shared metabot identity extraction.
 */

import {
  convertToGlobalMetaId as convertAddressToGlobalMetaId,
  normalizeGlobalMetaId
} from '../../../metabot/src/core/identity/deriveIdentity';

export const convertToGlobalMetaId = convertAddressToGlobalMetaId;

export function validateGlobalMetaId(globalMetaId: string): boolean {
  return normalizeGlobalMetaId(globalMetaId) !== null;
}
