import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import type { ChainWriteCreatePin } from './postBuzzAgentTools';
import { innerHash, outerHash } from '../services/metatask/canon';
import { rosterPinsFromEvents } from '../services/metatask/collector';
import { H_ACT3, METATASK_ROSTER_PATH } from '../services/metatask/constants';
import { estimateMetaTaskShares } from '../services/metatask/estimate';
import { replayMetaTask } from '../services/metatask/engine';
import type {
  MetaTaskBoard,
  MetaTaskChainEvent,
  MetaTaskTaskProjection,
} from '../services/metatask/types';

/**
 * MetaTask agent tools — the session bot's participation surface for the
 * on-chain multi-bot collaboration protocol (/protocols/metatask, v1.2 rev-2
 * draft). Productizes the on-chain skill packages: claim-with-guard (never
 * spend a fee on a non-open node), #8/#9-disciplined review drafts, hash
 * assembly per the frozen canon, and publish invariants.
 *
 * Discipline the tool descriptions encode:
 *  - claim runs the replay guard FIRST; a non-open node is refused before
 *    any chain spend (claim-rejected:<node>:<state>), and the task root
 *    author is refused its own task (protocol §12 item 6: submitter != root
 *    author; the refusal is writer-side, the engine does not enforce it).
 *  - verify forces semantic_check (ruling #9) and failreason on fail
 *    (ruling #8) at WRITE time, so votes never land as not-counted.
 *  - same-side review is refused locally (roster = local bots); the
 *    chain-side roster rule is H_ACT2-gated in the engine and fed from the
 *    collected /protocols/metatask-roster pins.
 *  - publish runs tree → spec → task with the weight invariant (sum=10000)
 *    checked before the first pin is spent.
 *  - a STANDALONE spec pin (node-level specid override that must exist before
 *    its tree) is written by metatask_publish_spec: one pin, no carrier task,
 *    and the v1.2.1 three-item validation block enforced at write time.
 *  - the chain is the source of truth: after every write the local
 *    projection refreshes in the background; reads state their boundary block.
 */

type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
) => unknown;

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function jsonResult(value: unknown) {
  return textResult(JSON.stringify(value, null, 2));
}

const PIN_VERSION = '1.1.0';

export interface MetaTaskAgentControl {
  /** Chain-sourced projection refresher (rebuildable cache, never the record). */
  refresher: () => {
    board: () => MetaTaskBoard;
    detail: (rootPinId: string) => MetaTaskTaskProjection | null;
    refreshOnce: (reason: string) => Promise<{ ok: boolean; error: string | null }>;
    loadEvents: () => MetaTaskChainEvent[];
  };
  /** globalMetaIds of every local bot (the same-owner roster side). */
  localRosterMetaIds: () => string[];
  /** Session bot's globalMetaId by metabot id. */
  resolveGlobalMetaId: (metabotId: number) => string | null;
}

const asString = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Spec script reference form (protocol §3): pin:// or metafile://, no spaces. */
const SPEC_REF_RE = /^(pin:\/\/|metafile:\/\/)\S+$/;
/** Obvious "publish me later" tokens that must never reach the chain as a ref. */
const SPEC_PLACEHOLDER_RE = /PUBLISH_ARTIFACT_FIRST|PLACEHOLDER|TODO|FIXME|TBD/i;
/** A single-line URI-looking value must be a protocol reference, not e.g. https://. */
const URI_LOOKING_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
/** The v1.2.1 spec.validation items (protocol §3, mandatory at/after H_ACT2). */
const SPEC_VALIDATION_ITEMS = ['null_tolerance', 'enumeration_closure', 'proposition_fidelity'] as const;

interface SpecPayloadInput {
  name?: string;
  lang?: string;
  entry?: string;
  script?: string;
  input?: unknown;
  output?: unknown;
  validation?: Record<string, unknown>;
}

/**
 * The canonical spec pin payload (protocol §3), shared by metatask_publish and
 * metatask_publish_spec so both writers emit byte-identical field order:
 * name, lang, entry, script, input, output, then validation when present.
 */
const buildSpecPayload = (spec: SpecPayloadInput): Record<string, unknown> => {
  const payload: Record<string, unknown> = {
    name: asString(spec.name).trim(),
    lang: asString(spec.lang).trim() || 'bash',
    entry: asString(spec.entry).trim(),
    script: spec.script === undefined ? '' : spec.script,
    input: spec.input ?? '',
    output: spec.output ?? '',
  };
  if (isPlainObject(spec.validation)) payload.validation = spec.validation;
  return payload;
};

/** Refuse a missing/empty/bogus script reference; returns null when usable. */
const specScriptRefusal = (script: unknown): string | null => {
  const text = typeof script === 'string' ? script.trim() : '';
  if (!text) {
    return 'Refused: a spec pin needs a verifier script — inline text, or a pin:// | metafile:// reference when too long (protocol §3).';
  }
  if (!text.includes('\n') && URI_LOOKING_RE.test(text) && !SPEC_REF_RE.test(text)) {
    return `Refused: the script looks like a URI reference but is not pin:// or metafile:// ("${text}") — protocol §3 allows inline text or a pin:// | metafile:// reference.`;
  }
  return null;
};

/**
 * True when an integer number appears ANYWHERE inside the value. The protocol
 * requires enumeration_closure to carry "at least one concrete self-check
 * vector whose expected count is an INTEGER field" without prescribing where
 * that field lives, so the campaign drafts nest it (e.g.
 * `selfcheck: { expected_count: 4 }`) and an array of vectors is equally valid.
 */
const hasIntegerAtAnyDepth = (value: unknown, depth = 0): boolean => {
  if (typeof value === 'number') return Number.isInteger(value);
  if (depth > 8 || !value || typeof value !== 'object') return false;
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return children.some((child) => hasIntegerAtAnyDepth(child, depth + 1));
};

// ── campaign drafts file mode ────────────────────────────────────────────────
// The wave-1 launch kit ships one machine-validated drafts JSON (specs{} +
// tasks[]). Reading it directly removes the LLM transcription risk of
// re-typing a large nested spec/validation argument by hand — a real launch
// failed exactly that way and misread the mangled JSON as a gate disagreement.

/** Node specid placeholders the drafts carry until their spec pins exist. */
const SPEC_PIN_PREFIX = 'SPEC_PIN:';

interface DraftsPublishInput {
  taskId: string;
  title: string;
  brief: string;
  nodes: Array<Record<string, unknown>>;
  policy: Record<string, unknown>;
  tags: unknown;
  spec: SpecPayloadInput;
}

const readDraftsFile = (draftsFile: string): Record<string, unknown> | string => {
  if (!path.isAbsolute(draftsFile)) {
    return `Refused: draftsFile must be an absolute path (got "${draftsFile}").`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(draftsFile, 'utf8'));
  } catch (error) {
    return `Refused: cannot read draftsFile "${draftsFile}" — ${error instanceof Error ? error.message : String(error)}.`;
  }
  if (!isPlainObject(parsed)) {
    return `Refused: draftsFile "${draftsFile}" must contain a JSON object.`;
  }
  return parsed;
};

/**
 * One `specs[key]` entry, normalized to the spec payload input shape — or a
 * refusal message. (Helpers in this file return the value or a refusal string;
 * the electron build runs without strictNullChecks, so boolean-discriminated
 * union narrowing is unavailable.)
 */
const specFromDrafts = (drafts: Record<string, unknown>, specKey: string): SpecPayloadInput | string => {
  const specs = drafts.specs;
  if (!isPlainObject(specs)) {
    return 'Refused: draftsFile has no specs{} object (expected the campaign drafts shape).';
  }
  const raw = specs[specKey];
  if (!isPlainObject(raw)) {
    const available = Object.keys(specs).sort().join(', ');
    return `Refused: specs["${specKey}"] not found in the draftsFile (available: ${available || 'none'}).`;
  }
  return {
    name: asString(raw.name),
    lang: asString(raw.lang),
    entry: asString(raw.entry),
    script: typeof raw.script === 'string' ? raw.script : '',
    input: raw.input,
    output: raw.output,
    validation: isPlainObject(raw.validation) ? raw.validation : undefined,
  };
};

/**
 * Replace `SPEC_PIN:<key>` node specid placeholders with the published pins
 * from `specPinByKey`; the returned string is a refusal listing EVERY unmapped
 * placeholder so the caller can publish those specs first. Nodes with a null
 * specid stay null (they inherit the task root spec).
 */
const substituteSpecPins = (nodes: unknown[], specPinByKey: Record<string, string>): unknown[] | string => {
  const unmapped = new Set<string>();
  const substituted = nodes.map((node) => {
    if (!isPlainObject(node)) return node;
    const specid = typeof node.specid === 'string' ? node.specid.trim() : '';
    if (!specid.startsWith(SPEC_PIN_PREFIX)) return node;
    const key = specid.slice(SPEC_PIN_PREFIX.length).trim();
    const pinId = asString(specPinByKey?.[key]).trim();
    if (!key || !pinId) {
      unmapped.add(key || specid);
      return node;
    }
    return { ...node, specid: pinId };
  });
  if (unmapped.size > 0) {
    const named = [...unmapped].sort().map((key) => `${SPEC_PIN_PREFIX}${key}`).join(', ');
    return `Refused: unmapped node specid placeholder(s) ${named} — publish each standalone spec first with metatask_publish_spec and pass its specPinId in specPinByKey.`;
  }
  return substituted;
};

/** One `tasks[]` entry (its ready `publish` object plus the root spec). */
const taskFromDrafts = (
  drafts: Record<string, unknown>,
  taskId: string,
  specPinByKey: Record<string, string>
): DraftsPublishInput | string => {
  const tasks = Array.isArray(drafts.tasks) ? drafts.tasks : [];
  if (tasks.length === 0) {
    return 'Refused: draftsFile has no tasks[] array (expected the campaign drafts shape).';
  }
  const entry = tasks.find(
    (candidate) =>
      isPlainObject(candidate) && (asString(candidate.id) === taskId || asString(candidate.taskId) === taskId)
  );
  if (!isPlainObject(entry)) {
    const available = tasks
      .map((candidate) => (isPlainObject(candidate) ? asString(candidate.id) || asString(candidate.taskId) : ''))
      .filter(Boolean)
      .sort()
      .join(', ');
    return `Refused: no tasks[] entry with id "${taskId}" (available: ${available || 'none'}).`;
  }
  const publish = entry.publish;
  if (!isPlainObject(publish)) {
    return `Refused: tasks[] entry "${taskId}" has no publish object.`;
  }
  if (!Array.isArray(publish.nodes)) {
    return `Refused: tasks[] entry "${taskId}" publish.nodes must be an array.`;
  }
  const rootSpecKey = asString(entry.rootSpec).trim();
  if (!rootSpecKey) {
    return `Refused: tasks[] entry "${taskId}" has no rootSpec key for its root verifier spec.`;
  }
  const spec = specFromDrafts(drafts, rootSpecKey);
  if (typeof spec === 'string') return spec;
  const nodes = substituteSpecPins(publish.nodes, specPinByKey);
  if (typeof nodes === 'string') return nodes;
  return {
    taskId,
    title: asString(publish.title),
    brief: asString(publish.brief),
    nodes: nodes.filter(isPlainObject) as Array<Record<string, unknown>>,
    policy: isPlainObject(publish.policy) ? publish.policy : {},
    tags: publish.tags,
    spec,
  };
};

/**
 * Writer-side enforcement of the v1.2.1 spec.validation block (protocol §3,
 * mandatory for specs published at/after H_ACT2): all three items present,
 * null_tolerance boolean true, enumeration_closure declaring the closure plus
 * an integer self-check count, and proposition_fidelity pointing at a REAL
 * independent correspondence artifact — never a self-attested boolean and
 * never a publish-me-later placeholder. Returns a refusal message or null.
 */
const specValidationRefusal = (validation: unknown): string | null => {
  if (!isPlainObject(validation)) {
    return `Refused: spec.validation is required (protocol §3, mandatory at/after H_ACT2) — a block carrying all three items: ${SPEC_VALIDATION_ITEMS.join(', ')}.`;
  }
  const missing = SPEC_VALIDATION_ITEMS.filter((item) => !(item in validation));
  if (missing.length > 0) {
    return `Refused: spec.validation is missing ${missing.join(', ')} — protocol §3 requires all three items (null/missing input -> verdict=invalid; the enumeration closure with an integer self-check count; proposition fidelity against an INDEPENDENT correspondence artifact).`;
  }
  if (validation.null_tolerance !== true) {
    return 'Refused: spec.validation.null_tolerance must be boolean true (protocol §3: every branch maps null/missing input to verdict=invalid with a location in detail).';
  }
  const closure = validation.enumeration_closure;
  if (!isPlainObject(closure) || !asString(closure.closure).trim() || !hasIntegerAtAnyDepth(closure)) {
    return 'Refused: spec.validation.enumeration_closure needs the closure declared in a string `closure` field AND at least one integer self-check count (any depth within the block), so replay can mechanically reconcile theory vs implementation (protocol §3).';
  }
  const fidelity = validation.proposition_fidelity;
  if (!isPlainObject(fidelity)) {
    return 'Refused: spec.validation.proposition_fidelity must be an object referencing an INDEPENDENT correspondence artifact (protocol §3).';
  }
  const booleanItem = Object.entries(fidelity).find(([, value]) => typeof value === 'boolean');
  if (booleanItem) {
    return `Refused: spec.validation.proposition_fidelity.${booleanItem[0]} is a self-attested boolean — protocol §3 makes that NON-compliant; the artifact pin itself must carry the per-item table (statement / definitions / proof direction).`;
  }
  const reference =
    typeof fidelity.correspondence === 'string'
      ? fidelity.correspondence
      : typeof fidelity.artifactPin === 'string'
        ? fidelity.artifactPin
        : typeof fidelity.artifact === 'string'
          ? fidelity.artifact
          : '';
  const trimmedReference = reference.trim();
  if (!trimmedReference) {
    return 'Refused: spec.validation.proposition_fidelity needs the correspondence artifact referenced as pin:// | metafile:// (field `correspondence`, or `artifactPin` for the campaign shape) — a self-declared flag is non-compliant.';
  }
  if (SPEC_PLACEHOLDER_RE.test(trimmedReference)) {
    return `Refused: proposition_fidelity still carries the placeholder "${trimmedReference}" — publish the correspondence artifact pin FIRST, then substitute its pinId.`;
  }
  if (!SPEC_REF_RE.test(trimmedReference)) {
    return `Refused: proposition_fidelity must reference a REAL correspondence artifact (pin:// | metafile://) — got "${trimmedReference}".`;
  }
  return null;
};

// ── competitive mode (protocol v1.3.0 draft §3/§4) ───────────────────────────
// Writer-side mirrors of the engine's competitive invariants. Every check runs
// BEFORE the first pin is spent: a task/submission that replay would ignore or
// leave unsatisfiable is refused locally instead of dying on-chain.

interface CompetitiveNodeShape {
  id: string;
  deps: string[];
  params: Record<string, unknown>;
}

/** deps-DAG sinks: nodes no other node lists in `deps` (draft §3.1). */
const depsSinkIds = (nodes: readonly CompetitiveNodeShape[]): string[] => {
  const referenced = new Set<string>();
  for (const node of nodes) for (const dep of node.deps) referenced.add(dep);
  return nodes.filter((node) => !referenced.has(node.id)).map((node) => node.id);
};

/** DFS over deps edges (node -> what it depends on); dangling refs are ruled separately. */
const depsGraphAcyclic = (nodes: readonly CompetitiveNodeShape[]): boolean => {
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const state = new Map<string, 1 | 2>(); // 1 = on the DFS stack, 2 = done
  const visit = (id: string): boolean => {
    const mark = state.get(id);
    if (mark === 2) return true;
    if (mark === 1) return false;
    state.set(id, 1);
    for (const dep of byId.get(id)?.deps ?? []) {
      if (!byId.has(dep)) continue;
      if (!visit(dep)) return false;
    }
    state.set(id, 2);
    return true;
  };
  for (const node of nodes) {
    if (!visit(node.id)) return false;
  }
  return true;
};

/**
 * Writer-side competitive tree invariants (draft §3.1/§3.3, authoring list §5):
 * `finalnode` names a live node; the deps graph is acyclic with exactly ONE
 * sink and that sink IS the final node; every node is reachable from an entry
 * node (deps: []) and can reach the final node. In a finite acyclic graph the
 * two reachability legs are already implied by the unique-sink rule — they are
 * checked anyway so a breach reports the precise broken leg, and so the rule
 * survives a future relaxation of the single-sink rule (§9 Q1).
 */
const competitiveGraphRefusal = (
  nodes: readonly CompetitiveNodeShape[],
  finalnode: string,
): string | null => {
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  if (!byId.has(finalnode)) {
    return `Refused: policy.finalnode "${finalnode}" is not a node of this task — competitive mode requires the designated terminal node to be a live tree node (draft §3.1).`;
  }
  if (!depsGraphAcyclic(nodes)) {
    return 'Refused: the deps graph is cyclic — competitive mode enforces deps as a partial-order DAG (draft §3.3).';
  }
  const sinks = depsSinkIds(nodes);
  if (sinks.length !== 1) {
    return `Refused: competitive mode requires exactly ONE deps sink (draft §3.1) — found ${sinks.length} (${[...sinks].sort().join(', ')}).`;
  }
  if (sinks[0] !== finalnode) {
    return `Refused: the unique deps sink is "${sinks[0]}" but policy.finalnode is "${finalnode}" — the designated terminal node must BE the sink (draft §3.1).`;
  }
  // Reverse adjacency: dep -> the nodes that depend on it (work-flow direction).
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dep of node.deps) {
      const list = dependents.get(dep) ?? [];
      list.push(node.id);
      dependents.set(dep, list);
    }
  }
  const flowClosure = (starts: string[]): Set<string> => {
    const seen = new Set<string>();
    const queue = [...starts];
    while (queue.length) {
      const current = queue.pop() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of dependents.get(current) ?? []) queue.push(next);
    }
    return seen;
  };
  const fromEntries = flowClosure(nodes.filter((node) => node.deps.length === 0).map((node) => node.id));
  for (const node of nodes) {
    if (!fromEntries.has(node.id)) {
      return `Refused: node ${node.id} is not reachable from any entry node (deps: []) — every node must sit on the work flow (draft §3.3).`;
    }
  }
  // "Can reach the final node" = sits inside finalnode's transitive deps
  // closure (walk deps edges backward from the terminal node).
  const toFinal = new Set<string>();
  const stack = [finalnode];
  while (stack.length) {
    const current = stack.pop() as string;
    if (toFinal.has(current)) continue;
    toFinal.add(current);
    for (const dep of byId.get(current)?.deps ?? []) stack.push(dep);
  }
  for (const node of nodes) {
    if (!toFinal.has(node.id)) {
      return `Refused: node ${node.id} can never feed the terminal node "${finalnode}" — every node must reach the final node through deps (draft §3.3).`;
    }
  }
  return null;
};

/**
 * Every competitive node carries a non-empty rubric (draft §3.3, pinned
 * location: `params.rubric` — an array of strings with at least one non-empty
 * entry). The rubric is the reviewer's acceptance checklist; without it a node
 * is unjudgeable open-ended work.
 */
const competitiveRubricRefusal = (node: { id: string; params: Record<string, unknown> }): string | null => {
  const rubric = node.params?.rubric;
  if (!Array.isArray(rubric)) {
    return `Refused: node ${node.id} has no rubric — competitive mode pins per-node acceptance criteria at params.rubric, an array of strings with at least one non-empty entry (draft §3.3).`;
  }
  const entries = rubric.filter((entry) => typeof entry === 'string' && entry.trim().length > 0);
  if (entries.length === 0) {
    return `Refused: node ${node.id} rubric has no non-empty entry — params.rubric needs at least one concrete acceptance criterion (draft §3.3).`;
  }
  return null;
};

/** Full git commit hash (sha1/sha256 hex) for git-bundle results (draft §4.2). */
const GIT_COMMIT_RE = /^[0-9a-f]{40}$/i;

export function buildMetataskAgentTools(deps: {
  tool: SdkToolFactory;
  control: MetaTaskAgentControl;
  createPin: ChainWriteCreatePin;
  sessionId: string;
  resolveMetabotId: (sessionId: string) => number | undefined;
}): unknown[] {
  const { tool, control } = deps;
  const refresher = () => control.refresher();

  const identity = (): { metabotId: number; globalMetaId: string } | { error: string } => {
    const metabotId = deps.resolveMetabotId(deps.sessionId);
    if (metabotId == null) {
      return { error: 'metatask tools could not determine which MetaBot owns this session — no wallet/identity to act with. Ask the user which MetaBot should participate.' };
    }
    const globalMetaId = control.resolveGlobalMetaId(metabotId);
    if (!globalMetaId) {
      return { error: `MetaBot ${metabotId} has no globalMetaId yet — it must be initialized on-chain before participating in MetaTasks.` };
    }
    return { metabotId, globalMetaId };
  };

  const writePin = async (
    metabotId: number,
    subpath: string,
    payload: Record<string, unknown>,
    origin: string,
  ) =>
    deps.createPin(
      metabotId,
      {
        operation: 'create',
        path: `/protocols/metatask/${subpath}`,
        encryption: '0',
        version: PIN_VERSION,
        contentType: 'application/json',
        payload: JSON.stringify(payload),
      },
      { origin },
    );

  const projectionAfterRefresh = async (rootPinId: string): Promise<MetaTaskTaskProjection | null> => {
    let detail = refresher().detail(rootPinId);
    if (!detail) {
      await refresher().refreshOnce('metatask-tool-miss');
      detail = refresher().detail(rootPinId);
    }
    return detail;
  };

  /**
   * Replay guard: the task must replay and the node must exist before any
   * spend. Status gating is the caller's job — it differs by mode (tree: the
   * node must be open; competitive: claims are intent-only and never gated).
   */
  const guardKnownNode = (
    events: MetaTaskChainEvent[],
    rootPinId: string,
    node: string,
  ): { ok: true; projection: MetaTaskTaskProjection } | { ok: false; reason: string } => {
    let projection: MetaTaskTaskProjection;
    try {
      projection = replayMetaTask(events, {
        rootPinId,
        now: Date.now(),
        rosterPins: rosterPinsFromEvents(events),
      });
    } catch (error) {
      return { ok: false, reason: `replay failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    const nodeState = projection.nodeStates[node];
    if (!nodeState) return { ok: false, reason: `node "${node}" not found in task ${rootPinId}` };
    return { ok: true, projection };
  };

  /**
   * H_ACT3 write-side gate (draft §7): competitive tasks must not be broadcast
   * before the announced activation height. The boundary block is read from
   * the refresher's refresh state (the same source metatask_list reports), the
   * announced height from board.activation.hAct3 (the constants.ts value
   * surfaced by the projection store). allowPreActivation is the explicit
   * pilot/testing escape hatch — replay has no height gate, so an overridden
   * publish replays fine; the refusal only exists to protect the real
   * activation procedure.
   */
  const hAct3GateRefusal = (allowPreActivation: boolean): string | null => {
    if (allowPreActivation) return null;
    const board = refresher().board() as MetaTaskBoard | null;
    const hAct3 = board?.activation?.hAct3 ?? H_ACT3;
    if (hAct3 === null || hAct3 === undefined) {
      return 'Refused: competitive mode is gated on H_ACT3, which has not been announced yet (draft §7 — activation lands only after the three-engine conformance set is green). For pilot/testing publishes pass allowPreActivation: true.';
    }
    const boundaryBlock = board?.refresh?.boundaryBlock;
    if (typeof boundaryBlock !== 'number' || boundaryBlock < 0) {
      return `Refused: competitive mode activates at H_ACT3=${hAct3}, but the local chain boundary block is unknown (no refresh state yet) — run metatask_list refresh=true first, or pass allowPreActivation: true for pilot/testing.`;
    }
    if (boundaryBlock < hAct3) {
      return `Refused: competitive mode activates at H_ACT3=${hAct3}; the local boundary block is ${boundaryBlock}. Pre-activation competitive tasks must not be broadcast (draft §7); for pilot/testing publishes pass allowPreActivation: true.`;
    }
    return null;
  };

  // ── reads ──────────────────────────────────────────────────────────────────

  const listTasks = tool(
    'metatask_list',
    'List on-chain MetaTasks from the local chain-sourced projection: root pinId, title, publisher, verified/total progress, participant count, my roles (publisher / participant), and my stats (claims/submissions/reviews, settled shareBP, estShareBP = my mid-task "if it settled now" share in whole-task basis points), plus the boundary block. Pass refresh=true to force a chain sweep first (default reads the cache). On-chain indexing lags — the boundary block is the truth anchor, never assume real-time.',
    {
      refresh: z.boolean().optional().describe('Force a background chain sweep before reading (slower, fresher).'),
    },
    async (args: { refresh?: boolean }) => {
      try {
        if (args.refresh) {
          const result = await refresher().refreshOnce('metatask_list');
          if (!result.ok) return textResult(`Refresh failed (showing cached projection): ${result.error}`);
        }
        const board = refresher().board();
        return jsonResult({
          boundaryBlock: board.refresh.boundaryBlock,
          lastRefreshAtMs: board.refresh.lastRefreshAtMs,
          alerts: board.alerts.length,
          tasks: board.tasks.map((task) => ({
            rootPinId: task.rootPinId,
            title: task.title,
            publisher: task.publisher,
            progress: task.progress,
            participants: task.participantCount,
            myRoles: task.myRoles,
            // estShareBP = the local roster's mid-task "if it settled now"
            // share (whole-task bp); shareBP is the settled truth once a
            // manifest exists.
            myStats: task.myStats
              ? {
                  claimed: task.myStats.claimed,
                  submitted: task.myStats.submitted,
                  verified: task.myStats.verified,
                  reviewVotes: task.myStats.reviewVotes,
                  shareBP: task.myStats.shareBP,
                  estShareBP: task.myStats.estShareBP,
                }
              : null,
            settlementFinalized: task.settlementFinalized,
            boundaryBlock: task.freshness.boundaryBlock,
          })),
        });
      } catch (error) {
        return textResult(`Failed to list MetaTasks: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const getTask = tool(
    'metatask_get',
    'Get one MetaTask in full from the local projection: policy (TTL/quorum/window/split), every node with status/holder/weight/effective submission and pass votes, the participant roster, and the settlement manifest when finalized. Includes `openNodes` — the nodes currently claimable — plus reviewEligibility notes (same-side targets you must NOT review). While the task is unfinished it also reports `estimation`: the "if it settled now" share split (whole-task basis points per metaId, computed with the settlement formula), which is null once a manifest exists. Read-only.',
    {
      rootPinId: z.string().min(1).describe('Task root pinId (66-char, ends with i0).'),
      refresh: z.boolean().optional(),
    },
    async (args: { rootPinId?: string; refresh?: boolean }) => {
      try {
        if (args.refresh) await refresher().refreshOnce('metatask_get');
        const detail = await projectionAfterRefresh(String(args.rootPinId ?? ''));
        if (!detail) return textResult(`MetaTask root not found: ${args.rootPinId}`, true);
        const roster = new Set(control.localRosterMetaIds().filter(Boolean));
        return jsonResult({
          rootPinId: detail.rootPinId,
          title: detail.title,
          brief: detail.brief,
          publisher: detail.publisher,
          policy: detail.policy,
          amendHead: detail.amendHead,
          taskComplete: detail.taskComplete,
          progress: detail.progress,
          nodes: Object.values(detail.nodeStates).map((node) => ({
            id: node.id,
            title: node.title,
            kind: node.kind,
            weight: node.weight,
            status: node.status,
            disputed: node.disputed,
            holder: node.holder?.claimant ?? null,
            submission: node.submission?.pinId ?? null,
            submitter: node.submission?.submitter ?? null,
            passVotes: node.passVotes,
            failVotes: node.failVotes,
          })),
          openNodes: Object.values(detail.nodeStates)
            .filter((node) => node.status === 'open')
            .map((node) => node.id),
          reviewEligibility: {
            sameSideExcluded: Object.values(detail.nodeStates)
              .filter(
                (node) =>
                  node.submission !== null &&
                  (roster.has(node.submission.submitter) || roster.has(detail.publisher)),
              )
              .map((node) => node.id),
            note: 'same-side targets must not be reviewed by local bots (review independence); the engine also excludes the submitter and the task root author from an effective review (H_ACT2-gated roster filtering included). A task root author is refused its own task writer-side by metatask_claim — protocol §12 item 6 (submitter != task root author).',
          },
          participants: detail.participants,
          settlement: detail.settlement,
          // Mid-task "if it settled now" estimate, from the same formula as the
          // manifest: per-metaId whole-task basis points (sorted desc). Null
          // once a manifest exists — settlement.shares is the truth then.
          estimation: detail.settlement ? null : estimateMetaTaskShares(detail),
          freshness: detail.freshness,
        });
      } catch (error) {
        return textResult(`Failed to read the MetaTask: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const replayTask = tool(
    'metatask_replay',
    'Re-run the local MetaTask replay engine over the cached chain events for one task root and return the derived state table plus the settlement manifest (when finalizable): pure derivation, chain facts in, projection out. Use it to double-check a state before acting, or to compute the would-be settlement split.',
    {
      rootPinId: z.string().min(1),
    },
    async (args: { rootPinId?: string }) => {
      try {
        const events = refresher().loadEvents();
        const projection = replayMetaTask(events, {
          rootPinId: String(args.rootPinId ?? ''),
          now: Date.now(),
          rosterPins: rosterPinsFromEvents(events),
        });
        return jsonResult({
          taskComplete: projection.taskComplete,
          progress: projection.progress,
          nodeStates: Object.fromEntries(
            Object.entries(projection.nodeStates).map(([id, node]) => [
              id,
              { status: node.status, disputed: node.disputed, holder: node.holder?.claimant ?? null, pass: node.passVotes },
            ]),
          ),
          settlement: projection.settlement,
          ignoredEvents: projection.ignoredEvents,
          freshness: projection.freshness,
        });
      } catch (error) {
        return textResult(`Replay failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  // ── participation writes ───────────────────────────────────────────────────

  const claimNode = tool(
    'metatask_claim',
    'Claim an OPEN node of an on-chain MetaTask as this session\'s MetaBot. Runs the replay guard FIRST (claimTTL / review-window expiry included) and refuses without spending when the node is not open — output `claim-rejected:<node>:<state>`. The task root author (publisher) is refused its own task nodes (protocol §12 item 6: submitter != task root author — no self-claim). Before claiming, read the task with metatask_get so you actually intend to do the node\'s work: an effective claim starts a TTL clock and, per protocol, freezing the node against publisher amends. COMPETITIVE MODE (v1.3, policy.mode=competitive): claims are an intent signal only (draft §3.2) — no lock is taken, the guard never refuses because a node already has submissions or satisfied candidates, and the claimPinId is NOT needed by metatask_submit; the result carries intentOnly: true.',
    {
      rootPinId: z.string().min(1).describe('Task root pinId.'),
      node: z.string().min(1).describe('Node id from the task tree (metatask_get).'),
    },
    async (args: { rootPinId?: string; node?: string }) => {
      try {
        const who = identity();
        if ('error' in who) return textResult(who.error, true);
        const rootPinId = String(args.rootPinId ?? '');
        const node = String(args.node ?? '');
        const guard = guardKnownNode(refresher().loadEvents(), rootPinId, node);
        if (guard.ok === false) return textResult(guard.reason, true);
        const competitive = guard.projection.policy.mode === 'competitive';
        const nodeState = guard.projection.nodeStates[node];
        if (!competitive && nodeState?.status !== 'open') {
          return textResult(`claim-rejected:${node}:${nodeState?.status ?? 'unknown'}`, true);
        }
        if (guard.projection.publisher === who.globalMetaId) {
          return textResult(
            'Refused: protocol §12 item 6 (submitter != task root author) — you published this MetaTask, so claiming its nodes would be a self-claim; publisher work does not earn a submitter share. Let another bot claim it.',
            true,
          );
        }
        const result = await writePin(who.metabotId, 'claim', { taskid: rootPinId, node }, 'tool:metatask_claim');
        void refresher().refreshOnce('metatask_claim');
        return jsonResult({
          claimPinId: result.pinId,
          txids: result.txids,
          node,
          taskid: rootPinId,
          ...(competitive ? { intentOnly: true } : {}),
          note: competitive
            ? 'competitive mode: this claim is an INTENT SIGNAL only (draft §3.2) — it takes no lock, expires nothing, and metatask_submit does not reference it. Other bots may submit on the same node; the first fully-verified chain wins.'
            : 'keep the claimPinId — your submission must reference it. Chain indexing lags; the guard result reflects the boundary block.',
        });
      } catch (error) {
        return textResult(`Claim failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const submitWork = tool(
    'metatask_submit',
    'Submit the work certificate for a node. You provide the result OBJECT (without any hash — the tool computes the inner hash sha256(canonJ(result minus hash)) and embeds it, then the outer sha256(canonJ(result)) per the frozen canon). TREE MODE: the node must be claim-held by you (claimPinId required, checked against the effective holder); aggregate nodes require childIds (all children verified, per the aggregation rule). COMPETITIVE MODE (v1.3, policy.mode=competitive): no claim exists — claimPinId is not needed (ignored when passed), and deps are enforced via parentRefs instead: one submission pinId per dep node of this node, each pin an EXISTING submission of this task sitting on THAT dep node (anything else replays as invalid_reference — refused here before any spend; an empty {} counts as omitted on entry nodes). A referenced parent need not be verified yet (draft §3.3 optimistic pipelining): the result then carries optimistic: true with the at-risk parents listed — if a parent never verifies (or is killed), this submission can never become chain-valid. References to DEAD parents (killed by a fail verdict, superseded, or themselves invalid_reference) are refused outright. When the node\'s effective spec declares workspace.type "git" (draft §4.2), result MUST be { type: "git-bundle", commit: <full sha>, baseCommit: <full sha | null for greenfield> } with attachment metafile://<git bundle>. Use supersedePinId to replace YOUR earlier submission (tree: same claim cycle; competitive: your tip on the same node — six-predicate supersede, both ends at/after H_ACT2).',
    {
      rootPinId: z.string().min(1),
      node: z.string().min(1),
      claimPinId: z.string().min(1).optional().describe('Tree mode: REQUIRED — the claim pin returned by metatask_claim. Competitive mode: not needed (no claim locks); ignored when passed.'),
      result: z.record(z.string(), z.unknown()).describe('Result object WITHOUT a hash field; task-specific fields per the node spec.'),
      contentType: z.string().optional().describe('Recorded metadata only (never gates verification). Default application/json;utf-8.'),
      attachment: z.string().optional().describe('Artifact URI: pin:// | metafile:// | metaapp://. git-workspace nodes: metafile:// REQUIRED (draft §4.2).'),
      childIds: z.array(z.string()).optional().describe('Tree mode, aggregate nodes only: verified child submission pinIds (canonical mirror rule). Refused in competitive mode — use parentRefs.'),
      parentRefs: z.record(z.string(), z.string()).optional().describe('Competitive mode only (draft §3.3): depNodeId -> submissionPinId, exactly one existing submission pin per dep of this node. Omit (or {}) on entry nodes.'),
      supersedePinId: z.string().optional().describe('Your earlier submission pinId being replaced (tree: same claim cycle; competitive: your tip on the same node).'),
    },
    async (args: {
      rootPinId?: string;
      node?: string;
      claimPinId?: string;
      result?: Record<string, unknown>;
      contentType?: string;
      attachment?: string;
      childIds?: string[];
      parentRefs?: Record<string, string>;
      supersedePinId?: string;
    }) => {
      try {
        const who = identity();
        if ('error' in who) return textResult(who.error, true);
        const rootPinId = String(args.rootPinId ?? '');
        const node = String(args.node ?? '');
        const detail = await projectionAfterRefresh(rootPinId);
        if (!detail) return textResult(`MetaTask root not found: ${rootPinId}`, true);
        const nodeState = detail.nodeStates[node];
        if (!nodeState) return textResult(`Node "${node}" not found.`, true);
        const competitive = detail.policy.mode === 'competitive';
        // One event-pool snapshot for every check in this call (parentRefs
        // existence, spec workspace, fresh replay) — never mix snapshots.
        const allEvents = refresher().loadEvents();
        const childIds = (args.childIds ?? []).map((id) => String(id));
        let claimPinId = '';
        let parentrefs: Record<string, string> | null = null;
        let optimisticParents: { parent: string; pinId: string; state: string }[] = [];
        let claimPinIdIgnored = false;
        let effectiveProjection = detail;
        if (!competitive) {
          // ── tree mode (v1.2.1 semantics, unchanged) ──
          claimPinId = String(args.claimPinId ?? '');
          if (!nodeState.holder || nodeState.holder.pinId !== claimPinId) {
            return textResult(
              `claim-rejected:${node}:${nodeState.status} — the effective claim is ${nodeState.holder?.pinId ?? 'none'} (yours: ${claimPinId}).`,
              true,
            );
          }
          if (nodeState.holder.claimant !== who.globalMetaId) {
            return textResult('That claim belongs to a different bot.', true);
          }
          if (detail.nodes.length > 0) {
            const treeNode = detail.nodes.find((candidate) => candidate.id === node);
            const isAggregate = treeNode?.kind === 'aggregate';
            if (isAggregate && childIds.length === 0) {
              return textResult('Aggregate nodes require childIds (all children verified).', true);
            }
            if (!isAggregate && childIds.length > 0) {
              return textResult('Leaf nodes must not carry childIds.', true);
            }
          }
        } else {
          // ── competitive mode (v1.3 draft §3.3) ──
          if (detail.publisher === who.globalMetaId) {
            return textResult(
              'Refused: protocol §12 item 6 (submitter != task root author) — you published this MetaTask, so its submissions must come from other bots (publisher work earns no submitter share).',
              true,
            );
          }
          if (childIds.length > 0) {
            return textResult('Refused: childIds are the tree-mode aggregation rule — competitive mode enforces deps via parentRefs instead (draft §3.10).', true);
          }
          claimPinIdIgnored = Boolean(asString(args.claimPinId).trim());
          // Fresh replay over the current event pool, so the parentRefs
          // existence check and the optimistic evaluation read the SAME event
          // set the engine would (a persisted projection could lag the pool).
          const guard = guardKnownNode(allEvents, rootPinId, node);
          if (guard.ok === false) return textResult(guard.reason, true);
          effectiveProjection = guard.projection;
          const treeNode = guard.projection.nodes.find((candidate) => candidate.id === node);
          const deps = (Array.isArray(treeNode?.deps) ? treeNode?.deps : [])?.map((dep) => String(dep)) ?? [];
          const rawRefs = isPlainObject(args.parentRefs) ? args.parentRefs : null;
          const refs: Record<string, string> = {};
          for (const [key, value] of Object.entries(rawRefs ?? {})) refs[key] = asString(value).trim();
          if (deps.length === 0) {
            if (Object.keys(refs).length > 0) {
              return textResult(
                `Refused: node ${node} is an entry node (deps: []) — parentRefs must be omitted (an empty object counts as omitted; any key replays as invalid_reference, draft §3.3).`,
                true,
              );
            }
          } else {
            const missing = deps.filter((dep) => !refs[dep]);
            const extra = Object.keys(refs).filter((key) => !deps.includes(key));
            if (missing.length > 0 || extra.length > 0) {
              return textResult(
                `Refused: parentRefs must name exactly one submission pin per dep of node ${node} (${deps.join(', ')}) — ${[
                  missing.length ? `missing: ${missing.join(', ')}` : '',
                  extra.length ? `extra: ${extra.join(', ')}` : '',
                ]
                  .filter(Boolean)
                  .join('; ')}. Anything else replays as invalid_reference (draft §3.3).`,
                true,
              );
            }
            // Engine parity: each referenced pin must be an EXISTING submission
            // of THIS task sitting on THAT dep node (draft §3.3) — the same
            // check that makes a bad reference invalid_reference on-chain.
            const taskSubmissions = allEvents.filter(
              (event) => event.path === 'submission' && asString(event.body.taskid) === rootPinId,
            );
            for (const dep of deps) {
              const ref = refs[dep];
              if (!ref) {
                return textResult(`Refused: parentRefs.${dep} is empty — one submission pinId per dep (draft §3.3).`, true);
              }
              const target = taskSubmissions.find((event) => event.pinId === ref);
              if (!target) {
                return textResult(
                  `Refused: parentRefs.${dep} = ${ref} is not a submission of this task in the local event pool — it would replay as invalid_reference (draft §3.3). If the parent was just published, refresh first (metatask_list refresh=true).`,
                  true,
                );
              }
              const targetNode = asString(target.body.node);
              if (targetNode !== dep) {
                return textResult(
                  `Refused: parentRefs.${dep} = ${ref} sits on node "${targetNode}", not on dep node "${dep}" — it would replay as invalid_reference (draft §3.3).`,
                  true,
                );
              }
            }
            parentrefs = Object.fromEntries(deps.map((dep) => [dep, refs[dep]]));
            // Optimistic pipelining (draft §3.3): a parent need not be verified
            // YET — allowed, but flagged. A DEAD parent (failed / superseded /
            // itself invalid_reference) can never become chain-valid, so
            // building on it is guaranteed-wasted gas: refused.
            const doomed: string[] = [];
            optimisticParents = [];
            for (const dep of deps) {
              const ref = (parentrefs as Record<string, string>)[dep];
              const candidate = (guard.projection.nodeStates[dep]?.submissions ?? []).find(
                (entry) => entry.pinId === ref,
              );
              if (!candidate) {
                doomed.push(`${dep}:${ref} (itself invalid_reference at replay)`);
              } else if (candidate.failed) {
                doomed.push(`${dep}:${ref} (killed by a counted fail verdict)`);
              } else if (candidate.superseded) {
                doomed.push(`${dep}:${ref} (superseded by its author)`);
              } else if (!candidate.verified) {
                optimisticParents.push({ parent: dep, pinId: ref, state: 'unverified' });
              } else if (!candidate.chainValid) {
                optimisticParents.push({ parent: dep, pinId: ref, state: 'verified_but_ancestor_chain_unverified' });
              }
            }
            if (doomed.length > 0) {
              return textResult(
                `Refused: referenced parent submission(s) can never become chain-valid — ${doomed.join('; ')}. Resubmit against a live parent (draft §3.4).`,
                true,
              );
            }
          }
        }
        // Artifact enforcement (draft §4.2): when the node's EFFECTIVE spec
        // (per-node specid override, else the task root spec) declares
        // workspace.type "git", the submission must be a verifiable git bundle.
        const taskPin = allEvents.find((event) => event.path === 'task' && event.pinId === rootPinId);
        const effectiveSpecid =
          effectiveProjection.nodeStates[node]?.specid ?? asString(taskPin?.body?.specid ?? '');
        const specPin = effectiveSpecid
          ? allEvents.find((event) => event.path === 'spec' && event.pinId === effectiveSpecid)
          : undefined;
        const workspace = specPin?.body?.workspace;
        if (isPlainObject(workspace) && workspace.type === 'git') {
          const resultObject = args.result ?? {};
          if (resultObject.type !== 'git-bundle') {
            return textResult(
              `Refused: node ${node} runs in a git workspace (draft §4.2) — result.type must be "git-bundle" (got ${asString(resultObject.type) || 'missing'}).`,
              true,
            );
          }
          if (!GIT_COMMIT_RE.test(asString(resultObject.commit))) {
            return textResult('Refused: git-bundle result.commit must be the full commit hash (40 hex chars).', true);
          }
          const baseCommit = resultObject.baseCommit;
          if (!(baseCommit === null || GIT_COMMIT_RE.test(asString(baseCommit)))) {
            return textResult('Refused: git-bundle result.baseCommit must be a full commit hash (40 hex chars), or null for a greenfield node (draft §4.4).', true);
          }
          if (!asString(args.attachment).startsWith('metafile://')) {
            return textResult(
              'Refused: a git-workspace submission must attach the git bundle as attachment metafile://<bundle> (draft §4.2) — upload it first (metabot-upload-file / metabot-upload-largefile).',
              true,
            );
          }
        }
        const result = { ...(args.result ?? {}) };
        delete result.hash;
        const inner = innerHash(result);
        result.hash = inner;
        const outer = outerHash(result);
        if (!competitive && childIds.length > 0) {
          result.childids = childIds; // canonical source; top-level mirrors it
        }
        const payload: Record<string, unknown> = {
          taskid: rootPinId,
          node,
          ...(competitive ? {} : { claimid: claimPinId }),
          result,
          hash: outer,
          contentType: args.contentType ?? 'application/json;utf-8',
          attachment: args.attachment ?? null,
          childids: competitive ? [] : childIds,
        };
        if (parentrefs) payload.parentrefs = parentrefs;
        if (args.supersedePinId) payload.supersedeid = String(args.supersedePinId);
        const written = await writePin(who.metabotId, 'submission', payload, 'tool:metatask_submit');
        void refresher().refreshOnce('metatask_submit');
        return jsonResult({
          submissionPinId: written.pinId,
          txids: written.txids,
          innerHash: inner,
          outerHash: outer,
          ...(competitive
            ? {
                mode: 'competitive',
                parentrefs,
                optimistic: optimisticParents.length > 0,
                ...(optimisticParents.length > 0 ? { optimisticParents } : {}),
                ...(claimPinIdIgnored ? { claimPinIdIgnored: true } : {}),
                note:
                  optimisticParents.length > 0
                    ? 'OPTIMISTIC PIPELINE: at least one referenced parent is not yet verified (or its own ancestor chain is unverified) — if a referenced parent never verifies, or is killed by a fail verdict, this submission can NEVER become chain-valid (draft §3.3). Reviewers vote on each candidate independently.'
                    : 'all referenced parents are verified and chain-valid at the local boundary block — reviewers now vote on this submission pinId.',
              }
            : {
                note: 'the review window is now open — independent reviewers vote on this submission pinId.',
              }),
        });
      } catch (error) {
        return textResult(`Submit failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const verifySubmission = tool(
    'metatask_verify',
    'Cast an independent review vote on a submission. WRITE-SIDE GATES (refused before any spend): method must map to an actually-performed spec replay (parse target per its declared bytes, re-run the spec, compare inner+outer hashes); semantic_check is REQUIRED non-empty (ruling #9 — what you checked about meaning, e.g. proposition fidelity); verdict=fail requires failReason (ruling #8). Same-side rule: you must NOT review a submission whose submitter or the task publisher is on the local roster — pick another node. verdict is pass|fail only ("invalid" is replay-derived, never cast).',
    {
      targetPinId: z.string().min(1).describe('Submission pinId being reviewed.'),
      verdict: z.enum(['pass', 'fail']),
      method: z.string().min(1).describe('What you replayed and how it maps to your verdict (e.g. "spec rerun pass; inner+outer hash match").'),
      semanticCheck: z.string().min(1).describe('Ruling #9: the semantic check you performed (never empty — e.g. theorem statement/definitions/direction correspondence).'),
      failReason: z.string().optional().describe('REQUIRED when verdict=fail (ruling #8); cite the challenge pinId when overturning on challenge grounds.'),
      evidence: z.string().optional().describe('Optional supporting evidence (bonus, not a requirement).'),
    },
    async (args: {
      targetPinId?: string;
      verdict?: 'pass' | 'fail';
      method?: string;
      semanticCheck?: string;
      failReason?: string;
      evidence?: string;
    }) => {
      try {
        const who = identity();
        if ('error' in who) return textResult(who.error, true);
        const targetPinId = String(args.targetPinId ?? '');
        const verdict = args.verdict === 'fail' ? 'fail' : 'pass';
        const method = asString(args.method).trim();
        const semanticCheck = asString(args.semanticCheck).trim();
        if (!method) return textResult('Refused: method is empty — a vote must map to an actually-performed replay.', true);
        if (!semanticCheck) return textResult('Refused: semantic_check is empty (ruling #9 — the vote would not be counted).', true);
        if (verdict === 'fail' && !asString(args.failReason).trim()) {
          return textResult('Refused: verdict=fail requires failReason (ruling #8 — without it the vote is treated as invalid).', true);
        }
        // Locate the target across cached events: submitter + root author.
        const events = refresher().loadEvents();
        const target = events.find((event) => event.pinId === targetPinId && event.path === 'submission');
        if (!target) return textResult(`Submission pin not found locally: ${targetPinId} (try metatask_list refresh=true first).`, true);
        const submitter = target.author;
        const taskPin = events.find((event) => event.path === 'task' && event.pinId === asString(target.body.taskid));
        const rootAuthor = taskPin?.author ?? '';
        if (who.globalMetaId === submitter || who.globalMetaId === rootAuthor) {
          return textResult('Refused: reviewer must differ from the submitter and the task root author.', true);
        }
        const roster = new Set(control.localRosterMetaIds().filter(Boolean));
        if (roster.has(submitter) || roster.has(rootAuthor)) {
          return textResult(
            `Refused: same_side_roster — the submitter or publisher is on the local roster, so a local bot's vote is not independent. Review a different node.`,
            true,
          );
        }
        const payload: Record<string, unknown> = {
          targetid: targetPinId,
          verdict,
          method,
          evidence: asString(args.evidence),
          semantic_check: semanticCheck,
        };
        if (verdict === 'fail') payload.failreason = asString(args.failReason).trim();
        const written = await writePin(who.metabotId, 'verify', payload, 'tool:metatask_verify');
        void refresher().refreshOnce('metatask_verify');
        return jsonResult({ verifyPinId: written.pinId, txids: written.txids });
      } catch (error) {
        return textResult(`Verify failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const releaseClaim = tool(
    'metatask_release',
    'Voluntarily release your effective claim on a node (you cannot finish the work; the node reopens for others). The claim pin and node must match the current holder and be yours. Note: v1.2 cancelled the old 24h priority re-claim window — after release anyone may claim; correction of a submitted work uses supersede instead. COMPETITIVE MODE (v1.3): there are no claim locks — release is an on-chain no-op (draft §3.2) and this tool refuses it rather than spending a pin on an ignored signal; corrections use metatask_submit supersedePinId.',
    {
      rootPinId: z.string().min(1),
      node: z.string().min(1),
      claimPinId: z.string().min(1),
    },
    async (args: { rootPinId?: string; node?: string; claimPinId?: string }) => {
      try {
        const who = identity();
        if ('error' in who) return textResult(who.error, true);
        const detail = await projectionAfterRefresh(String(args.rootPinId ?? ''));
        if (!detail) return textResult(`MetaTask root not found: ${args.rootPinId}`, true);
        if (detail.policy.mode === 'competitive') {
          return textResult(
            'Refused: competitive mode has no claim locks — release is accepted on-chain but ignored (draft §3.2), so spending a pin on it buys nothing. To correct your own submission use metatask_submit with supersedePinId; to signal abandonment, simply stop working the node.',
            true,
          );
        }
        const nodeState = detail.nodeStates[String(args.node ?? '')];
        if (!nodeState?.holder || nodeState.holder.pinId !== String(args.claimPinId ?? '')) {
          return textResult('That claim is not the current effective holder of the node.', true);
        }
        if (nodeState.holder.claimant !== who.globalMetaId) {
          return textResult('That claim belongs to a different bot.', true);
        }
        const written = await writePin(
          who.metabotId,
          'release',
          { taskid: String(args.rootPinId ?? ''), node: String(args.node ?? ''), claimid: String(args.claimPinId ?? '') },
          'tool:metatask_release',
        );
        void refresher().refreshOnce('metatask_release');
        return jsonResult({ releasePinId: written.pinId, txids: written.txids });
      } catch (error) {
        return textResult(`Release failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  // ── publisher writes ───────────────────────────────────────────────────────

  const publishTask = tool(
    'metatask_publish',
    'Publish a new on-chain MetaTask as this session\'s MetaBot (you become the task root author = publisher). Publish order is roster-pin (auto, when the local roster has 2+ bots) → tree → spec → task; nothing is spent before every invariant passes: single root, acyclic parents, integer weights 1..10000 summing to EXACTLY 10000 across all nodes, quorum >= 1, TTL/window > 0. RECOMMENDED for campaign launches: pass draftsFile (absolute path to the machine-validated campaign drafts JSON) + taskId instead of re-typing title/nodes/spec/policy by hand, because file mode removes LLM transcription errors on large nested arguments — a real launch failed when a large nested validation block was reproduced by hand, came out mangled, and was misread as a gate disagreement. File mode also substitutes SPEC_PIN:<key> node specid placeholders with the pinIds you pass in specPinByKey (unmapped placeholders are refused). Never mix the two modes: either draftsFile+taskId, or inline arguments. After publishing you MUST post a discovery buzz within 24h (title + the full task-root pinId + #metatask) — use the post_buzz tool. COMPETITIVE MODE (v1.3 draft): set policy.mode="competitive" + policy.finalnode (the designated terminal node). Extra invariants, all checked before the first pin: deps acyclic; EXACTLY ONE deps sink and it IS finalnode; every node reachable from an entry node and able to reach finalnode; every node carries a non-empty rubric at params.rubric (string array, >= 1 non-empty entry). claimTtlHours/verifyWindowHours carry no semantics in competitive mode (draft §3.10) — any provided value is normalized to 0 and reported in the result. Competitive publishes are REFUSED before H_ACT3 activation (draft §7; boundary block from the local refresh state) unless you pass allowPreActivation: true — the pilot/testing escape hatch.',
    {
      title: z.string().min(1).optional(),
      brief: z.string().optional().describe('What the task is about; shown to every participant.'),
      nodes: z.array(
        z.object({
          id: z.string().min(1),
          parent: z.string().nullable().describe('Parent node id; null for the single root.'),
          title: z.string().min(1),
          kind: z.enum(['triage', 'search', 'proof', 'aggregate', 'formalize']),
          specid: z.string().nullable().optional().describe('Per-node verifier override; default inherits the root spec.'),
          params: z.record(z.string(), z.unknown()).optional().describe('Node parameters; competitive mode REQUIRES params.rubric (string array, >= 1 non-empty entry).'),
          deps: z.array(z.string()).optional(),
          weight: z.number().int().min(1).max(10000).describe('Settlement weight in basis points; ALL nodes sum to exactly 10000.'),
        }),
      ).min(1).optional(),
      spec: z.object({
        name: z.string().min(1),
        lang: z.string().min(1),
        entry: z.string().min(1),
        script: z.string().optional().describe('Inline verifier script, or a pin:// | metafile:// reference.'),
        input: z.unknown().optional(),
        output: z.unknown().optional(),
        validation: z.record(z.string(), z.unknown()).optional(),
      }).optional(),
      policy: z.object({
        mode: z.enum(['tree', 'competitive']).optional().describe('v1.3: execution mode; absent = "tree" (byte-identical to v1.2.1). "competitive" requires finalnode and is H_ACT3-gated.'),
        finalnode: z.string().min(1).optional().describe('Competitive mode: the designated terminal node — must be the UNIQUE deps sink. Refused in tree mode.'),
        claimTtlHours: z.number().int().positive().optional().describe('Tree mode: required positive integer. Competitive mode: ignored (normalized to 0).'),
        verifyQuorum: z.number().int().min(1),
        verifyWindowHours: z.number().int().positive().optional().describe('Tree mode: required positive integer. Competitive mode: ignored (normalized to 0).'),
        rewardSat: z.number().int().optional().describe('Stays 0 in v1.2 (escrow excluded).'),
        challengeTtlDays: z.number().int().positive().optional().describe('Default 14.'),
        submitterShareBP: z.number().int().min(6000).max(9000).optional().describe('Default 8000.'),
      }).optional(),
      tags: z.array(z.string()).optional(),
      allowPreActivation: z.boolean().optional().describe('Competitive mode only: publish before H_ACT3 activation (pilot/testing escape hatch, draft §7). Never use for production campaigns.'),
      draftsFile: z.string().min(1).optional().describe('Absolute path to a campaign drafts JSON (top-level specs{} + tasks[]); use with taskId instead of inline arguments.'),
      taskId: z.string().min(1).optional().describe('tasks[] entry id in the draftsFile (its `publish` object and `rootSpec` are used).'),
      specPinByKey: z.record(z.string(), z.string()).optional().describe('File mode only: spec key -> published specPinId, substituting SPEC_PIN:<key> node specid placeholders.'),
    },
    async (args: {
      title?: string;
      brief?: string;
      nodes?: Array<{ id?: string; parent?: string | null; title?: string; kind?: string; specid?: string | null; params?: Record<string, unknown>; deps?: string[]; weight?: number }>;
      spec?: { name?: string; lang?: string; entry?: string; script?: string; input?: unknown; output?: unknown; validation?: Record<string, unknown> };
      policy?: { mode?: string; finalnode?: string; claimTtlHours?: number; verifyQuorum?: number; verifyWindowHours?: number; rewardSat?: number; challengeTtlDays?: number; submitterShareBP?: number };
      tags?: string[];
      allowPreActivation?: boolean;
      draftsFile?: string;
      taskId?: string;
      specPinByKey?: Record<string, string>;
    }) => {
      try {
        const who = identity();
        if ('error' in who) return textResult(who.error, true);

        const draftsFile = asString(args.draftsFile).trim();
        const taskId = asString(args.taskId).trim();
        const fileModeRequested = Boolean(draftsFile || taskId);
        const inlineProvided =
          args.title !== undefined ||
          args.brief !== undefined ||
          args.nodes !== undefined ||
          args.spec !== undefined ||
          args.policy !== undefined ||
          args.tags !== undefined;
        let fileInput: DraftsPublishInput | null = null;
        if (fileModeRequested) {
          if (!draftsFile || !taskId) {
            return textResult(
              'Refused: draftsFile and taskId must be passed together (draftsFile = absolute path to the campaign drafts file, taskId = its tasks[] entry id).',
              true,
            );
          }
          if (inlineProvided) {
            return textResult(
              'Refused: pass either draftsFile+taskId OR inline arguments (title/brief/nodes/spec/policy/tags), not both.',
              true,
            );
          }
          const drafts = readDraftsFile(draftsFile);
          if (typeof drafts === 'string') return textResult(drafts, true);
          const fromFile = taskFromDrafts(drafts, taskId, args.specPinByKey ?? {});
          if (typeof fromFile === 'string') return textResult(fromFile, true);
          fileInput = fromFile;
        } else if (args.specPinByKey !== undefined) {
          return textResult('Refused: specPinByKey only applies in draftsFile mode (pass draftsFile + taskId).', true);
        }

        const title = fileInput ? fileInput.title.trim() : asString(args.title).trim();
        if (!title) return textResult('Refused: title is empty.', true);
        const policy = (fileInput ? fileInput.policy : args.policy ?? {}) as Record<string, unknown>;
        const quorum = Number(policy.verifyQuorum ?? 0);
        if (!Number.isInteger(quorum) || quorum < 1) return textResult('Refused: verifyQuorum must be an integer >= 1.', true);

        // Mode selection (draft §2): absent/"tree" = tree mode (byte-identical
        // pre-v1.3 behavior); "competitive" opts into the v1.3 rules.
        const modeRaw = asString(policy.mode).trim();
        if (modeRaw && modeRaw !== 'tree' && modeRaw !== 'competitive') {
          return textResult(
            `Refused: policy.mode must be "tree" or "competitive" (got "${modeRaw}") — unknown modes replay as tree mode, which is never the intent of passing one.`,
            true,
          );
        }
        const competitive = modeRaw === 'competitive';
        const finalnode = asString(policy.finalnode).trim();
        if (!competitive && finalnode) {
          return textResult('Refused: policy.finalnode only applies to competitive mode (draft §3.1) — drop it or set policy.mode="competitive".', true);
        }
        if (competitive && !finalnode) {
          return textResult('Refused: competitive mode requires policy.finalnode — the designated terminal node, which must be the unique deps sink (draft §3.1).', true);
        }
        if (competitive) {
          const gate = hAct3GateRefusal(args.allowPreActivation === true);
          if (gate) return textResult(gate, true);
        }

        // claim_ttl_hours / verify_window_hours carry no semantics in
        // competitive mode (draft §3.10 — no lock to reclaim, submissions do
        // not expire): any provided value is normalized to 0 and reported,
        // rather than refusing callers that fill the tree-mode schema fields
        // out of habit. The chain ignores them either way.
        const policyWarnings: string[] = [];
        let ttlHours = Number(policy.claimTtlHours ?? 0);
        let windowHours = Number(policy.verifyWindowHours ?? 0);
        if (competitive) {
          if (ttlHours !== 0) {
            policyWarnings.push(`claim_ttl_hours normalized to 0 (provided ${asString(policy.claimTtlHours) || policy.claimTtlHours}; ignored in competitive mode, draft §3.10)`);
            ttlHours = 0;
          }
          if (windowHours !== 0) {
            policyWarnings.push(`verify_window_hours normalized to 0 (provided ${asString(policy.verifyWindowHours) || policy.verifyWindowHours}; ignored in competitive mode, draft §3.10)`);
            windowHours = 0;
          }
        } else {
          if (!Number.isInteger(ttlHours) || ttlHours <= 0) return textResult('Refused: claimTtlHours must be a positive integer.', true);
          if (!Number.isInteger(windowHours) || windowHours <= 0) return textResult('Refused: verifyWindowHours must be a positive integer.', true);
        }

        const rawNodes: Array<Record<string, unknown>> = fileInput
          ? fileInput.nodes
          : ((args.nodes ?? []) as Array<Record<string, unknown>>);
        const nodes = rawNodes.map((raw) => ({
          id: asString(raw.id),
          parent: raw.parent === null || raw.parent === undefined ? null : asString(raw.parent),
          title: asString(raw.title),
          kind: asString(raw.kind, 'proof'),
          specid: raw.specid === undefined || raw.specid === null ? null : asString(raw.specid),
          params: (raw.params && typeof raw.params === 'object' ? raw.params : {}) as Record<string, unknown>,
          deps: (Array.isArray(raw.deps) ? raw.deps : []).map((dep) => String(dep)),
          weight: Number(raw.weight),
        }));
        if (nodes.length === 0) return textResult('Refused: empty node list.', true);
        const ids = new Set(nodes.map((node) => node.id));
        if (ids.size !== nodes.length) return textResult('Refused: duplicate node ids.', true);
        if (nodes.some((node) => !node.id || !node.title)) return textResult('Refused: every node needs id and title.', true);
        const roots = nodes.filter((node) => node.parent === null);
        if (roots.length !== 1) return textResult(`Refused: exactly one root (parent=null) required, found ${roots.length}.`, true);
        const byId = new Map(nodes.map((node) => [node.id, node] as const));
        let totalWeight = 0;
        for (const node of nodes) {
          if (!Number.isInteger(node.weight) || node.weight < 1 || node.weight > 10000) {
            return textResult(`Refused: node ${node.id} weight must be an integer in [1, 10000].`, true);
          }
          totalWeight += node.weight;
          if (node.parent !== null && !byId.has(node.parent)) {
            return textResult(`Refused: node ${node.id} references unknown parent ${node.parent}.`, true);
          }
          for (const dep of node.deps) {
            if (!byId.has(dep)) return textResult(`Refused: node ${node.id} references unknown dep ${dep}.`, true);
          }
        }
        if (totalWeight !== 10000) {
          return textResult(`Refused: node weights must sum to exactly 10000 (got ${totalWeight}).`, true);
        }
        // Acyclicity via parent-chain walk.
        for (const start of nodes) {
          const seen = new Set<string>();
          let cursor: string | null = start.id;
          while (cursor !== null) {
            if (seen.has(cursor)) return textResult('Refused: parent graph is cyclic.', true);
            seen.add(cursor);
            cursor = byId.get(cursor)?.parent ?? null;
          }
        }
        // Competitive publish invariants (draft §3.1/§3.3, authoring list §5):
        // deps DAG with exactly one sink == finalnode, full work-flow
        // reachability, and a non-empty params.rubric per node.
        if (competitive) {
          const graphRefusal = competitiveGraphRefusal(nodes, finalnode);
          if (graphRefusal) return textResult(graphRefusal, true);
          for (const node of nodes) {
            const rubricRefusal = competitiveRubricRefusal(node);
            if (rubricRefusal) return textResult(rubricRefusal, true);
          }
        }
        const spec: SpecPayloadInput = fileInput
          ? fileInput.spec
          : {
              name: args.spec?.name,
              lang: args.spec?.lang,
              entry: args.spec?.entry,
              script: args.spec?.script,
              input: args.spec?.input,
              output: args.spec?.output,
              validation: args.spec?.validation,
            };
        if (!asString(spec.name).trim() || !asString(spec.entry).trim()) {
          return textResult('Refused: a root verifier spec (name + entry) is required — every task needs a machine-checkable spec.', true);
        }

        // roster pin (same-side declaration) when the local roster can cross-review.
        // Flat sibling of the protocol root (the collector sweeps it as the
        // tenth pool); a reference pin, never a replay event.
        const roster = control.localRosterMetaIds().filter(Boolean);
        let rosterid: string | null = null;
        if (roster.length >= 2) {
          const rosterPin = await deps
            .createPin(
              who.metabotId,
              {
                operation: 'create',
                path: METATASK_ROSTER_PATH,
                encryption: '0',
                version: PIN_VERSION,
                contentType: 'application/json',
                // `groups: string[][]` is exactly what the engine's
                // rosterGroupsFor reads (and what the collector round-trips).
                payload: JSON.stringify({ groups: [roster], owner: 'idbots-local-roster', createdAt: Date.now() }),
              },
              { origin: 'tool:metatask_publish' },
            )
            .catch(() => null);
          rosterid = rosterPin?.pinId ?? null;
        }

        const treePayload = {
          root: roots[0].id,
          nodes: nodes.map((node) => ({
            id: node.id,
            parent: node.parent,
            title: node.title,
            kind: node.kind,
            specid: node.specid,
            params: node.params,
            deps: node.deps,
            weight: node.weight,
          })),
        };
        const treePin = await writePin(who.metabotId, 'tree', treePayload, 'tool:metatask_publish');

        const specPin = await writePin(
          who.metabotId,
          'spec',
          buildSpecPayload(spec),
          'tool:metatask_publish',
        );

        const shareBP = Number(policy.submitterShareBP ?? 8000);
        const rawTags = fileInput ? fileInput.tags : args.tags;
        const tags = (Array.isArray(rawTags) ? rawTags : []).map((tag) => String(tag));
        const taskPayload: Record<string, unknown> = {
          title,
          brief: fileInput ? fileInput.brief : asString(args.brief),
          treeid: treePin.pinId,
          specid: specPin.pinId,
          policy: {
            claim_ttl_hours: ttlHours,
            verify_quorum: quorum,
            verify_window_hours: windowHours,
            reward_sat: Number.isInteger(policy.rewardSat) ? Number(policy.rewardSat) : 0,
            challenge_ttl_days: Number.isInteger(policy.challengeTtlDays) ? Number(policy.challengeTtlDays) : 14,
            // Tree mode publishes byte-identically to pre-v1.3: mode/finalnode
            // keys exist only on competitive tasks.
            ...(competitive ? { mode: 'competitive', finalnode } : {}),
            split: { submitterShareBP: shareBP, rosterid },
          },
          tags,
        };
        const taskPin = await writePin(who.metabotId, 'task', taskPayload, 'tool:metatask_publish');

        void refresher().refreshOnce('metatask_publish');
        return jsonResult({
          taskRootPinId: taskPin.pinId,
          treePinId: treePin.pinId,
          specPinId: specPin.pinId,
          rosterPinId: rosterid,
          txids: [...treePin.txids, ...specPin.txids, ...taskPin.txids],
          source: fileInput ? 'draftsFile' : 'inline',
          ...(fileInput ? { taskId: fileInput.taskId } : {}),
          ...(competitive
            ? {
                mode: 'competitive',
                finalnode,
                ...(args.allowPreActivation === true
                  ? { preActivationOverride: true, activationNote: 'published before H_ACT3 via allowPreActivation (pilot/testing escape hatch, draft §7) — replay accepts it, but production campaigns must wait for the announced activation height.' }
                  : {}),
                ...(policyWarnings.length > 0 ? { policyWarnings } : {}),
              }
            : {}),
          reminder: 'Post the discovery buzz within 24h: title + the FULL task root pinId + #metatask tag (use post_buzz).',
        });
      } catch (error) {
        return textResult(`Publish failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const publishSpec = tool(
    'metatask_publish_spec',
    'Publish a STANDALONE verifier spec pin (path /protocols/metatask/spec) as this session\'s MetaBot — for node-level specid overrides that must exist BEFORE their task tree, with no carrier task (the old workaround published a junk single-node task just to harvest its specPinId, littering the MetaTask square with claimable tasks). Exactly one pin is spent. RECOMMENDED for campaign launches: pass draftsFile (absolute path to the machine-validated campaign drafts JSON) + specKey instead of re-typing name/lang/entry/script/input/output/validation by hand, because file mode removes LLM transcription errors on large nested arguments — a real launch failed when a ~90KB nested validation block was reproduced by hand, came out mangled, and was refused by the validation gate. Never mix the two modes: either draftsFile+specKey, or inline arguments. Writer-side gates, all before any spend: name + entry, a script that is inline text or a pin:// | metafile:// reference (protocol §3), and — since this tool cannot read chain height — the v1.2.1 spec.validation block is REQUIRED by default (enforceHAct2Validation defaults to true; the protocol makes it mandatory for specs published at/after H_ACT2=191500, where every current campaign spec runs): all three items null_tolerance (boolean true), enumeration_closure (a `closure` string plus at least one integer self-check count, at any depth in the block) and proposition_fidelity (an INDEPENDENT correspondence artifact referenced as pin:// | metafile:// — a self-attested boolean or a PUBLISH_ARTIFACT_FIRST placeholder is refused). Set enforceHAct2Validation=false ONLY for a pre-H_ACT2 (v1.1-era) spec, where the block did not yet exist. The returned specPinId is what node specid overrides (and a task-root specid) must reference; the local projection refreshes after the write.',
    {
      name: z.string().min(1).optional().describe('Spec name, e.g. witness-extraction-301.'),
      lang: z.string().min(1).optional().describe('Verifier implementation language, e.g. python3, bash.'),
      entry: z.string().min(1).optional().describe('Offline entry point, e.g. spec-witness-extraction.py.'),
      script: z.string().min(1).optional().describe('Inline verifier script text, or a pin:// | metafile:// reference when too long.'),
      input: z.unknown().optional().describe('Input descriptor (string or object); interpreted by the script.'),
      output: z.unknown().optional().describe('Output/verdict contract (string or object): pass | fail | invalid.'),
      validation: z.record(z.string(), z.unknown()).optional().describe('v1.2.1 validation block: null_tolerance, enumeration_closure (closure + integer self-check count), proposition_fidelity (correspondence artifact pin). Required unless enforceHAct2Validation=false.'),
      enforceHAct2Validation: z.boolean().optional().describe('Default true: enforce the v1.2.1 three-item validation block. Set false only for a pre-H_ACT2 (v1.1-era) spec.'),
      draftsFile: z.string().min(1).optional().describe('Absolute path to a campaign drafts JSON (top-level specs{}); use with specKey instead of inline arguments.'),
      specKey: z.string().min(1).optional().describe('Key under the draftsFile specs{} map to publish verbatim.'),
    },
    async (args: {
      name?: string;
      lang?: string;
      entry?: string;
      script?: string;
      input?: unknown;
      output?: unknown;
      validation?: Record<string, unknown>;
      enforceHAct2Validation?: boolean;
      draftsFile?: string;
      specKey?: string;
    }) => {
      try {
        const who = identity();
        if ('error' in who) return textResult(who.error, true);

        const draftsFile = asString(args.draftsFile).trim();
        const specKey = asString(args.specKey).trim();
        const inlineProvided =
          args.name !== undefined ||
          args.lang !== undefined ||
          args.entry !== undefined ||
          args.script !== undefined ||
          args.input !== undefined ||
          args.output !== undefined ||
          args.validation !== undefined;
        let spec: SpecPayloadInput;
        if (draftsFile || specKey) {
          if (!draftsFile || !specKey) {
            return textResult(
              'Refused: draftsFile and specKey must be passed together (draftsFile = absolute path to the campaign drafts file, specKey = key under its specs{} map).',
              true,
            );
          }
          if (inlineProvided) {
            return textResult(
              'Refused: pass either draftsFile+specKey OR inline arguments (name/lang/entry/script/input/output/validation), not both.',
              true,
            );
          }
          const drafts = readDraftsFile(draftsFile);
          if (typeof drafts === 'string') return textResult(drafts, true);
          const fromFile = specFromDrafts(drafts, specKey);
          if (typeof fromFile === 'string') return textResult(fromFile, true);
          spec = fromFile;
        } else {
          spec = {
            name: args.name,
            lang: args.lang,
            entry: args.entry,
            script: args.script,
            input: args.input,
            output: args.output,
            validation: args.validation,
          };
        }

        const name = asString(spec.name).trim();
        const entry = asString(spec.entry).trim();
        if (!name || !entry) {
          return textResult('Refused: a spec needs name + entry (the offline verifier entry point).', true);
        }
        const scriptRefusal = specScriptRefusal(spec.script);
        if (scriptRefusal) return textResult(scriptRefusal, true);
        const rawScript = typeof spec.script === 'string' ? spec.script : '';
        const trimmedScript = rawScript.trim();
        // A pin://|metafile:// reference is normalized; inline script bytes are
        // published verbatim (they are the verifier that reviewers replay).
        const script = SPEC_REF_RE.test(trimmedScript) ? trimmedScript : rawScript;
        // Chains at/after H_ACT2 owe the protocol's validation block; the tool
        // cannot measure height, so it enforces by default and the caller must
        // explicitly declare a pre-H_ACT2 (v1.1-era) spec to opt out.
        if (args.enforceHAct2Validation !== false) {
          const validationRefusal = specValidationRefusal(spec.validation);
          if (validationRefusal) return textResult(validationRefusal, true);
        }
        const written = await writePin(
          who.metabotId,
          'spec',
          buildSpecPayload({
            name,
            lang: spec.lang,
            entry,
            script,
            input: spec.input,
            output: spec.output,
            validation: spec.validation,
          }),
          'tool:metatask_publish_spec',
        );
        void refresher().refreshOnce('metatask_publish_spec');
        return jsonResult({
          specPinId: written.pinId,
          txids: written.txids,
          totalCost: written.totalCost,
          name,
          lang: asString(spec.lang).trim() || 'bash',
          entry,
          hasValidation: isPlainObject(spec.validation),
          source: draftsFile ? 'draftsFile' : 'inline',
          ...(draftsFile ? { specKey } : {}),
          note: 'Standalone spec pin written — no task/tree was spent. Reference this specPinId from any tree node specid override (replace SPEC_PIN:<key> placeholders before publishing the tree) or as a task root specid.',
        });
      } catch (error) {
        return textResult(`Spec publish failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const amendTree = tool(
    'metatask_amend',
    'Amend the task tree as the PUBLISHER only (the task root author). v1.2 minimal amend: ops may touch only nodes that were never effectively claimed (frozen-on-start); the weight invariant (sum=10000) must hold after the fold; the task must not be finalized. bases is filled automatically from the current tree head. COMPETITIVE MODE (v1.3 draft §3.9): the freeze condition is SATISFACTION instead — a node is frozen once it has a chain-valid verified submission (claims carry no freeze semantics); remove_node is rejected when another node lists the target in deps; add_node may introduce deps edges only onto unsatisfied existing nodes and the new node needs a non-empty params.rubric; the fold must preserve deps referential integrity, deps acyclicity and the single-sink rule. The chain replay is authoritative — if this tool accepts but replay rejects, the amend is dead on chain.',
    {
      rootPinId: z.string().min(1),
      ops: z.array(
        z.union([
          z.object({
            op: z.literal('add_node'),
            node: z.object({
              id: z.string().min(1),
              parent: z.string().min(1),
              title: z.string().min(1),
              kind: z.enum(['triage', 'search', 'proof', 'aggregate', 'formalize']),
              specid: z.string().nullable().optional(),
              params: z.record(z.string(), z.unknown()).optional(),
              deps: z.array(z.string()).optional(),
              weight: z.number().int().min(1).max(10000),
            }),
          }),
          z.object({ op: z.literal('remove_node'), node: z.string().min(1) }),
          z.object({ op: z.literal('reweight'), node: z.string().min(1), weight: z.number().int().min(1).max(10000) }),
          z.object({ op: z.literal('retitle'), node: z.string().min(1), title: z.string().min(1) }),
          z.object({ op: z.literal('respec'), node: z.string().min(1), specid: z.string().min(1) }),
        ]),
      ).min(1),
    },
    async (args: { rootPinId?: string; ops?: Array<Record<string, unknown>> }) => {
      try {
        const who = identity();
        if ('error' in who) return textResult(who.error, true);
        const rootPinId = String(args.rootPinId ?? '');
        const detail = await projectionAfterRefresh(rootPinId);
        if (!detail) return textResult(`MetaTask root not found: ${rootPinId}`, true);
        if (detail.publisher !== who.globalMetaId) {
          return textResult('Refused: only the task root author (publisher) may amend.', true);
        }
        if (detail.taskComplete) {
          return textResult('Refused: the task is finalized (root verified) — settlement must never be retroactively recomputable.', true);
        }
        // Writer-side checks. Tree mode (unchanged): conservative — ANY claim
        // ever seen freezes a node. Competitive mode (draft §3.9): the freeze
        // condition is SATISFACTION — a node freezes once it has a chain-valid
        // verified submission at the boundary (status "verified" in the
        // competitive projection), matching the engine's point-in-time rule
        // (a satisfied node is certainly frozen for an amend published now);
        // claims are intent-only there and freeze nothing.
        const competitive = detail.policy.mode === 'competitive';
        const events = refresher().loadEvents();
        const claimedEver = new Set(
          events
            .filter((event) => event.path === 'claim' && asString(event.body.taskid) === rootPinId)
            .map((event) => asString(event.body.node)),
        );
        const satisfiedNow = (nodeId: string): boolean => detail.nodeStates[nodeId]?.status === 'verified';
        const isFrozen = competitive ? satisfiedNow : (nodeId: string): boolean => claimedEver.has(nodeId);
        const frozenMessage = (nodeId: string): string =>
          competitive
            ? `Refused: node ${nodeId} is satisfied (a chain-valid verified submission exists) — frozen against amends (draft §3.9).`
            : `Refused: node ${nodeId} has been claimed before — frozen-on-start (v1.2 minimal amend).`;
        const byId = new Map<
          string,
          { id: string; parent: string | null; title: string; kind: string; specid?: string | null; params?: Record<string, unknown>; deps?: string[]; weight?: number }
        >(
          detail.nodes.map((node) => [node.id, { ...node }]),
        );
        for (const rawOp of args.ops ?? []) {
          const op = asString(rawOp?.op);
          const nodeId = asString(rawOp?.node);
          if (op === 'add_node') {
            const raw = (rawOp?.node && typeof rawOp.node === 'object' ? rawOp.node : null) as Record<string, unknown> | null;
            const id = asString(raw?.id);
            const parent = asString(raw?.parent);
            if (!raw || !id || byId.has(id)) return textResult('Refused: add_node with missing or duplicate id.', true);
            const parentNode = byId.get(parent);
            if (!parentNode) return textResult(`Refused: add_node parent ${parent} not found.`, true);
            if (competitive ? satisfiedNow(parent) : detail.nodeStates[parent]?.status === 'verified' || detail.nodeStates[parent]?.holder) {
              return textResult(
                competitive
                  ? `Refused: parent ${parent} is satisfied — new nodes cannot hang off a frozen node (draft §3.9).`
                  : `Refused: parent ${parent} is claimed or verified.`,
                true,
              );
            }
            const newDeps = (Array.isArray(raw.deps) ? raw.deps : []).map((dep) => String(dep));
            const newParams = (raw.params && typeof raw.params === 'object' ? raw.params : {}) as Record<string, unknown>;
            if (competitive) {
              // §3.9: new deps edges may only land on unfrozen existing nodes.
              for (const dep of newDeps) {
                if (!byId.has(dep)) return textResult(`Refused: add_node ${id} references unknown dep ${dep}.`, true);
                if (satisfiedNow(dep)) {
                  return textResult(`Refused: add_node ${id} may not depend on ${dep} — it is satisfied (frozen), so the edge would bind new work to a sealed result (draft §3.9).`, true);
                }
              }
              // The publish rubric invariant (§3.3) applies to added nodes too.
              const rubricRefusal = competitiveRubricRefusal({ id, params: newParams });
              if (rubricRefusal) return textResult(rubricRefusal, true);
            }
            byId.set(id, {
              id,
              parent,
              title: asString(raw.title),
              kind: asString(raw.kind, 'proof'),
              specid: raw.specid === undefined || raw.specid === null ? null : asString(raw.specid),
              params: newParams,
              deps: newDeps,
              weight: Number(raw.weight),
            } as never);
          } else {
            const target = byId.get(nodeId);
            if (!target) return textResult(`Refused: node ${nodeId} not found.`, true);
            if (isFrozen(nodeId)) {
              return textResult(frozenMessage(nodeId), true);
            }
            if (op === 'remove_node') {
              const stack = [nodeId];
              while (stack.length) {
                const current = stack.pop() as string;
                if (isFrozen(current)) {
                  return textResult(
                    competitive
                      ? `Refused: subtree of ${nodeId} contains a satisfied node (${current}) — frozen (draft §3.9).`
                      : `Refused: subtree of ${nodeId} contains a claimed node.`,
                    true,
                  );
                }
                for (const candidate of byId.values()) {
                  if (candidate.parent === current) stack.push(candidate.id);
                }
              }
              if (competitive) {
                // §3.9: a node referenced by another node's deps cannot be
                // removed (the post-fold deps-integrity check is the backstop).
                const referencing = Array.from(byId.values()).filter(
                  (candidate) => candidate.id !== nodeId && (candidate.deps ?? []).includes(nodeId),
                );
                if (referencing.length > 0) {
                  return textResult(
                    `Refused: node ${nodeId} is listed in deps by ${referencing.map((candidate) => candidate.id).join(', ')} — remove or rewire the dependents first (draft §3.9).`,
                    true,
                  );
                }
              }
              byId.delete(nodeId);
            } else if (op === 'reweight') {
              target.weight = Number(rawOp?.weight);
            } else if (op === 'retitle') {
              target.title = asString(rawOp?.title);
            } else if (op === 'respec') {
              target.specid = asString(rawOp?.specid);
            } else {
              return textResult(`Refused: unknown op "${op}".`, true);
            }
          }
        }
        let totalWeight = 0;
        for (const node of byId.values()) {
          const weight = Number((node as { weight?: unknown }).weight);
          if (!Number.isInteger(weight) || weight < 1 || weight > 10000) {
            return textResult('Refused: every node weight must be an integer in [1, 10000].', true);
          }
          totalWeight += weight;
        }
        if (totalWeight !== 10000) {
          return textResult(`Refused: weights must sum to exactly 10000 after the fold (got ${totalWeight}).`, true);
        }
        if (competitive) {
          // §3.9 fold invariants, writer-side (the engine re-checks them and
          // ignores the whole amend on violation): deps reference live nodes,
          // deps acyclic, exactly one sink. The sink need NOT stay the
          // finalnode — §3.9 preserves only the single-sink rule (an add_node
          // extending ABOVE the finalnode is how the graph grows; terminal
          // resolution then still prefers the named finalnode, draft §3.1).
          const folded = Array.from(byId.values()).map((node) => ({
            id: node.id,
            deps: (node.deps ?? []).map((dep) => String(dep)),
            params: (node.params ?? {}) as Record<string, unknown>,
          }));
          for (const node of folded) {
            for (const dep of node.deps) {
              if (!byId.has(dep)) {
                return textResult(`Refused: after the fold, node ${node.id} references dep ${dep} which no longer exists (draft §3.9 deps integrity).`, true);
              }
            }
          }
          if (!depsGraphAcyclic(folded)) {
            return textResult('Refused: the fold makes the deps graph cyclic (draft §3.9).', true);
          }
          const sinks = depsSinkIds(folded);
          if (sinks.length !== 1) {
            return textResult(`Refused: the fold must preserve exactly ONE deps sink (draft §3.9) — found ${sinks.length} (${[...sinks].sort().join(', ')}).`, true);
          }
        }
        const ops = (args.ops ?? []).map((rawOp) => {
          if (asString(rawOp?.op) === 'add_node') {
            return { op: 'add_node', node: rawOp?.node };
          }
          const mapped: Record<string, unknown> = { op: rawOp?.op, node: rawOp?.node };
          if (rawOp?.weight !== undefined) mapped.weight = rawOp.weight;
          if (rawOp?.title !== undefined) mapped.title = rawOp.title;
          if (rawOp?.specid !== undefined) mapped.specid = rawOp.specid;
          return mapped;
        });
        const written = await writePin(
          who.metabotId,
          'amend',
          { taskid: rootPinId, bases: detail.amendHead, ops },
          'tool:metatask_amend',
        );
        void refresher().refreshOnce('metatask_amend');
        return jsonResult({ amendPinId: written.pinId, bases: detail.amendHead, txids: written.txids });
      } catch (error) {
        return textResult(`Amend failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  return [
    listTasks,
    getTask,
    replayTask,
    claimNode,
    submitWork,
    verifySubmission,
    releaseClaim,
    publishTask,
    publishSpec,
    amendTree,
  ];
}
