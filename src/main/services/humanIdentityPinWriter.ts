import type { MetaidDataPayload, MvcCreatePinSessionSnapshot } from './metaidCore';
import type { UserIdentityStore } from '../userIdentityStore';
import type { UserIdentity, UserIdentityPublic } from '../types/userIdentity';
import type { IdentityCreatePin } from './preference/userWriter';

export type HumanIdentityPinErrorCode =
  | 'USER_IDENTITY_MISSING'
  | 'SUBSIDY_NOT_CLAIMED'
  | 'IDENTITY_MISMATCH';

export type HumanIdentityPinWriteOptions = {
  /**
   * GlobalMetaId the caller authorized (e.g. the identity shown on the
   * Browser confirmation card). Re-checked when the write dequeues: if the
   * identity was replaced while the write waited behind another one, the
   * write fails with IDENTITY_MISMATCH instead of signing as someone else.
   */
  expectedGlobalMetaId?: string;
};

export type HumanIdentityPinWriteOutcome =
  | { ok: false; error: HumanIdentityPinErrorCode }
  | { ok: true; pinId: string; txids: string[]; totalCost: number };

export type HumanIdentityPinWriter = (
  metaidData: MetaidDataPayload,
  options?: HumanIdentityPinWriteOptions,
) => Promise<HumanIdentityPinWriteOutcome>;

export interface HumanIdentityPinWriterDeps {
  createPin: IdentityCreatePin;
  feeRate: () => number;
}

/**
 * Same usability predicate as the sealed preference user writer: the signer is
 * usable when a GlobalMetaID exists and the gas subsidy is neither failed nor
 * entirely missing. A locked signer stays visible in the Browser Actor list
 * but every write must surface an explicit error, never a Bot fallback.
 */
export function humanIdentitySigningAvailable(
  identity: UserIdentity | UserIdentityPublic | null | undefined,
): boolean {
  if (!identity || !identity.globalmetaid) return false;
  return !(
    identity.subsidy_state === 'failed'
    || (!identity.subsidy_state && !identity.chat_public_key_pin_id)
  );
}

function identityWriteError(
  identity: UserIdentity | null,
  expectedGlobalMetaId?: string,
): HumanIdentityPinErrorCode | null {
  if (!identity || !identity.globalmetaid) return 'USER_IDENTITY_MISSING';
  if (expectedGlobalMetaId && identity.globalmetaid.trim().toLowerCase() !== expectedGlobalMetaId.trim().toLowerCase()) {
    return 'IDENTITY_MISMATCH';
  }
  if (!humanIdentitySigningAvailable(identity)) return 'SUBSIDY_NOT_CLAIMED';
  return null;
}

/**
 * Serialized generic PIN writer for the local human identity wallet.
 *
 * createPinForIdentity bypasses the per-MetaBot MVC spend coordinator, so this
 * writer owns serialization for the human wallet: one queue, one session
 * snapshot, threaded between sequential pins (spent outpoints excluded, change
 * UTXO preferred). Unlike createUserPreferenceWriter it fixes no protocol
 * path — callers supply the full MetaidDataPayload — so the sealed preference
 * writer and the generic Browser `metaid.pin.write` path can share a single
 * queue instead of racing each other for UTXOs.
 *
 * Identity replacement (logout + re-import) swaps the wallet behind the same
 * store; the snapshot owner (mnemonic + path) is re-checked per write and the
 * UTXO threading state resets when it changes. The identity is re-read at
 * execution time, so a write queued before a logout fails with
 * USER_IDENTITY_MISSING instead of signing with the removed wallet.
 */
export function createHumanIdentityPinWriter(
  userStore: Pick<UserIdentityStore, 'get'>,
  deps: HumanIdentityPinWriterDeps,
): HumanIdentityPinWriter {
  let queue: Promise<unknown> = Promise.resolve();
  let snapshot: MvcCreatePinSessionSnapshot = { excludeOutpoints: [], preferredFundingUtxos: [] };
  let snapshotOwnerMnemonic = '';
  let snapshotOwnerPath = '';

  return (metaidData, options) => {
    const run = async (): Promise<HumanIdentityPinWriteOutcome> => {
      const identity = userStore.get();
      const gateError = identityWriteError(identity, options?.expectedGlobalMetaId);
      if (gateError) return { ok: false, error: gateError };

      const mnemonic = identity.mnemonic;
      const path = identity.path;
      if (mnemonic !== snapshotOwnerMnemonic || path !== snapshotOwnerPath) {
        snapshot = { excludeOutpoints: [], preferredFundingUtxos: [] };
        snapshotOwnerMnemonic = mnemonic;
        snapshotOwnerPath = path;
      }

      const result = await deps.createPin({
        mnemonic,
        path,
        metaidData,
        options: { feeRate: deps.feeRate() },
        sessionSnapshot: snapshot,
      });
      if (Array.isArray(result.spentOutpoints) && result.spentOutpoints.length > 0) {
        snapshot.excludeOutpoints.push(...result.spentOutpoints);
      }
      snapshot.preferredFundingUtxos = result.changeUtxo ? [result.changeUtxo] : [];
      const txid = result.txids[0] ?? '';
      return {
        ok: true,
        pinId: result.pinId || `${txid}i0`,
        txids: result.txids,
        totalCost: typeof result.totalCost === 'number' && Number.isFinite(result.totalCost)
          ? result.totalCost
          : 0,
      };
    };
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };
}
