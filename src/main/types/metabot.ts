/**
 * MetaBot & MetaBot Wallet types for multi-agent architecture.
 * DB stores tools/skills as JSON TEXT; these interfaces use string[] with serialization in store layer.
 */

export type MetabotType = 'twin' | 'worker';

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
  chat_public_key_pin_id: string;
  name: string;
  /** Avatar: data URL or URL string for display; stored as BLOB on-chain aligned in DB */
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
  wallet_id: number;
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
  wallet_id?: number;
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
