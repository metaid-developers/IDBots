/**
 * MetaBot & MetaBot Wallet types for multi-agent architecture.
 * DB stores tools/skills as JSON TEXT; these interfaces use string[] with serialization in store layer.
 */

export type MetabotType = 'twin' | 'worker';

/** MetaBot base info and soul (matches metabots table) */
export interface Metabot {
  id: number;
  mvc_address: string;
  btc_address: string;
  doge_address: string;
  public_key: string;
  chat_public_key: string;
  chat_public_key_pin_id: string;
  name: string;
  /** Avatar: base64 string (e.g. data:image/png;base64,...) or binary stored as base64; null if not set */
  avatar: string | null;
  /** Whether this MetaBot is currently available */
  enabled: boolean;
  metaid: string;
  globalmetaid: string | null;
  metabot_info_pinid: string;
  metabot_type: MetabotType;
  created_by: string;
  role: string;
  soul: string;
  goal: string | null;
  background: string | null;
  boss_id: number | null;
  llm_id: string | null;
  /** Allowed tool ids; stored as JSON array in DB */
  tools: string[];
  /** Allowed skill ids; stored as JSON array in DB */
  skills: string[];
  created_at: number;
  updated_at: number;
}

/** Input for creating a MetaBot (same shape minus id and timestamps) */
export interface MetabotInsert {
  mvc_address: string;
  btc_address: string;
  doge_address: string;
  public_key: string;
  chat_public_key: string;
  chat_public_key_pin_id: string;
  name: string;
  avatar?: string | null;
  enabled?: boolean;
  metaid: string;
  globalmetaid?: string | null;
  metabot_info_pinid: string;
  metabot_type: MetabotType;
  created_by: string;
  role: string;
  soul: string;
  goal?: string | null;
  background?: string | null;
  boss_id?: number | null;
  llm_id?: string | null;
  tools?: string[];
  skills?: string[];
}

/** Input for updating a MetaBot (all optional except identity) */
export interface MetabotUpdate {
  mvc_address?: string;
  btc_address?: string;
  doge_address?: string;
  public_key?: string;
  chat_public_key?: string;
  chat_public_key_pin_id?: string;
  name?: string;
  avatar?: string | null;
  enabled?: boolean;
  metaid?: string;
  globalmetaid?: string | null;
  metabot_info_pinid?: string;
  metabot_type?: MetabotType;
  created_by?: string;
  role?: string;
  soul?: string;
  goal?: string | null;
  background?: string | null;
  boss_id?: number | null;
  llm_id?: string | null;
  tools?: string[];
  skills?: string[];
}

/** MetaBot wallet (append-only; no update/delete in app layer) */
export interface MetabotWallet {
  id: number;
  metabot_id: number;
  mnemonic: string;
  path: string;
  created_at: number;
}

/** Input for inserting a wallet (metabot_wallets is insert-only) */
export interface MetabotWalletInsert {
  metabot_id: number;
  mnemonic: string;
  path?: string;
}
