/**
 * MetaTask renderer-facing types (P1 read path). Mirrors the main-process
 * projection shapes in src/main/services/metatask/types.ts — the renderer
 * never re-derives node states; it only renders what replay produced.
 */

export type MetaTaskNodeStatus = 'open' | 'claimed' | 'verified';

export interface MetaTaskIdentity {
  metaId: string;
  name: string | null;
  avatar: string | null;
}

export interface MetaTaskVoteSummary {
  voter: string;
  verdict: string;
  pinId: string;
  counted: boolean;
  ignoreReason: string | null;
  semanticCheck: boolean;
  failreason: boolean;
}

export interface MetaTaskNodeProjection {
  id: string;
  parent: string | null;
  title: string;
  kind: string;
  weight: number | null;
  params: Record<string, unknown> | null;
  specid: string | null;
  status: MetaTaskNodeStatus;
  disputed: boolean;
  holder: { pinId: string; claimant: string; sinceMs: number } | null;
  submission: {
    pinId: string;
    submitter: string;
    atMs: number;
    superseded: boolean;
    result: Record<string, unknown> | null;
    hash: string | null;
    contentType: string | null;
    attachment: string | null;
  } | null;
  passVotes: number;
  failVotes: number;
  votes: MetaTaskVoteSummary[];
  cycleCount: number;
}

export interface MetaTaskParticipantStats {
  metaId: string;
  effectiveClaims: number;
  submissions: number;
  verifiedContrib: number;
  reviewVotes: number;
  reviewCorrect: number;
  reviewTerminal: number;
}

/** Mid-task "if it settled now" share estimate, computed main-side by the same
 * formula the settlement manifest uses (engine-owned; the renderer only
 * displays it). shareBP is basis points of the WHOLE task value (out of
 * 10000); it grows as more nodes verify. */
export interface MetaTaskShareEstimate {
  metaId: string;
  shareBP: number;
  from: { submittedBP: number; reviewedBP: number };
}

export interface MetaTaskEstimation {
  basis: 'weighted' | 'uniform';
  shares: MetaTaskShareEstimate[];
}

export interface MetaTaskSettlementShare {
  metaId: string;
  shareBP: number;
  from: { submittedBP: number; reviewedBP: number };
}

export interface MetaTaskSettlementManifest {
  taskid: string;
  boundaryBlock: number;
  eventSetHash: string;
  engineAlgoVersion: string;
  shares: MetaTaskSettlementShare[];
  unpaidHistory: { node: string; author: string; pinId: string; reason: string }[];
  disputed: string[];
  weightsTableHash: string;
}

export interface MetaTaskTaskProjection {
  rootPinId: string;
  title: string;
  brief: string;
  publisher: string;
  tags: string[];
  policy: {
    claimTtlHours: number;
    verifyQuorum: number;
    verifyWindowHours: number;
    rewardSat: number;
    challengeTtlDays: number;
    hasSplit: boolean;
    rosterid: string | null;
    /** σ actually used by the engine's split, clamped to [6000, 9000]
     * (defaults to 8000 when the task carries no split block). */
    submitterShareBP: number;
  };
  nodes: { id: string; parent: string | null; title: string; kind: string; weight?: number }[];
  nodeStates: Record<string, MetaTaskNodeProjection>;
  progress: { total: number; verified: number; claimed: number; open: number; disputed: number };
  taskComplete: boolean;
  participants: MetaTaskParticipantStats[];
  identities: Record<string, MetaTaskIdentity>;
  settlement: MetaTaskSettlementManifest | null;
  /** Attached at the IPC boundary (never persisted, never part of replay
   * output): mid-task share estimates. Null/absent once settlement exists —
   * use settlement.shares instead. */
  estimation?: MetaTaskEstimation | null;
  freshness: {
    boundaryBlock: number;
    evaluatedAtMs: number;
    eventCount: number;
    eventSetHash: string;
    expiryApplied: boolean;
  };
  lastActivityMs: number;
  ignoredEvents: { pinId: string; reason: string }[];
}

export interface MetaTaskBoardTask {
  rootPinId: string;
  title: string;
  brief: string;
  publisher: string;
  tags: string[];
  taskComplete: boolean;
  progress: { total: number; verified: number; claimed: number; open: number; disputed: number };
  participantCount: number;
  lastActivityMs: number;
  freshness: { boundaryBlock: number; evaluatedAtMs: number; eventCount: number };
  myRoles: ('publisher' | 'participant')[];
  myStats: {
    claimed: number;
    submitted: number;
    verified: number;
    reviewVotes: number;
    shareBP: number;
    /** Sum of the local roster's estimated shares (whole-task basis points)
     * for work verified SO FAR — shown as "est. share" while the task runs;
     * shareBP above is the settled truth once a manifest exists. */
    estShareBP: number;
  } | null;
  settlementFinalized: boolean;
}

export interface MetaTaskAlert {
  kind: 'claim_ttl_soon' | 'submission_change' | 'closing_drive';
  rootPinId: string;
  node: string | null;
  detail: string | null;
  createdAtMs: number;
}

export interface MetaTaskBoard {
  localRosterMetaIds: string[];
  tasks: MetaTaskBoardTask[];
  alerts: MetaTaskAlert[];
  /** Merged display identities across tasks (publisher + participants). */
  identities: Record<string, MetaTaskIdentity>;
  /**
   * Activation notice inputs: hAct2 = the v1.2 feature gate, hAct3 = the v1.3
   * competitive-mode gate (null = not announced yet; writer tools refuse
   * competitive publishes until the boundary block reaches it).
   */
  activation: { hAct2: number | null; hAct3: number | null };
  refresh: {
    lastRefreshAtMs: number | null;
    lastOkAtMs: number | null;
    lastError: string | null;
    boundaryBlock: number | null;
    refreshing: boolean;
  };
}
