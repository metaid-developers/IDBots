/** MetaBot type for renderer (aligns with electron IPC and main types) */
export interface Metabot {
  id: number;
  wallet_id: number;
  mvc_address?: string;
  btc_address?: string;
  doge_address?: string;
  chat_public_key_pin_id?: string | null;
  metabot_info_pinid?: string | null;
  name: string;
  avatar: string | null;
  avatar_fallback?: string | null;
  nft_avatar_pin_id?: string | null;
  nft_avatar_synced_reference?: string | null;
  enabled: boolean;
  globalmetaid: string | null;
  metabot_type: 'twin' | 'worker' | 'welcome';
  role: string;
  soul: string;
  goal: string | null;
  bio: string | null;
  /** Deprecated compatibility field; v3 Bot Info uses `bio`. */
  background: string | null;
  boss_id: number | null;
  boss_global_metaid: string | null;
  /** Pin id of the signed /info/owner binding; null means unsigned legacy claim or no owner. */
  owner_binding_pinid?: string | null;
  /** Primary LLM brain: model id (new) or legacy provider key. */
  llm_id: string | null;
  /** Provider key the brain model was picked from; disambiguates colliding model ids. */
  llm_provider?: string | null;
  /** Reasoning effort for the primary brain (off/low/high/max); null = model default. */
  llm_effort?: string | null;
  /** Optional fallback brain; same value semantics as llm_id. */
  fallback_llm_id?: string | null;
  /** Provider key for the fallback brain model. */
  fallback_llm_provider?: string | null;
  /** Reasoning effort for the fallback brain; null = model default. */
  fallback_llm_effort?: string | null;
  tools: string[];
  skills: string[];
  allow_chat_skills: string[];
  /** Max incoming turns per active A2A private-chat session; null = app default. */
  a2a_max_incoming_turns?: number | null;
  /** Cooldown after an auto-bye before the A2A conversation may reopen; null = app default. */
  a2a_bye_cooldown_ms?: number | null;
  /** Whether this bot auto-replies in A2A private chats; null = default (on). */
  a2a_auto_reply_enabled?: boolean | null;
  /** Homepage pointer JSON string (serialized {uri,renderer,contentType}); null = Default template. */
  homepage?: string | null;
  /** Runtime flag merged by main: this bot is currently running its dream consolidation. */
  dreaming?: boolean;
  /** Runtime flag tracked renderer-side via surf:onStatusChanged: this bot currently has a surf run in progress. */
  surfing?: boolean;
  /**
   * Runtime flag merged by main: chain-honest on-chain sync state.
   * 'partial' = identity registered but some info pins unpublished (or a
   * persisted pending plan exists); 'synced' only when a pin id is on record.
   * Absent on older lists — fall back to the metabot_info_pinid check.
   */
  chain_sync_state?: 'synced' | 'partial';
  /** Unpublished step keys behind a 'partial' state (empty for legacy partials). */
  chain_sync_pending_steps?: string[];
  /**
   * Runtime flag merged by main: gas-subsidy outcome for this bot's wallet.
   * 'failed' powers the create-fallback banner (retry subsidy / self-funded
   * broadcast); 'unknown' = created before this tracking — show no banner.
   */
  subsidy_state?: 'unknown' | 'claimed' | 'failed';
  subsidy_error?: string | null;
  created_at: number;
  updated_at: number;
}
