/**
 * Memory importance — the single derivation rule for the `user_memories.importance`
 * column and the recall-time guarantees built on it.
 *
 * Why: the nightly dream writes fresh forceNew entries every day, and the
 * pre-importance candidate pool was pure `updated_at DESC` — an old explicit
 * user instruction silently aged out of the top-N pool. Importance separates
 * "how much this matters" from "when it was last touched":
 *   - writes derive it here (create/revive/update all share this mapping,
 *     never a scattered literal);
 *   - recall guarantees entries at/above GUARANTEED_THRESHOLD a budgeted
 *     injection slot and evicts lowest-importance-first when over budget.
 * The same mapping backs the one-time schema backfill in coworkStore.
 */

import type { MemoryOrigin, MemoryUsageClass } from './memoryScope';

export const MEMORY_IMPORTANCE_DEFAULT = 0.5;
/** Entries at/above this score get the guaranteed injection tier. */
export const MEMORY_IMPORTANCE_GUARANTEED_THRESHOLD = 0.85;
/** Hard cap on the guaranteed tier; overflow still falls to the char budget. */
export const MEMORY_IMPORTANCE_GUARANTEED_MAX_ITEMS = 10;

export function clampMemoryImportance(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return MEMORY_IMPORTANCE_DEFAULT;
  return Math.max(0, Math.min(1, parsed));
}

/**
 * Derive the stored importance for a memory row. Precedence mirrors the
 * backfill CASE in coworkStore.ensureMemorySchemaCompatibility — keep the two
 * in sync when the mapping changes.
 */
export function deriveMemoryImportance(input: {
  usageClass?: MemoryUsageClass | string | null;
  origin?: MemoryOrigin | string | null;
  isExplicit?: boolean;
}): number {
  if (input.usageClass === 'self_identity') return 1.0;
  if (input.isExplicit === true) return 0.9;
  if (input.origin === 'dream') {
    if (input.usageClass === 'value_boundary') return 0.75;
    if (input.usageClass === 'work_review') return 0.7;
    if (input.usageClass === 'profile_fact') return 0.65;
  }
  if (input.usageClass === 'preference' || input.usageClass === 'operational_preference') return 0.6;
  return MEMORY_IMPORTANCE_DEFAULT;
}
