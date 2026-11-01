import {
  normalizeGlobalMetaID,
  type GlobalMetaID,
} from '../shared/globalMetaId';

export type HardRelationshipType = 'boss' | 'twin';
export type FriendRelationshipStatus = 'confirmed' | 'not_confirmed' | 'unknown';

/** Full pair state from a friend/block aggregator: friend tri-state plus bidirectional block flags (null = unknown). */
export interface FriendPairState {
  status: FriendRelationshipStatus;
  blocking: boolean | null;
  blockedBy: boolean | null;
  /**
   * Optional directional /follow flags, from the FIRST identity's perspective
   * (the daemon passes the local bot as first): followsMe = the second
   * identity follows the first; followedByMe = the first follows the second.
   * Optional so providers without directional data stay compatible; null or
   * absent = unknown.
   */
  followsMe?: boolean | null;
  followedByMe?: boolean | null;
}

/** Minimum Bot identity projection required by the relationship resolver. */
export interface MetaIDRelationshipBot {
  id?: number | null;
  globalmetaid?: unknown;
  metabot_type?: unknown;
  boss_global_metaid?: unknown;
  enabled?: boolean | number | null;
}

export interface HardRelationshipFact {
  observerGlobalMetaID: GlobalMetaID;
  subjectGlobalMetaID: GlobalMetaID;
  relationship: HardRelationshipType;
  source: 'local_metabots';
  authoritative: true;
}

export interface FriendRelationshipProvider {
  /** Resolve the provider's current global Friend state for this pair. */
  resolveFriendStatus(input: {
    firstGlobalMetaID: GlobalMetaID;
    secondGlobalMetaID: GlobalMetaID;
  }): Promise<FriendRelationshipStatus>;
  /**
   * Optional richer resolution feeding block-aware rendering: the friend
   * tri-state plus bidirectional simpleblock flags in one call. When absent
   * the resolver falls back to resolveFriendStatus with null block flags.
   */
  resolvePairState?(input: {
    firstGlobalMetaID: GlobalMetaID;
    secondGlobalMetaID: GlobalMetaID;
  }): Promise<FriendPairState>;
}

export interface FriendRelationshipFact {
  observerGlobalMetaID: GlobalMetaID;
  subjectGlobalMetaID: GlobalMetaID;
  relationship: 'friend';
  status: FriendRelationshipStatus;
  /** True when the observer currently blocks the subject; null = unknown. */
  blocking: boolean | null;
  /** True when the subject currently blocks the observer; null = unknown. */
  blockedBy: boolean | null;
  source: 'friend_api' | 'unavailable';
  authoritative: true;
  checkedAt: number;
}

export interface MetaIDRelationshipResolverDeps {
  listMetabots: () => readonly MetaIDRelationshipBot[];
  friendProvider?: FriendRelationshipProvider;
  now?: () => number;
}

function normalizeMetabotType(value: unknown): 'twin' | 'worker' {
  return value === 'twin' ? 'twin' : 'worker';
}

function normalizeMetabotId(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : Number.MAX_SAFE_INTEGER;
}

function matchesSubject(subject: GlobalMetaID | undefined, fact: HardRelationshipFact): boolean {
  return !subject || fact.subjectGlobalMetaID === subject;
}

/**
 * Resolves authoritative local topology without persisting a second source of
 * truth. LLM-generated impressions and Friend state never enter this class's
 * hard-relationship result.
 */
export class MetaIDRelationshipResolver {
  private readonly listMetabots: () => readonly MetaIDRelationshipBot[];
  private readonly friendProvider?: FriendRelationshipProvider;
  private readonly now: () => number;

  constructor(deps: MetaIDRelationshipResolverDeps) {
    this.listMetabots = deps.listMetabots;
    this.friendProvider = deps.friendProvider;
    this.now = deps.now ?? Date.now;
  }

  resolveLocalGlobalMetaID(metabotId: unknown): GlobalMetaID | null {
    const numericId = Number(metabotId);
    if (!Number.isInteger(numericId) || numericId <= 0) return null;
    const bot = this.listMetabots().find((candidate) => Number(candidate.id) === numericId);
    return normalizeGlobalMetaID(bot?.globalmetaid);
  }

  getHardRelationships(observerValue: unknown, subjectValue?: unknown): HardRelationshipFact[] {
    const observerGlobalMetaID = normalizeGlobalMetaID(observerValue);
    if (!observerGlobalMetaID) return [];
    const subjectGlobalMetaID = subjectValue === undefined
      ? undefined
      : normalizeGlobalMetaID(subjectValue);
    if (subjectValue !== undefined && !subjectGlobalMetaID) return [];
    const bots = [...this.listMetabots()];
    const observer = bots.find(
      (candidate) => normalizeGlobalMetaID(candidate.globalmetaid) === observerGlobalMetaID,
    );
    if (!observer) return [];

    const facts: HardRelationshipFact[] = [];
    const addFact = (relationship: HardRelationshipType, subject: unknown): void => {
      const factSubjectGlobalMetaID = normalizeGlobalMetaID(subject);
      if (!factSubjectGlobalMetaID || factSubjectGlobalMetaID === observerGlobalMetaID) return;
      const fact = {
        observerGlobalMetaID,
        subjectGlobalMetaID: factSubjectGlobalMetaID,
        relationship,
        source: 'local_metabots' as const,
        authoritative: true as const,
      } satisfies HardRelationshipFact;
      if (!matchesSubject(subjectGlobalMetaID, fact)) return;
      if (!facts.some((existing) =>
        existing.relationship === fact.relationship
        && existing.subjectGlobalMetaID === fact.subjectGlobalMetaID
      )) {
        facts.push(fact);
      }
    };

    addFact('boss', observer.boss_global_metaid);

    // The machine invariant is one Twin. Sorting makes the resolver defensive
    // if it is called while reading a legacy database before migration repair.
    if (normalizeMetabotType(observer.metabot_type) === 'worker') {
      const twin = bots
        .filter((candidate) => normalizeMetabotType(candidate.metabot_type) === 'twin')
        .sort((left, right) => normalizeMetabotId(left.id) - normalizeMetabotId(right.id))[0];
      addFact('twin', twin?.globalmetaid);
    }

    return facts;
  }

  async resolveFriend(
    observerValue: unknown,
    subjectValue: unknown,
  ): Promise<FriendRelationshipFact | null> {
    const observerGlobalMetaID = normalizeGlobalMetaID(observerValue);
    const subjectGlobalMetaID = normalizeGlobalMetaID(subjectValue);
    const checkedAt = this.now();
    if (!observerGlobalMetaID || !subjectGlobalMetaID || observerGlobalMetaID === subjectGlobalMetaID) {
      return null;
    }

    if (!this.friendProvider) {
      return {
        observerGlobalMetaID,
        subjectGlobalMetaID,
        relationship: 'friend',
        status: 'unknown',
        blocking: null,
        blockedBy: null,
        source: 'unavailable',
        authoritative: true,
        checkedAt,
      };
    }

    try {
      let status: FriendRelationshipStatus;
      let blocking: boolean | null = null;
      let blockedBy: boolean | null = null;
      if (typeof this.friendProvider.resolvePairState === 'function') {
        const pairState = await this.friendProvider.resolvePairState({
          firstGlobalMetaID: observerGlobalMetaID,
          secondGlobalMetaID: subjectGlobalMetaID,
        });
        status = pairState.status;
        blocking = pairState.blocking === null ? null : pairState.blocking === true;
        blockedBy = pairState.blockedBy === null ? null : pairState.blockedBy === true;
      } else {
        status = await this.friendProvider.resolveFriendStatus({
          firstGlobalMetaID: observerGlobalMetaID,
          secondGlobalMetaID: subjectGlobalMetaID,
        });
      }
      const normalizedStatus: FriendRelationshipStatus =
        status === 'confirmed' || status === 'not_confirmed' ? status : 'unknown';
      return {
        observerGlobalMetaID,
        subjectGlobalMetaID,
        relationship: 'friend',
        status: normalizedStatus,
        blocking,
        blockedBy,
        source: 'friend_api',
        authoritative: true,
        checkedAt,
      };
    } catch {
      // An unavailable current-state API is not evidence that the pair is not
      // friends. Preserve the tri-state contract at the boundary.
      return {
        observerGlobalMetaID,
        subjectGlobalMetaID,
        relationship: 'friend',
        status: 'unknown',
        blocking: null,
        blockedBy: null,
        source: 'unavailable',
        authoritative: true,
        checkedAt,
      };
    }
  }
}
