import type { MobileMetabot } from '../bridge/types';

let roster: MobileMetabot[] = [];
const listeners = new Set<() => void>();

export function getMetabotRoster(): MobileMetabot[] {
  return roster;
}

export function setMetabotRoster(next: MobileMetabot[]): void {
  roster = next;
  for (const listener of listeners) listener();
}

export function subscribeMetabotRoster(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
