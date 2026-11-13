import fs from 'node:fs';
import path from 'node:path';
import { LIVE_STAGE_PROTOCOL, type LiveStageFamily } from './studioLiveStageModel';

/**
 * Template registry for the Studio Live Stage renderer (Phase 1 of
 * docs/design/studio-live-stage-metaapp-template.md).
 *
 * The built-in package at `public/live-stage/` is the single source of truth
 * for the per-turn renderer and the packaged demo entry. This module resolves
 * and validates that package once per turn (manifest, protocol, scenes, size
 * limits, asset references) and reports a safe fallback instead of ever
 * producing a blank projector. It is a local registry only: no chain access,
 * no remote templates, no silent updates.
 */

export const STUDIO_LIVE_STAGE_OFFICIAL_TEMPLATE_ID = 'studio-live-stage-official';

/** Only major version 1 of the template contract is understood today. */
export const STUDIO_LIVE_STAGE_TEMPLATE_KNOWN_MAJOR = 1;

export const LIVE_STAGE_TEMPLATE_CAPABILITIES = ['stage.applyPatch'] as const;
export type LiveStageTemplateCapability = (typeof LIVE_STAGE_TEMPLATE_CAPABILITIES)[number];

export type LiveStageTemplateSourceKind = 'builtin' | 'official-metaapp' | 'local-fork' | 'imported-metaapp';

export type LiveStageTemplateManifest = {
  templateId: string;
  templateVersion: string;
  stageProtocol: string;
  entry: string;
  render: string;
  scenes: string;
  capabilities: string[];
  offline: boolean;
};

export type LiveStageSceneMotion = {
  durationMs: number;
  easing: string;
  energy: number;
  density: number;
};

export type LiveStageSceneEntry = {
  orb?: { style: number; preset: string };
  composition?: 'presence' | 'gather' | 'topology' | 'converge' | 'ready';
  topology?: { mode: 'presence' | 'structured' };
  motion?: LiveStageSceneMotion;
  reducedMotion?: { behavior: string };
  fallback?: LiveStageFamily;
  note?: string;
};

export type LiveStageScenes = {
  version: number;
  protocol: string;
  palette?: Record<string, string>;
  handoff?: { treatment: string; settleMs: number };
  reducedMotion?: { behavior: string };
  families: Record<LiveStageFamily, LiveStageSceneEntry>;
};

export type StudioLiveStageTemplateDescriptor = {
  templateId: string;
  templateVersion: string;
  stageProtocol: typeof LIVE_STAGE_PROTOCOL;
  sourceKind: LiveStageTemplateSourceKind;
  entry: string;
  renderTemplate: string;
  scenesPath: string;
  assetRoot: string;
  capabilities: LiveStageTemplateCapability[];
  scenes: LiveStageScenes;
};

export type StudioLiveStageTemplateResolution =
  | { status: 'ok'; template: StudioLiveStageTemplateDescriptor }
  | { status: 'fallback'; reason: string };

export type StudioLiveStageTemplateFs = {
  readFile(filePath: string): string;
  exists(filePath: string): boolean;
  fileSize(filePath: string): number;
};

const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_SCENES_BYTES = 64 * 1024;
const MAX_HTML_BYTES = 128 * 1024;

const TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const TEMPLATE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const RELATIVE_PATH_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/;

const LIVE_STAGE_FAMILIES: readonly LiveStageFamily[] = [
  'idle', 'received', 'reasoning', 'speaking', 'local-recall', 'web2-research',
  'metaweb-research', 'making', 'delegation', 'waiting', 'worker-report',
  'verification', 'browser-action', 'owner-needed', 'problem',
  'report-ready', 'complete',
];

const LIVE_STAGE_COMPOSITIONS = new Set(['presence', 'gather', 'topology', 'converge', 'ready']);
const LIVE_STAGE_TOPOLOGY_MODES = new Set(['presence', 'structured']);
const LIVE_STAGE_NODE_KINDS = new Set(['twin', 'source', 'worker', 'evidence', 'owner']);
const LIVE_STAGE_HANDOFF_DIRECTIONS = new Set(['dispatch', 'return']);
const REDUCED_MOTION_BEHAVIORS = new Set(['static-frame']);

/** Placeholder contract `renderLiveStageHtml` depends on; a broken one would blank the projector. */
const RENDER_TEMPLATE_PLACEHOLDERS = [
  '__STAGE_CSS__', '__INITIAL_STATE__', '__FALLBACK_AVATAR_DATA_URI__',
  '__ORB_EFFECT__', '__ORB_RENDERER__', '__STAGE_JS__', '__AVATAR_DATA_URI__',
] as const;

/** Asset files the built-in render path reads next to the render template. */
const RENDER_TEMPLATE_ASSETS = [
  'stage.css', 'liquid-orb-effect.js', 'liquid-orb.js', 'stage.js', 'liquid-orb-LICENSE.txt',
] as const;

const defaultFs: StudioLiveStageTemplateFs = {
  readFile: (filePath) => fs.readFileSync(filePath, 'utf8'),
  exists: (filePath) => fs.existsSync(filePath),
  fileSize: (filePath) => fs.statSync(filePath).size,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reject path traversal, absolute paths, and platform-specific separators. */
function isSafeRelativePath(value: unknown): value is string {
  return typeof value === 'string'
    && RELATIVE_PATH_PATTERN.test(value)
    && !value.includes('..')
    && !value.includes('\\');
}

function validateManifest(raw: string): { manifest: LiveStageTemplateManifest } | { reason: string } {
  if (raw.length > MAX_MANIFEST_BYTES) return { reason: `template.json exceeds ${MAX_MANIFEST_BYTES} bytes` };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { reason: `template.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isPlainObject(value)) return { reason: 'template.json must be a JSON object' };
  const { templateId, templateVersion, stageProtocol, entry, render, scenes, capabilities, offline } = value;
  if (typeof templateId !== 'string' || !TEMPLATE_ID_PATTERN.test(templateId)) return { reason: `invalid templateId: ${JSON.stringify(templateId ?? null)}` };
  if (typeof templateVersion !== 'string' || !TEMPLATE_VERSION_PATTERN.test(templateVersion)) return { reason: `invalid templateVersion: ${JSON.stringify(templateVersion ?? null)}` };
  const major = Number(templateVersion.split('.')[0]);
  if (major !== STUDIO_LIVE_STAGE_TEMPLATE_KNOWN_MAJOR) return { reason: `unsupported template major version ${major} (known: ${STUDIO_LIVE_STAGE_TEMPLATE_KNOWN_MAJOR})` };
  if (stageProtocol !== LIVE_STAGE_PROTOCOL) return { reason: `unsupported stageProtocol: ${JSON.stringify(stageProtocol ?? null)} (expected ${LIVE_STAGE_PROTOCOL})` };
  for (const field of ['entry', 'render', 'scenes'] as const) {
    if (!isSafeRelativePath(value[field])) return { reason: `invalid ${field} path: ${JSON.stringify(value[field] ?? null)}` };
  }
  if (!Array.isArray(capabilities) || capabilities.some((item) => typeof item !== 'string')) return { reason: 'capabilities must be an array of strings' };
  const unknownCapabilities = capabilities.filter((item) => !LIVE_STAGE_TEMPLATE_CAPABILITIES.includes(item as LiveStageTemplateCapability));
  if (unknownCapabilities.length) return { reason: `unknown capabilities: ${unknownCapabilities.join(', ')}` };
  if (offline !== true) return { reason: 'the official template must be offline (offline !== true)' };
  return {
    manifest: {
      templateId, templateVersion, stageProtocol,
      entry: entry as string, render: render as string, scenes: scenes as string,
      capabilities: capabilities as string[],
      offline: true,
    },
  };
}

function validateSceneMotion(value: unknown): string | null {
  if (!isPlainObject(value)) return 'motion must be an object';
  const { durationMs, easing, energy, density } = value;
  if (!Number.isInteger(durationMs) || (durationMs as number) < 0 || (durationMs as number) > 4000) return 'motion.durationMs out of range';
  if (typeof easing !== 'string' || !/^[a-z0-9-]{1,32}$/.test(easing)) return 'invalid motion.easing';
  if (typeof energy !== 'number' || !(energy >= 0 && energy <= 1)) return 'motion.energy out of range';
  if (typeof density !== 'number' || !(density >= 0 && density <= 1)) return 'motion.density out of range';
  if (Object.keys(value).some((key) => !['durationMs', 'easing', 'energy', 'density'].includes(key))) return 'motion carries unknown fields';
  return null;
}

function validateSceneEntry(family: LiveStageFamily, value: unknown): string | null {
  if (!isPlainObject(value)) return `${family}: scene must be an object`;
  const unknown = Object.keys(value).filter((key) => !['orb', 'composition', 'topology', 'motion', 'reducedMotion', 'fallback', 'note'].includes(key));
  if (unknown.length) return `${family}: unknown scene fields ${unknown.join(', ')}`;
  const hasExplicit = value.orb !== undefined || value.composition !== undefined || value.topology !== undefined || value.motion !== undefined;
  if (value.fallback !== undefined) {
    if (hasExplicit) return `${family}: fallback scenes must not restate explicit fields`;
    if (typeof value.fallback !== 'string' || !LIVE_STAGE_FAMILIES.includes(value.fallback as LiveStageFamily)) return `${family}: invalid fallback family`;
    if (value.fallback === family) return `${family}: fallback must not point at itself`;
  } else if (!hasExplicit) {
    return `${family}: scene needs explicit fields or a documented fallback`;
  }
  if (value.orb !== undefined) {
    if (!isPlainObject(value.orb)) return `${family}: orb must be an object`;
    const { style, preset } = value.orb;
    if (!Number.isInteger(style) || (style as number) < 1 || (style as number) > 64) return `${family}: orb.style out of range`;
    if (typeof preset !== 'string' || !/^[a-z0-9-]{1,32}$/.test(preset)) return `${family}: invalid orb.preset`;
    if (Object.keys(value.orb).some((key) => !['style', 'preset'].includes(key))) return `${family}: orb carries unknown fields`;
  }
  if (value.composition !== undefined && (typeof value.composition !== 'string' || !LIVE_STAGE_COMPOSITIONS.has(value.composition))) return `${family}: invalid composition`;
  if (value.topology !== undefined) {
    if (!isPlainObject(value.topology) || !LIVE_STAGE_TOPOLOGY_MODES.has(value.topology.mode as string) || Object.keys(value.topology).length !== 1) return `${family}: invalid topology`;
  }
  if (value.motion !== undefined) {
    const motionIssue = validateSceneMotion(value.motion);
    if (motionIssue) return `${family}: ${motionIssue}`;
  }
  if (value.reducedMotion !== undefined) {
    if (!isPlainObject(value.reducedMotion) || value.reducedMotion.behavior !== 'static-frame' || Object.keys(value.reducedMotion).length !== 1) return `${family}: reducedMotion must be {"behavior":"static-frame"}`;
  }
  if (value.note !== undefined && (typeof value.note !== 'string' || value.note.length > 200)) return `${family}: note must be a string of at most 200 chars`;
  return null;
}

function resolveSceneFallback(scenes: LiveStageScenes, family: LiveStageFamily): string | null {
  const seen = new Set<LiveStageFamily>([family]);
  let current = scenes.families[family];
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || current.fallback === undefined) return null;
    const target = current.fallback;
    if (seen.has(target)) return `${family}: fallback cycle at ${target}`;
    seen.add(target);
    current = scenes.families[target];
  }
  return `${family}: fallback chain deeper than 4`;
}

export function loadLiveStageScenes(raw: string): { scenes: LiveStageScenes } | { reason: string } {
  if (raw.length > MAX_SCENES_BYTES) return { reason: `scenes.json exceeds ${MAX_SCENES_BYTES} bytes` };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { reason: `scenes.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isPlainObject(value)) return { reason: 'scenes.json must be a JSON object' };
  const { version, protocol, families, palette, handoff, reducedMotion } = value;
  if (version !== 1) return { reason: `unsupported scenes version: ${JSON.stringify(version ?? null)}` };
  if (protocol !== LIVE_STAGE_PROTOCOL) return { reason: `unsupported scenes protocol: ${JSON.stringify(protocol ?? null)}` };
  if (!isPlainObject(families)) return { reason: 'scenes.families must be an object' };
  const familyKeys = Object.keys(families);
  for (const key of familyKeys) {
    if (!LIVE_STAGE_FAMILIES.includes(key as LiveStageFamily)) return { reason: `unknown scene family: ${key}` };
  }
  for (const family of LIVE_STAGE_FAMILIES) {
    if (!(family in families)) return { reason: `missing scene family: ${family}` };
    const issue = validateSceneEntry(family, families[family]);
    if (issue) return { reason: issue };
  }
  const parsed: LiveStageScenes = { version: 1, protocol: LIVE_STAGE_PROTOCOL, families: families as LiveStageScenes['families'] };
  for (const family of LIVE_STAGE_FAMILIES) {
    const cycle = resolveSceneFallback(parsed, family);
    if (cycle) return { reason: cycle };
  }
  if (palette !== undefined) {
    if (!isPlainObject(palette) || Object.keys(palette).length > 24) return { reason: 'invalid palette' };
    for (const [key, color] of Object.entries(palette)) {
      if (!/^#[0-9a-fA-F]{3,8}$/.test(String(color))) return { reason: `invalid palette color for ${key}` };
    }
    parsed.palette = palette as Record<string, string>;
  }
  if (handoff !== undefined) {
    if (!isPlainObject(handoff) || typeof handoff.treatment !== 'string' || handoff.treatment.length > 32
      || !Number.isInteger(handoff.settleMs) || (handoff.settleMs as number) < 0 || (handoff.settleMs as number) > 10000
      || Object.keys(handoff).length !== 2) return { reason: 'invalid handoff block' };
    parsed.handoff = handoff as { treatment: string; settleMs: number };
  }
  if (reducedMotion !== undefined) {
    if (!isPlainObject(reducedMotion) || !REDUCED_MOTION_BEHAVIORS.has(reducedMotion.behavior as string) || Object.keys(reducedMotion).length !== 1) return { reason: 'invalid reducedMotion block' };
    parsed.reducedMotion = reducedMotion as { behavior: string };
  }
  return { scenes: parsed };
}

/** Follow a family's fallback chain (official package: always an explicit scene). */
export function resolveLiveStageScene(scenes: LiveStageScenes, family: LiveStageFamily): { scene: LiveStageSceneEntry } | { reason: string } {
  let current = scenes.families[family];
  for (let depth = 0; depth <= 4; depth += 1) {
    if (!current) return { reason: `missing scene family: ${family}` };
    if (current.fallback === undefined) return { scene: current };
    current = scenes.families[current.fallback];
  }
  return { reason: `fallback chain too deep for ${family}` };
}

/**
 * Structural validation for a `LiveStageState`-shaped value. Used for the
 * bundled demo fixtures today, and it is the base checker the untrusted
 * template adapter (Phase 3) will reuse before forwarding any patch.
 */
export function describeLiveStageFixtureIssues(value: unknown): string[] {
  const issues: string[] = [];
  const push = (issue: string) => issues.push(issue);
  if (!isPlainObject(value)) return ['state must be an object'];
  if (value.protocol !== LIVE_STAGE_PROTOCOL) push(`protocol must be ${LIVE_STAGE_PROTOCOL}`);
  for (const field of ['sessionId', 'turnId'] as const) {
    const id = value[field];
    if (typeof id !== 'string' || !id || id.length > 128) push(`${field} must be a non-empty string of at most 128 chars`);
  }
  if (!Number.isInteger(value.revision) || (value.revision as number) < 0) push('revision must be a non-negative integer');
  if (typeof value.enabled !== 'boolean') push('enabled must be a boolean');
  if (typeof value.family !== 'string' || !LIVE_STAGE_FAMILIES.includes(value.family as LiveStageFamily)) push('unknown family');
  if (typeof value.botName !== 'string' || !value.botName || value.botName.length > 80) push('botName must be 1-80 chars');
  if (value.language !== 'zh' && value.language !== 'en') push('language must be zh or en');
  if (typeof value.headline !== 'string' || value.headline.length > 320) push('headline must be a string of at most 320 chars');
  if (typeof value.caption !== 'string' || value.caption.length > 560) push('caption must be a string of at most 560 chars');
  if (typeof value.composition !== 'string' || !LIVE_STAGE_COMPOSITIONS.has(value.composition)) push('invalid composition');
  if (typeof value.motif !== 'string' || value.motif.length > 64) push('motif must be a string of at most 64 chars');
  if (!Array.isArray(value.participants) || value.participants.length > 8
    || value.participants.some((item) => typeof item !== 'string' || !item || item.length > 80)) push('participants must be at most 8 non-empty strings of at most 80 chars');
  const topology = value.topology;
  if (!isPlainObject(topology) || (topology.mode !== 'presence' && topology.mode !== 'structured')) {
    push('invalid topology');
  } else {
    const nodes = topology.nodes;
    if (!Array.isArray(nodes) || nodes.length > 16) push('topology.nodes must be at most 16 nodes');
    else {
      for (const node of nodes) {
        if (!isPlainObject(node) || typeof node.id !== 'string' || !node.id || node.id.length > 64
          || typeof node.label !== 'string' || !node.label || node.label.length > 80
          || !LIVE_STAGE_NODE_KINDS.has(node.kind as string)) {
          push('invalid topology node');
          break;
        }
      }
      const edges = topology.edges;
      if (!Array.isArray(edges) || edges.length > 32) push('topology.edges must be at most 32 edges');
      else {
        const nodeIds = new Set((nodes as Array<{ id: string }>).map((node) => node.id));
        for (const edge of edges) {
          if (!Array.isArray(edge) || edge.length !== 2 || !nodeIds.has(edge[0]) || !nodeIds.has(edge[1])) {
            push('topology edge references unknown nodes');
            break;
          }
        }
      }
    }
  }
  const motion = value.motion;
  if (!isPlainObject(motion) || typeof motion.preset !== 'string' || motion.preset.length > 64
    || !Number.isInteger(motion.seed) || (motion.seed as number) < 0 || (motion.seed as number) > 2 ** 31
    || !Number.isInteger(motion.durationMs) || (motion.durationMs as number) < 0 || (motion.durationMs as number) > 4000
    || typeof motion.easing !== 'string' || motion.easing.length > 32
    || typeof motion.energy !== 'number' || !(motion.energy >= 0 && motion.energy <= 1)
    || typeof motion.density !== 'number' || !(motion.density >= 0 && motion.density <= 1)) push('invalid motion');
  const metrics = value.metrics;
  if (!isPlainObject(metrics) || typeof metrics.directorEnabled !== 'boolean') push('invalid metrics');
  else {
    for (const field of ['directorCalls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'rejectedPatches', 'fallbackCount', 'directorLatencyMs'] as const) {
      if (!Number.isInteger(metrics[field]) || (metrics[field] as number) < 0) push(`metrics.${field} must be a non-negative integer`);
    }
  }
  const handoff = value.handoff;
  if (handoff !== null) {
    if (!isPlainObject(handoff) || !LIVE_STAGE_HANDOFF_DIRECTIONS.has(handoff.direction as string)
      || typeof handoff.eventId !== 'string' || !handoff.eventId || handoff.eventId.length > 128) push('invalid handoff');
  }
  if (!Array.isArray(value.pendingProjectionIds) || value.pendingProjectionIds.length > 32
    || value.pendingProjectionIds.some((id) => typeof id !== 'string' || !id || id.length > 128)) push('pendingProjectionIds must be at most 32 non-empty strings');
  if (!Array.isArray(value.eventWindow) || value.eventWindow.length > 8) push('eventWindow must hold at most 8 entries');
  else {
    for (const entry of value.eventWindow) {
      if (!isPlainObject(entry) || typeof entry.family !== 'string' || !LIVE_STAGE_FAMILIES.includes(entry.family as LiveStageFamily)
        || (entry.tool !== undefined && (typeof entry.tool !== 'string' || entry.tool.length > 80))
        || (entry.outcome !== undefined && entry.outcome !== 'ok' && entry.outcome !== 'error')) {
        push('invalid eventWindow entry');
        break;
      }
    }
  }
  return issues;
}

/**
 * Resolve and validate the built-in template package. Returns a fallback
 * resolution (never throws) so the caller can keep rendering with the raw
 * built-in assets instead of producing a blank projector.
 */
export function resolveStudioLiveStageTemplate(input: { assetRoot: string; fs?: Partial<StudioLiveStageTemplateFs> }): StudioLiveStageTemplateResolution {
  const io: StudioLiveStageTemplateFs = { ...defaultFs, ...input.fs };
  const root = input.assetRoot;
  const resolve = (relative: string): string => path.join(root, relative);
  try {
    const manifestPath = resolve('template.json');
    if (!io.exists(manifestPath)) return { status: 'fallback', reason: 'template.json is missing' };
    const manifest = validateManifest(io.readFile(manifestPath));
    if ('reason' in manifest) return { status: 'fallback', reason: manifest.reason };
    const { entry, render, scenes: scenesPath } = manifest.manifest;
    for (const [label, relative, maxBytes] of [
      ['entry', entry, MAX_HTML_BYTES],
      ['render template', render, MAX_HTML_BYTES],
      ['scenes', scenesPath, MAX_SCENES_BYTES],
    ] as const) {
      const filePath = resolve(relative);
      if (!io.exists(filePath)) return { status: 'fallback', reason: `${label} ${relative} is missing` };
      if (io.fileSize(filePath) > maxBytes) return { status: 'fallback', reason: `${label} ${relative} exceeds ${maxBytes} bytes` };
    }
    const renderRaw = io.readFile(resolve(render));
    for (const placeholder of RENDER_TEMPLATE_PLACEHOLDERS) {
      if (!renderRaw.includes(placeholder)) return { status: 'fallback', reason: `render template is missing placeholder ${placeholder}` };
    }
    for (const asset of RENDER_TEMPLATE_ASSETS) {
      if (!io.exists(resolve(asset))) return { status: 'fallback', reason: `template asset ${asset} is missing` };
    }
    const scenes = loadLiveStageScenes(io.readFile(resolve(scenesPath)));
    if ('reason' in scenes) return { status: 'fallback', reason: scenes.reason };
    return {
      status: 'ok',
      template: {
        templateId: manifest.manifest.templateId,
        templateVersion: manifest.manifest.templateVersion,
        stageProtocol: LIVE_STAGE_PROTOCOL,
        sourceKind: 'builtin',
        entry,
        renderTemplate: render,
        scenesPath,
        assetRoot: root,
        capabilities: manifest.manifest.capabilities as LiveStageTemplateCapability[],
        scenes: scenes.scenes,
      },
    };
  } catch (error) {
    return { status: 'fallback', reason: error instanceof Error ? error.message : String(error) };
  }
}
