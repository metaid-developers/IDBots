import type { MetaTaskCollectedPath } from './constants';

/** A chain event normalized for replay (pin list item → engine input). */
export interface MetaTaskChainEvent {
  pinId: string;
  path: MetaTaskCollectedPath;
  /** Pin author globalMetaId. */
  author: string;
  /** Genesis block height; -1 (or missing) = unconfirmed/mempool. */
  height: number;
  txIndex: number;
  timestampMs: number;
  /** Parsed payload body (contentBody base64 → JSON, fallback contentSummary). */
  body: Record<string, unknown>;
}

// ── payload bodies (fields the engine actually reads) ────────────────────────

export interface TaskPolicyPayload {
  claim_ttl_hours?: number;
  verify_quorum?: number;
  verify_window_hours?: number;
  reward_sat?: number;
  challenge_ttl_days?: number;
  /**
   * v1.3: per-task execution mode. Absent (or any non-"competitive" value)
   * means "tree" — pre-v1.3 tasks replay byte-identically.
   */
  mode?: 'tree' | 'competitive' | string;
  /** v1.3 competitive mode: the designated unique sink node (draft §3.1). */
  finalnode?: string;
  split?: {
    submitterShareBP?: number;
    reviewerFloorBP?: number;
    rosterid?: string | null;
  };
}

export interface TaskBody {
  title?: string;
  brief?: string;
  treeid?: string;
  specid?: string;
  policy?: TaskPolicyPayload;
  tags?: string[];
}

export interface TreeNodeBody {
  id: string;
  parent: string | null;
  title: string;
  kind: string;
  specid: string | null;
  params: Record<string, unknown>;
  deps: string[];
  weight?: number;
}

export interface TreeBody {
  root: string;
  nodes: TreeNodeBody[];
}

export interface AmendOp {
  op: 'add_node' | 'remove_node' | 'reweight' | 'retitle' | 'respec';
  node?: string;
  weight?: number;
  title?: string;
  specid?: string;
  /** add_node only: full node record. */
  newNode?: TreeNodeBody;
}

export interface AmendBody {
  taskid: string;
  bases: string;
  ops: AmendOp[];
}

export interface ChallengeBody {
  targetid: string;
  category: 'correctness' | 'attribution' | 'priority' | 'identity' | string;
  reason: string;
  evidence: string;
  priorref?: string | null;
  withdraw?: boolean;
}

/**
 * The fields the engine reads off a `/protocols/metatask/submission` body.
 * v1.3 competitive mode adds `parentrefs`: exactly one submission pinId per
 * `deps` entry of the node (entry nodes omit the field entirely).
 */
export interface SubmissionBody {
  taskid?: string;
  node?: string;
  claimid?: string;
  result?: Record<string, unknown>;
  hash?: string;
  contentType?: string;
  attachment?: string | null;
  supersedeid?: string;
  childids?: string[];
  parentrefs?: Record<string, string>;
}

// ── replay output ────────────────────────────────────────────────────────────

export type MetaTaskNodeStatus = 'open' | 'claimed' | 'verified';

/**
 * One competing candidate submission on a node (v1.3 competitive mode).
 * Exposed per node via `MetaTaskNodeProjection.submissions`; absent in tree
 * mode, where a node has at most one effective submission per claim cycle.
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

export interface MetaTaskVoteSummary {
  voter: string;
  verdict: 'pass' | 'fail' | 'invalid' | string;
  pinId: string;
  counted: boolean;
  ignoreReason: string | null;
  semanticCheck: boolean;
  failreason: boolean;
}

/** Display identity for a metaId (local roster first; external needs MetaSo). */
export interface MetaTaskIdentity {
  metaId: string;
  name: string | null;
  avatar: string | null;
}

export interface MetaTaskNodeProjection {
  id: string;
  parent: string | null;
  title: string;
  kind: string;
  weight: number | null;
  /** Tree-node params (what the branch task actually asks for). */
  params: Record<string, unknown> | null;
  /** Per-node verifier override (null = inherits task root spec). */
  specid: string | null;
  /**
   * The node's deps as published on the effective tree (v1.3; [] for pre-v1.3
   * trees). Display/layout input only — competitive-mode chain-validity itself
   * is engine-computed and exposed via the candidate flags; the renderer never
   * re-derives it from deps.
   */
  deps: string[];
  status: MetaTaskNodeStatus;
  disputed: boolean;
  /** Effective claim, if any. Always null in competitive mode (no locks). */
  holder: { pinId: string; claimant: string; sinceMs: number } | null;
  /**
   * Tree mode: effective submission of the current claim cycle (unchanged).
   * Competitive mode: the node's current leading candidate — the chain-valid
   * verified submission with the smallest verified time (tie: submission order
   * key) — or null while no candidate is chain-valid verified. The full
   * candidate set is then in `submissions`.
   */
  submission: {
    pinId: string;
    submitter: string;
    atMs: number;
    superseded: boolean;
    /** Result payload as published (chain fact). */
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
  /** Submission cycles that ended without verification (unpaid history input). */
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

/** Mid-task "if it settled now" share estimate, computed by estimate.ts with
 * the SAME formula the settlement manifest uses (engine-owned; callers only
 * display it). shareBP is basis points of the WHOLE task value (out of 10000)
 * and grows as more nodes verify. Never persisted, never replay output. */
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
  /** Tree in effect at boundary (after amend fold), with weights (null = legacy task). */
  nodes: TreeNodeBody[];
  /** Current tree head pinId: the original treeid, or the last effective amend (v1.2). */
  amendHead: string;
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
  /** Display identities keyed by metaId (publisher + participants + node actors). */
  identities: Record<string, MetaTaskIdentity>;
  settlement: MetaTaskSettlementManifest | null;
  /** Attached at the IPC boundary (never persisted, never part of replay
   * output): mid-task share estimates. Null once a settlement exists — use
   * settlement.shares instead. */
  estimation?: MetaTaskEstimation | null;
  /** Blocks the settlement would pay but for open challenges (node ids). */
  freshness: {
    boundaryBlock: number;
    evaluatedAtMs: number;
    eventCount: number;
    eventSetHash: string;
    expiryApplied: boolean;
  };
  /** Latest event timestamp (ms) across the task-scoped set. */
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
  /** Optional transition detail for submission_change: `${from}->${to}`. */
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
