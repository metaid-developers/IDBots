#!/usr/bin/env tsx
/**
 * publish-harness.mts — MetaTask v1.3 pilot publish harness.
 *
 * Bridges the REAL agent-tool logic (src/main/libs/metataskAgentTools.ts,
 * buildMetataskAgentTools) to the metabot CLI chain writer, so the pilot
 * campaign publishes through exactly the code path the in-app tools use —
 * every writer-side gate (competitive graph invariants, rubric presence, spec
 * validation block, workspace shape) runs before any pin is spent.
 *
 * Usage:
 *   pnpm exec tsx scripts/metatask-v13-pilot/publish-harness.mts <specs|task|all> [--broadcast] [--drafts PATH] [--record PATH]
 *
 * Default is DRY-RUN: the full pin plan is computed through the real tools and
 * printed (path, payload sha256, bytes, substitutions) but nothing is written
 * on-chain and launch-record.json is NOT modified. `--broadcast` performs the
 * writes via `metabot chain write --request-file` (Twin Bot actor by default)
 * and records pinIds into launch-record.json.
 *
 * Placeholder resolution (all recorded in launch-record.json once real):
 *   ARTIFACT_PIN:acceptance-sheet  <- artifacts["acceptance-sheet"].uri
 *   BASE_BUNDLE_URI:<key>          <- artifacts[key].uri        (workspace.baseRef + the s2c script constant)
 *   VECTOR_SET_URI                 <- artifacts["vector-set"].uri (script constants)
 *   SPEC_PIN:<key>                 <- specs[key].pinId          (node specid overrides, phase "task")
 * In dry-run, unresolved placeholders are substituted with clearly-labeled
 * synthetic metafile:// URIs so the real tool gates still execute end-to-end.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMetataskAgentTools } from '../../src/main/libs/metataskAgentTools';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DRAFTS = path.join(HERE, 'pilot-task-drafts.json');
const DEFAULT_RECORD = path.join(HERE, 'launch-record.json');
const METABOT = path.join(os.homedir(), '.metabot', 'bin', 'metabot');

const STANDALONE_SPEC_KEYS = [
  's2a-python-engine',
  's2b-go-engine',
  's2c-ts-adapter',
  's3-matrix-check',
  's4-report-structure',
  's5-release-verify',
] as const;
const BASE_BUNDLE_KEYS = ['s2a-python-base', 's2b-go-base', 's2c-ts-harness-base'] as const;
const TASK_ID = 'metatask-v13-pilot';

// ---------------------------------------------------------------------------
// CLI + metabot plumbing
// ---------------------------------------------------------------------------

interface CliArgs {
  phase: 'specs' | 'task' | 'all';
  broadcast: boolean;
  drafts: string;
  record: string;
}

const parseArgs = (argv: string[]): CliArgs => {
  const phase = argv[0];
  if (phase !== 'specs' && phase !== 'task' && phase !== 'all') {
    process.stderr.write('usage: publish-harness.mts <specs|task|all> [--broadcast] [--drafts PATH] [--record PATH]\n');
    process.exit(2);
  }
  const args: CliArgs = { phase, broadcast: false, drafts: DEFAULT_DRAFTS, record: DEFAULT_RECORD };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--broadcast') args.broadcast = true;
    else if (argv[i] === '--drafts') args.drafts = path.resolve(argv[++i]);
    else if (argv[i] === '--record') args.record = path.resolve(argv[++i]);
    else {
      process.stderr.write(`unknown argument: ${argv[i]}\n`);
      process.exit(2);
    }
  }
  return args;
};

/** Run the metabot CLI and parse its JSON stdout (stderr carries node noise). */
const metabotJson = (args: string[]): unknown => {
  const out = execFileSync(METABOT, [...args, '--json'], { encoding: 'utf-8', timeout: 120_000 });
  return JSON.parse(out);
};

const resolveTwinIdentity = (): { slug: string; globalMetaId: string } => {
  const twin = metabotJson(['twin', 'current']) as { data?: { twinSlug?: string } };
  const slug = twin?.data?.twinSlug;
  if (!slug) throw new Error('metabot twin current returned no twinSlug');
  const list = metabotJson(['identity', 'list']) as { data?: { profiles?: Array<{ slug?: string; globalMetaId?: string }> } };
  const profile = (list?.data?.profiles ?? []).find((entry) => entry.slug === slug);
  if (!profile?.globalMetaId) throw new Error(`twin profile ${slug} not found in metabot identity list`);
  return { slug, globalMetaId: profile.globalMetaId };
};

// ---------------------------------------------------------------------------
// Placeholder resolution
// ---------------------------------------------------------------------------

interface LaunchRecord {
  dryRunFree?: boolean;
  artifacts: Record<string, { uri: string; sha256?: string; bytes?: number; uploadedAt?: string }>;
  specs: Record<string, { pinId: string; publishedAt?: string }>;
  task?: { taskRootPinId: string; treePinId: string; specPinId: string; publishedAt?: string };
}

const loadRecord = (recordPath: string): LaunchRecord => {
  if (!fs.existsSync(recordPath)) return { artifacts: {}, specs: {} };
  return JSON.parse(fs.readFileSync(recordPath, 'utf-8')) as LaunchRecord;
};

const SYNTHETIC = (label: string): string =>
  `metafile://dryrun-${label}-${'0'.repeat(24)}i0`;

interface ResolvedDrafts {
  path: string; // temp file with substitutions applied
  substitutions: Array<{ placeholder: string; value: string; synthetic: boolean }>;
}

const resolveDrafts = (draftsPath: string, record: LaunchRecord, _specPins: Record<string, string>): ResolvedDrafts => {
  const parsed = JSON.parse(fs.readFileSync(draftsPath, 'utf-8')) as unknown;
  const substitutions: ResolvedDrafts['substitutions'] = [];
  const fired = new Map<string, { value: string; synthetic: boolean; count: number }>();

  // Per-placeholder resolvers, applied to every DECODED string in the drafts
  // (text surgery on the serialized JSON would miss escaped script bodies).
  const rules: Array<{ placeholder: string; resolve: () => { value: string; synthetic: boolean } }> = [
    {
      placeholder: 'ARTIFACT_PIN:acceptance-sheet',
      resolve: () => ({ value: record.artifacts['acceptance-sheet']?.uri ?? SYNTHETIC('acceptance-sheet'), synthetic: !record.artifacts['acceptance-sheet']?.uri }),
    },
    ...BASE_BUNDLE_KEYS.map((key) => ({
      placeholder: `BASE_BUNDLE_URI:${key}`,
      resolve: () => ({ value: record.artifacts[key]?.uri ?? SYNTHETIC(key), synthetic: !record.artifacts[key]?.uri }),
    })),
  ];
  // The S2 scripts embed the vector-set / base-bundle URIs as readonly
  // constants; replace ONLY the assignment lines (prose mentions stay readable).
  const constantRules: Array<{ placeholder: string; needle: RegExp; resolve: () => { value: string; synthetic: boolean } }> = [
    {
      placeholder: 'VECTOR_SET_URI (script constant)',
      needle: /readonly VECTOR_SET_URI="VECTOR_SET_URI"/g,
      resolve: () => ({ value: record.artifacts['vector-set']?.uri ?? SYNTHETIC('vector-set'), synthetic: !record.artifacts['vector-set']?.uri }),
    },
    {
      placeholder: 'BASE_BUNDLE_URI (s2c script constant)',
      needle: /readonly BASE_BUNDLE_URI="BASE_BUNDLE_URI"/g,
      resolve: () => ({ value: record.artifacts['s2c-ts-harness-base']?.uri ?? SYNTHETIC('s2c-ts-harness-base'), synthetic: !record.artifacts['s2c-ts-harness-base']?.uri }),
    },
  ];

  const substituteString = (input: string): string => {
    let text = input;
    for (const rule of rules) {
      if (!text.includes(rule.placeholder)) continue;
      const { value, synthetic } = rule.resolve();
      const count = text.split(rule.placeholder).length - 1;
      text = text.split(rule.placeholder).join(value);
      const entry = fired.get(rule.placeholder) ?? { value, synthetic, count: 0 };
      entry.count += count;
      fired.set(rule.placeholder, entry);
    }
    for (const rule of constantRules) {
      const matches = text.match(rule.needle);
      if (!matches) continue;
      const { value, synthetic } = rule.resolve();
      text = text.replace(rule.needle, `readonly ${rule.placeholder.includes('VECTOR') ? 'VECTOR_SET_URI' : 'BASE_BUNDLE_URI'}="${value}"`);
      const key = rule.placeholder;
      const entry = fired.get(key) ?? { value, synthetic, count: 0 };
      entry.count += matches.length;
      fired.set(key, entry);
    }
    return text;
  };

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return substituteString(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  const resolved = walk(parsed);
  for (const [placeholder, entry] of fired) {
    substitutions.push({ placeholder, value: `${entry.value} (×${entry.count})`, synthetic: entry.synthetic });
  }

  const resolvedPath = path.join(os.tmpdir(), `metatask-v13-pilot-drafts.resolved.${process.pid}.json`);
  fs.writeFileSync(resolvedPath, JSON.stringify(resolved, null, 2));
  return { path: resolvedPath, substitutions };
};

// ---------------------------------------------------------------------------
// Tool wiring
// ---------------------------------------------------------------------------

interface PlannedPin {
  path: string;
  payloadSha256: string;
  bytes: number;
  origin: string;
}

const buildHarness = (opts: {
  broadcast: boolean;
  twinGlobalMetaId: string;
  planned: PlannedPin[];
}) => {
  const handlers: Record<string, (args: never) => Promise<unknown>> = {};
  let pinCounter = 0;
  const createPin = async (
    _metabotId: number,
    metaidData: { operation: string; path?: string; encryption?: string; version?: string; contentType?: string; payload: string },
    options?: { origin?: string },
  ) => {
    pinCounter += 1;
    const payloadSha256 = createHash('sha256').update(metaidData.payload, 'utf-8').digest('hex');
    const bytes = Buffer.byteLength(metaidData.payload, 'utf-8');
    opts.planned.push({ path: metaidData.path ?? '', payloadSha256, bytes, origin: options?.origin ?? '' });
    if (!opts.broadcast) {
      return { pinId: `dryrun-${String(pinCounter).padStart(4, '0')}-${payloadSha256.slice(0, 12)}i0`, txids: [] as string[], totalCost: 0 };
    }
    // Real write: metabot chain write --request-file (Twin Bot actor by default).
    const request = {
      operation: metaidData.operation,
      path: metaidData.path,
      encryption: metaidData.encryption ?? '0',
      version: metaidData.version ?? '1.1.0',
      contentType: metaidData.contentType ?? 'application/json',
      payload: metaidData.payload,
    };
    const requestFile = path.join(os.tmpdir(), `metatask-v13-pilot-write.${process.pid}.${pinCounter}.json`);
    fs.writeFileSync(requestFile, JSON.stringify(request, null, 2));
    try {
      const out = execFileSync(METABOT, ['chain', 'write', '--request-file', requestFile], {
        encoding: 'utf-8',
        timeout: 300_000,
      });
      const parsed = JSON.parse(out) as { pinId?: string; txids?: string[]; data?: { pinId?: string; txids?: string[] } };
      const data = parsed.data ?? parsed;
      if (!data.pinId) throw new Error(`metabot chain write returned no pinId: ${out.slice(0, 400)}`);
      return { pinId: data.pinId, txids: data.txids ?? [], totalCost: 0 };
    } finally {
      fs.rmSync(requestFile, { force: true });
    }
  };

  const tools = buildMetataskAgentTools({
    tool: (name: string, _description: string, _schema: Record<string, unknown>, handler: never) => {
      handlers[name] = handler;
      return { name };
    },
    control: {
      refresher: () => ({
        board: () => null as never, // empty projection stub: publish guards are drafts-local (see report)
        detail: () => null,
        refreshOnce: async () => ({ ok: true, error: null }),
        loadEvents: () => [],
      }),
      localRosterMetaIds: () => [], // pilot decision: no same-side roster pin
      resolveGlobalMetaId: (metabotId: number) => (metabotId === 1 ? opts.twinGlobalMetaId : null),
    },
    createPin,
    sessionId: 'metatask-v13-pilot-harness',
    resolveMetabotId: () => 1,
  });
  void tools;
  return handlers;
};

// ---------------------------------------------------------------------------
// phases
// ---------------------------------------------------------------------------

const textOf = (result: unknown): string => {
  const content = (result as { content?: Array<{ text?: string }> })?.content;
  return content?.[0]?.text ?? '';
};

const isError = (result: unknown): boolean => Boolean((result as { isError?: boolean })?.isError);

const main = async (): Promise<number> => {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.broadcast ? 'BROADCAST' : 'DRY-RUN';
  console.log(`metatask v1.3 pilot publish harness — ${mode}`);
  console.log(`drafts: ${args.drafts}`);
  console.log(`record: ${args.record}`);

  const twin = resolveTwinIdentity();
  console.log(`identity: twin=${twin.slug} globalMetaId=${twin.globalMetaId}`);

  const record = loadRecord(args.record);
  const planned: PlannedPin[] = [];
  const handlers = buildHarness({ broadcast: args.broadcast, twinGlobalMetaId: twin.globalMetaId, planned });

  const publishSpecs = args.phase === 'specs' || args.phase === 'all';
  const publishTask = args.phase === 'task' || args.phase === 'all';

  // Phase 1: standalone spec pins (six). Their pinIds feed the task phase.
  const specPins: Record<string, string> = {};
  if (publishTask && !publishSpecs) {
    for (const key of STANDALONE_SPEC_KEYS) {
      const known = record.specs[key]?.pinId;
      if (known) specPins[key] = known;
    }
  }

  if (publishSpecs) {
    const resolved = resolveDrafts(args.drafts, record, specPins);
    console.log(`\nsubstitutions (${resolved.substitutions.length} placeholder families):`);
    for (const sub of resolved.substitutions) {
      console.log(`  ${sub.placeholder} -> ${sub.value}${sub.synthetic ? '  [SYNTHETIC dry-run]' : ''}`);
    }
    for (const key of STANDALONE_SPEC_KEYS) {
      const before = planned.length;
      const result = await handlers.metatask_publish_spec({ draftsFile: resolved.path, specKey: key } as never);
      if (isError(result)) {
        console.error(`\nspec ${key} REFUSED: ${textOf(result)}`);
        return 1;
      }
      const out = JSON.parse(textOf(result)) as { specPinId: string };
      specPins[key] = out.specPinId;
      const pin = planned[before];
      console.log(`spec ${key}: pin ${out.specPinId} (${pin.bytes} bytes, sha256 ${pin.payloadSha256.slice(0, 16)}…)`);
      if (args.broadcast) {
        record.specs[key] = { pinId: out.specPinId, publishedAt: new Date().toISOString() };
      }
    }
  }

  // Phase 2: the task (tree → root spec → task), SPEC_PIN:<key> substituted.
  if (publishTask) {
    const missing = STANDALONE_SPEC_KEYS.filter((key) => !specPins[key]);
    if (missing.length > 0 && args.broadcast) {
      console.error(`\ntask phase REFUSED: missing spec pinIds for ${missing.join(', ')} — run the specs phase first (or check launch-record.json).`);
      return 1;
    }
    for (const key of missing) specPins[key] = SYNTHETIC(`specpin-${key}`);
    const resolved = resolveDrafts(args.drafts, record, specPins);
    if (!publishSpecs) {
      console.log(`\nsubstitutions (${resolved.substitutions.length} placeholder families):`);
      for (const sub of resolved.substitutions) {
        console.log(`  ${sub.placeholder} -> ${sub.value}${sub.synthetic ? '  [SYNTHETIC dry-run]' : ''}`);
      }
    }
    const before = planned.length;
    const result = await handlers.metatask_publish({
      draftsFile: resolved.path,
      taskId: TASK_ID,
      specPinByKey: specPins,
      allowPreActivation: true, // draft §7 pilot escape hatch — reported in the tool result
    } as never);
    if (isError(result)) {
      console.error(`\ntask publish REFUSED: ${textOf(result)}`);
      return 1;
    }
    const out = JSON.parse(textOf(result)) as {
      taskRootPinId: string; treePinId: string; specPinId: string; rosterPinId: string | null;
      preActivationOverride?: boolean; policyWarnings?: string[];
    };
    console.log(`task ${TASK_ID}:`);
    console.log(`  taskRootPinId ${out.taskRootPinId}`);
    console.log(`  treePinId     ${out.treePinId}`);
    console.log(`  specPinId     ${out.specPinId} (root spec s1-behavior-spec-lint)`);
    console.log(`  rosterPinId   ${out.rosterPinId ?? 'null (pilot decision: no roster)'}`);
    if (out.preActivationOverride) console.log('  preActivationOverride: true (allowPreActivation, draft §7)');
    for (const warning of out.policyWarnings ?? []) console.log(`  policyWarning: ${warning}`);
    if (args.broadcast) {
      record.task = {
        taskRootPinId: out.taskRootPinId,
        treePinId: out.treePinId,
        specPinId: out.specPinId,
        publishedAt: new Date().toISOString(),
      };
    }
    void before;
  }

  console.log(`\npin plan (${planned.length} pins):`);
  for (const pin of planned) {
    console.log(`  ${pin.path}  ${pin.bytes} bytes  sha256:${pin.payloadSha256.slice(0, 16)}…  origin=${pin.origin}`);
  }
  if (args.broadcast) {
    fs.writeFileSync(args.record, JSON.stringify(record, null, 2) + '\n');
    console.log(`\nlaunch record written: ${args.record}`);
  } else {
    console.log('\ndry-run: no chain writes performed, launch-record.json untouched. Re-run with --broadcast to spend pins.');
  }
  return 0;
};

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`harness failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
