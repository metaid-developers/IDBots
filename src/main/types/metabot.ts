/**
 * MetaBot & MetaBot Wallet types for multi-agent architecture.
 * DB stores tools/skills as JSON TEXT; these interfaces use string[] with serialization in store layer.
 */

export type MetabotType = 'twin' | 'worker' | 'welcome';

/** MetaBot base info and soul (matches metabots table) */
export interface Metabot {
  id: number;
  /** FK to metabot_wallets.id; wallet is created before metabot */
  wallet_id: number;
  mvc_address: string;
  btc_address: string;
  doge_address: string;
  public_key: string;
  chat_public_key: string;
  chat_public_key_pin_id: string | null;
  name: string;
  /** Plain image source or identity-bound nft:// reference. */
  avatar: string | null;
  avatar_fallback?: string | null;
  nft_avatar_pin_id?: string | null;
  nft_avatar_synced_reference?: string | null;
  /** Whether this MetaBot is currently available */
  enabled: boolean;
  metaid: string;
  globalmetaid: string | null;
  metabot_info_pinid: string | null;
  metabot_type: MetabotType;
  created_by: string;
  role: string;
  soul: string;
  goal: string | null;
  bio: string | null;
  /** Deprecated local compatibility column; v3 Bot Info stores public bio in `bio` and `/info/bio`. */
  background: string | null;
  boss_id: number | null;
  /** External BOSS globalmetaid (on-chain identity of the supervisor) */
  boss_global_metaid: string | null;
  /** Pin id of the signed /info/owner binding; null = no signed binding (legacy unsigned claim). */
  owner_binding_pinid: string | null;
  /**
   * Primary LLM brain. New rows store a model id; legacy rows may still hold a
   * provider key (resolved to the provider's default model at call time).
   */
  llm_id: string | null;
  /** Provider key the brain model was picked from; disambiguates colliding model ids. */
  llm_provider?: string | null;
  /** Reasoning effort for the primary brain (off/low/high/max); null = model default. */
  llm_effort?: string | null;
  /** Optional fallback brain; same value semantics as llm_id (model id or legacy provider key). */
  fallback_llm_id?: string | null;
  /** Provider key for the fallback brain model. */
  fallback_llm_provider?: string | null;
  /** Reasoning effort for the fallback brain; null = model default. */
  fallback_llm_effort?: string | null;
  /** Allowed tool ids; stored as JSON array in DB */
  tools: string[];
  /** Allowed skill ids; stored as JSON array in DB */
  skills: string[];
  /** Skills allowed in private chat; stored as JSON array in DB */
  allow_chat_skills: string[];
  /** Max incoming turns per active A2A private-chat session before forcing "bye"; null = default. */
  a2a_max_incoming_turns?: number | null;
  /** Cooldown after an auto-bye before the A2A conversation may reopen; null = default. */
  a2a_bye_cooldown_ms?: number | null;
  /** Whether this bot auto-replies in A2A private chats; null = default (on). */
  a2a_auto_reply_enabled?: boolean | null;
  /** Homepage pointer JSON string (serialized {uri,renderer,contentType}); null = Default template. */
  homepage: string | null;
  created_at: number;
  updated_at: number;
}

/** Input for creating a MetaBot (same shape minus id and timestamps) */
export interface MetabotInsert {
  wallet_id: number;
  mvc_address: string;
  btc_address: string;
  doge_address: string;
  public_key: string;
  chat_public_key: string;
  chat_public_key_pin_id?: string | null;
  name: string;
  avatar?: string | null;
  /** Resolved NFT cover used as the legacy /info/avatar image and display fallback. */
  avatar_fallback?: string | null;
  nft_avatar_pin_id?: string | null;
  nft_avatar_synced_reference?: string | null;
  enabled?: boolean;
  metaid: string;
  globalmetaid?: string | null;
  metabot_info_pinid?: string | null;
  metabot_type: MetabotType;
  created_by: string;
  role: string;
  soul: string;
  goal?: string | null;
  bio?: string | null;
  /** Deprecated compatibility input; use `bio`. */
  background?: string | null;
  boss_id?: number | null;
  boss_global_metaid?: string | null;
  owner_binding_pinid?: string | null;
  llm_id?: string | null;
  /** Provider key the brain model was picked from. */
  llm_provider?: string | null;
  /** Reasoning effort for the primary brain; null = model default. */
  llm_effort?: string | null;
  /** Optional fallback brain (model id or legacy provider key). */
  fallback_llm_id?: string | null;
  /** Provider key for the fallback brain model. */
  fallback_llm_provider?: string | null;
  /** Reasoning effort for the fallback brain; null = model default. */
  fallback_llm_effort?: string | null;
  tools?: string[];
  skills?: string[];
  allow_chat_skills?: string[];
  /** Homepage pointer JSON string; null = Default. */
  homepage?: string | null;
}

/** Input for updating a MetaBot (all optional except identity) */
export interface MetabotUpdate {
  wallet_id?: number;
  mvc_address?: string;
  btc_address?: string;
  doge_address?: string;
  public_key?: string;
  chat_public_key?: string;
  chat_public_key_pin_id?: string | null;
  name?: string;
  avatar?: string | null;
  /** Resolved NFT cover used as the legacy /info/avatar image and display fallback. */
  avatar_fallback?: string | null;
  nft_avatar_pin_id?: string | null;
  nft_avatar_synced_reference?: string | null;
  enabled?: boolean;
  metaid?: string;
  globalmetaid?: string | null;
  metabot_info_pinid?: string | null;
  metabot_type?: MetabotType;
  created_by?: string;
  role?: string;
  soul?: string;
  goal?: string | null;
  bio?: string | null;
  /** Deprecated compatibility input; use `bio`. */
  background?: string | null;
  boss_id?: number | null;
  boss_global_metaid?: string | null;
  owner_binding_pinid?: string | null;
  llm_id?: string | null;
  /** Provider key the brain model was picked from. */
  llm_provider?: string | null;
  /** Reasoning effort for the primary brain; null = model default. */
  llm_effort?: string | null;
  /** Optional fallback brain (model id or legacy provider key). */
  fallback_llm_id?: string | null;
  /** Provider key for the fallback brain model. */
  fallback_llm_provider?: string | null;
  /** Reasoning effort for the fallback brain; null = model default. */
  fallback_llm_effort?: string | null;
  tools?: string[];
  skills?: string[];
  allow_chat_skills?: string[];
  /** Max incoming turns per active A2A private-chat session; null/undefined = default. */
  a2a_max_incoming_turns?: number | null;
  /** Cooldown after an auto-bye before the A2A conversation may reopen; null/undefined = default. */
  a2a_bye_cooldown_ms?: number | null;
  /** Whether this bot auto-replies in A2A private chats; null/undefined = default (on). */
  a2a_auto_reply_enabled?: boolean | null;
  /** Homepage pointer JSON string; null = Default. */
  homepage?: string | null;
}

/** MetaBot wallet (append-only; no update/delete in app layer). Created before metabot; metabots.wallet_id references this id. */
export interface MetabotWallet {
  id: number;
  mnemonic: string;
  path: string;
  created_at: number;
}

/** Input for inserting a wallet (metabot_wallets is insert-only). No metabot_id; metabot references wallet by wallet_id. */
export interface MetabotWalletInsert {
  mnemonic: string;
  path?: string;
}
