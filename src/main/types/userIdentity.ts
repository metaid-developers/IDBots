/**
 * Human user identity (single-row user_identity table).
 *
 * The local human user holds a mnemonic-derived MetaID identity just like a
 * MetaBot, but represents the person who owns MetaBots. Only one user
 * identity may exist locally at a time; switching accounts means logging out
 * (deleting the row) and importing/creating again.
 *
 * Setup state mirrors the OAC bootstrap model: the gas subsidy is a distinct,
 * retryable step that must succeed before on-chain pins are attempted. Each
 * published pin stores its PinID so retries are idempotent (only missing pins
 * are republished).
 */
export type UserSubsidyState = 'pending' | 'claimed' | 'failed';
export type UserSyncState = 'pending' | 'synced' | 'partial' | 'failed';

export interface UserIdentity {
  /** Always 1; the table enforces a single row via CHECK (id = 1). */
  id: number;
  mnemonic: string;
  path: string;
  mvc_address: string;
  btc_address: string;
  doge_address: string;
  public_key: string;
  chat_public_key: string;
  chat_public_key_pin_id: string | null;
  metaid: string;
  globalmetaid: string | null;
  name: string;
  /** Plain image data URL or identity-bound nft:// reference. */
  avatar: string | null;
  avatar_fallback?: string | null;
  nft_avatar_pin_id?: string | null;
  nft_avatar_synced_reference?: string | null;
  /** MVC gas subsidy lifecycle. */
  subsidy_state: UserSubsidyState | null;
  subsidy_error: string | null;
  /** PinIDs of successfully published /info pins (null = not published yet). */
  name_pin_id: string | null;
  avatar_pin_id: string | null;
  /** Chain-sync lifecycle for the /info pins. */
  sync_state: UserSyncState | null;
  sync_error: string | null;
  created_at: number;
  updated_at: number;
}

/** Input for creating the local user identity (timestamps assigned by store). */
export interface UserIdentityInsert {
  mnemonic: string;
  path?: string;
  mvc_address: string;
  btc_address: string;
  doge_address: string;
  public_key: string;
  chat_public_key: string;
  chat_public_key_pin_id?: string | null;
  metaid: string;
  globalmetaid?: string | null;
  name: string;
  avatar?: string | null;
  avatar_fallback?: string | null;
  nft_avatar_pin_id?: string | null;
  nft_avatar_synced_reference?: string | null;
  subsidy_state?: UserSubsidyState | null;
  subsidy_error?: string | null;
  name_pin_id?: string | null;
  avatar_pin_id?: string | null;
  sync_state?: UserSyncState | null;
  sync_error?: string | null;
}

/** Input for updating profile/setup fields of the local user identity. */
export interface UserIdentityUpdate {
  name?: string;
  avatar?: string | null;
  avatar_fallback?: string | null;
  nft_avatar_pin_id?: string | null;
  nft_avatar_synced_reference?: string | null;
  chat_public_key_pin_id?: string | null;
  globalmetaid?: string | null;
  subsidy_state?: UserSubsidyState | null;
  subsidy_error?: string | null;
  name_pin_id?: string | null;
  avatar_pin_id?: string | null;
  sync_state?: UserSyncState | null;
  sync_error?: string | null;
}
