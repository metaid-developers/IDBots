import type { RolloutWave } from './types.js';

export interface WaveTenant {
  id: string;
  hostId: string;
  kind: 'customer' | 'internal' | 'synthetic' | 'demo';
  cohort: 'canary' | 'early' | 'stable';
  createdAt: number;
}

const SOAK_MS = [30 * 60_000, 30 * 60_000, 2 * 3_600_000, 2 * 3_600_000, 6 * 3_600_000, 0];
const LABELS = ['synthetic-canary', 'internal', 'one-percent', 'ten-percent', 'twenty-five-percent', 'fleet'];

export function assignRolloutWaves(
  tenants: WaveTenant[],
  soakMsOverride?: number,
): { waves: RolloutWave[]; items: Array<{ tenantId: string; hostId: string; waveIndex: number }> } {
  const rank = (tenant: WaveTenant): number => {
    if (tenant.kind === 'synthetic') return 0;
    if (tenant.kind === 'internal' || tenant.kind === 'demo') return 1;
    if (tenant.cohort === 'canary') return 2;
    if (tenant.cohort === 'early') return 3;
    return 4;
  };
  const remaining = [...tenants].sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const total = remaining.length;
  const take = (count: number, predicate?: (tenant: WaveTenant) => boolean): WaveTenant[] => {
    const selected: WaveTenant[] = [];
    for (let index = 0; index < remaining.length && selected.length < count;) {
      const tenant = remaining[index];
      if (!predicate || predicate(tenant)) {
        selected.push(tenant);
        remaining.splice(index, 1);
      } else {
        index += 1;
      }
    }
    return selected;
  };
  const groups = [
    take(1),
    take(5, (tenant) => tenant.kind === 'internal' || tenant.kind === 'demo'),
    take(Math.min(50, Math.max(1, Math.ceil(total * 0.01)))),
    take(Math.max(1, Math.ceil(total * 0.1))),
    take(Math.max(1, Math.ceil(total * 0.25))),
    take(remaining.length),
  ].filter((group) => group.length > 0);
  const waves: RolloutWave[] = [];
  const items: Array<{ tenantId: string; hostId: string; waveIndex: number }> = [];
  groups.forEach((group, groupIndex) => {
    const labelIndex = Math.min(groupIndex, LABELS.length - 1);
    waves.push({ index: groupIndex, label: LABELS[labelIndex], soakMs: soakMsOverride ?? SOAK_MS[labelIndex] });
    for (const tenant of group) items.push({ tenantId: tenant.id, hostId: tenant.hostId, waveIndex: groupIndex });
  });
  return { waves, items };
}
