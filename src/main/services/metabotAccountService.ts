import type { MetabotStore } from '../metabotStore';

export interface MetabotAccountSummary {
  metabot_id: number;
  name: string;
  mvc_address: string;
  btc_address: string;
  doge_address: string;
  public_key: string;
}

export function getMetabotAccountSummary(store: MetabotStore, metabotId: number): MetabotAccountSummary {
  if (!Number.isInteger(metabotId) || metabotId <= 0) {
    throw new Error('metabot_id must be a positive integer');
  }

  const metabot = store.getMetabotById(metabotId);
  if (!metabot) {
    throw new Error(`MetaBot not found: ${metabotId}`);
  }

  return {
    metabot_id: metabot.id,
    name: metabot.name,
    mvc_address: metabot.mvc_address,
    btc_address: metabot.btc_address,
    doge_address: metabot.doge_address,
    public_key: metabot.public_key,
  };
}
