/**
 * Model rate matching for the price-tag transformation (S9 §4 区块3).
 *
 * /v1/me/rates exposes the display multiplier layer only (no baseRates —
 * that stays server-side). Tags render from live data; models without a
 * server rate simply show no tag. Matching: exact key hit first, then a
 * contains match (server directory keys may be family names like
 * "deepseek" while model ids read "deepseek-chat").
 */

import type { MeRateInfo } from '../../types/electron';

export function findMeRateForModel(rates: readonly MeRateInfo[], modelId: string): MeRateInfo | null {
  const id = (modelId || '').trim().toLowerCase();
  if (!id || rates.length === 0) return null;
  const exact = rates.find((rate) => rate.key.trim().toLowerCase() === id);
  if (exact) return exact;
  const contained = rates.find((rate) => {
    const key = rate.key.trim().toLowerCase();
    return key.length > 1 && (id.startsWith(`${key}-`) || id === key || id.includes(key));
  });
  return contained ?? null;
}
