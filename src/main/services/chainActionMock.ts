/**
 * Mock service for future Web3/chain operations.
 * All functions simulate 1-2s network delay and return resolved promises.
 */

const MOCK_DELAY_MS_MIN = 1000;
const MOCK_DELAY_MS_MAX = 2000;

function randomDelay(): Promise<void> {
  const ms = MOCK_DELAY_MS_MIN + Math.random() * (MOCK_DELAY_MS_MAX - MOCK_DELAY_MS_MIN);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Mock: create wallet and receive gas subsidy */
export function mockCreateWalletAndFund(): Promise<{
  mvc_address: string;
  btc_address: string;
  doge_address: string;
  public_key: string;
  chat_public_key: string;
  chat_public_key_pin_id: string;
  metaid: string;
  globalmetaid: string;
  metabot_info_pinid: string;
}> {
  return randomDelay().then(() => ({
    mvc_address: `mock_mvc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    btc_address: `mock_btc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    doge_address: `mock_doge_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    public_key: `mock_pk_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`,
    chat_public_key: `mock_chat_pk_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    chat_public_key_pin_id: `mock_chat_pin_${Date.now()}`,
    metaid: `mock_metaid_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    globalmetaid: `mock_global_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    metabot_info_pinid: `mock_info_pin_${Date.now()}`,
  }));
}

/** Mock: push MetaBot config to chain */
export function mockPushConfigToChain(): Promise<{ success: boolean }> {
  return randomDelay().then(() => ({ success: true }));
}

/** Mock: send declarative update to chain */
export function mockUpdateConfigOnChain(): Promise<{ success: boolean }> {
  return randomDelay().then(() => ({ success: true }));
}
