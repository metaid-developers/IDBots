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
  enabled: boolean;
  metabot_type: 'twin' | 'worker';
  role: string;
  soul: string;
  goal: string | null;
  background: string | null;
  boss_id: number | null;
  boss_global_metaid: string | null;
  llm_id: string | null;
  tools: string[];
  skills: string[];
  created_at: number;
  updated_at: number;
}
