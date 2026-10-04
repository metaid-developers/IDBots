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
  /**
   * The submission pin this vote targets (vote.body.targetid). The node-level
   * `votes` list only carries the leading/effective submission's votes; the
   * candidate drawer filters it by this field to rebuild ONE candidate's
   * review timeline. Absent on projections cached before format v3 — the
   * drawer falls back to the whole node list then.
   */
  targetid?: string;
  /** Genesis block height of the vote pin (review-timeline anchor). */
  height?: number;
  /** Vote pin timestamp in ms (review-timeline display). */
  timestampMs?: number;
  /** Full failreason text when the verdict carries one (else null/absent). */
  failreasonText?: string | null;
  /** Full semantic_check text when the vote carries one (else null/absent). */
  semanticCheckText?: string | null;
}

/**
 * One competing candidate submission on a node (v1.3 competitive mode).
 * Exposed per node via `MetaTaskNodeProjection.submissions`; absent in tree
 * mode, where a node has at most one effective submission per claim cycle.
 * Every flag here (verified / chainValid / superseded / failed) is engine
 * replay output — the renderer maps them to display states, it never
 * re-derives them.
 */
export interface MetaTaskSubmissionCandidate {
  pinId: string;
  submitter: string;
  atMs: number;
  /** Result payload as published (chain fact). */
  result: Record<string, unknown> | null;
  hash: string | null;
  contentType: string | null;
  attachment: string | null;
  /** Validated parent references (depNodeId -> submission pinId); null on entry nodes. */
  parentrefs: Record<string, string> | null;
  /** Reached verify quorum with zero counted fail verdicts at the boundary. */
  verified: boolean;
  /** Verified AND every parentref ancestor recursively chain-valid (draft §3.1). */
  chainValid: boolean;
  /** Replaced by a valid same-author supersede. */
  superseded: boolean;
  /** Killed by a counted fail verdict (never revives; terminal). */
  failed: boolean;
  /** Counted pass/fail votes on THIS candidate (identity-filtered). */
  passVotes: number;
  failVotes: number;
  /** Order key of the counted pass vote that reached quorum; null while unverified. */
  verifiedHeight: number | null;
  verifiedTxIndex: number | null;
}

export interface MetaTaskNodeProjection {
  id: string;
  parent: string | null;
  title: string;
  kind: string;
  weight: number | null;
  params: Record<string, unknown> | null;
  specid: string | null;
  /**
   * The node's deps as published on the effective tree (v1.3; [] for pre-v1.3
   * trees). Drives chain-view layout only — candidate state flags are
   * engine-computed and must not be re-derived from deps in the renderer.
   */
  deps: string[];
  status: MetaTaskNodeStatus;
  disputed: boolean;
  holder: { pinId: string; claimant: string; sinceMs: number } | null;
  /**
   * Tree mode: effective submission of the current claim cycle (unchanged).
   * Competitive mode: the node's current leading candidate (chain-valid
   * verified, smallest verified time) — or null while none qualifies. The full
   * candidate set is then in `submissions`.
   */
  submission: {
    pinId: string;
    submitter: string;
    atMs: number;
    superseded: boolean;
    result: Record<string, unknown> | null;
    hash: string | null;
    contentType: string | null;
    attachment: string | null;
    /** Competitive mode only: validated parent references of this submission. */
    parentrefs?: Record<string, string> | null;
  } | null;
  /**
   * Competitive mode only: every structurally valid candidate submission on
   * this node, in chain order (includes superseded and failed candidates).
   * Undefined in tree mode.
   */
  submissions?: MetaTaskSubmissionCandidate[];
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
  /**
   * v1.3: present on competitive-mode manifests only (draft §3.7); tree-mode
   * manifests stay byte-identical to v1.2.1 and omit both fields.
   */
  mode?: 'competitive';
  /** Submission pinIds of the winning chain, sorted by node id (draft §3.6). */
  winningChain?: string[];
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
    /** v1.3: the task's execution mode (absent policy.mode ⇒ "tree"). */
    mode: 'tree' | 'competitive';
    /** v1.3 competitive mode: policy.finalnode as published (null when absent). */
    finalNode: string | null;
  };
  nodes: {
    id: string;
    parent: string | null;
    title: string;
    kind: string;
    weight?: number;
    /** v1.3 deps as published (absent on pre-v1.3 trees). */
    deps?: string[];
  }[];
  nodeStates: Record<string, MetaTaskNodeProjection>;
  /**
   * `satisfied` counts nodes meeting the mode's completion predicate (tree:
   * final-verified, identical to `verified`; competitive: has ≥1 chain-valid
   * verified submission). In competitive mode `verified`/`claimed`/`open`
   * classify nodes by their leading-candidate state (satisfied / live
   * candidates only / none).
   */
  progress: { total: number; verified: number; claimed: number; open: number; disputed: number; satisfied: number };
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
  /** Execution mode (absent on legacy cached rows ⇒ treat as "tree"). */
  mode?: 'tree' | 'competitive';
  taskComplete: boolean;
  /** v1.3 adds `satisfied` (mode completion predicate count); absent on
   * projections cached before v1.3. */
  progress: { total: number; verified: number; claimed: number; open: number; disputed: number; satisfied?: number };
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
