/**
 * Gateway argument restrictions — validates invoke args against the R-rules
 * of `02` ("Restrictions Used Below") and returns ARG_RESTRICTED on violation.
 *
 * A rule runs only when the channel's allowlist entry lists it (allowlist.ts
 * `restrictions` array); nothing here applies to channels without the rule.
 *
 * Injected roots (server mode layout, C1):
 *   dataRoot      /data
 *   workspaceRoot /data/workspace
 *   uploadsRoot   /data/workspace/uploads
 *
 * Pure module: node:fs / node:path only, loadable from plain node. The actual
 * store get/set and handler invocation happen in the server layer; this module
 * is the pure validation/transform core it composes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AllowlistEntry } from './allowlist';
import { makeError, type GatewayError } from './protocol';

export interface GatewayPaths {
  dataRoot: string;
  /**
   * Additional roots accepted by R-path confinement. Server mode keeps the
   * single `/data` root; desktop dev mode adds the userData directory, which
   * lives outside the cowork workspace root there.
   */
  dataRoots?: string[];
  workspaceRoot: string;
  uploadsRoot: string;
}

/** All roots R-path confinement accepts (dataRoot plus dataRoots extras). */
export function dataRootList(paths: GatewayPaths): string[] {
  return paths.dataRoots && paths.dataRoots.length > 0
    ? [paths.dataRoot, ...paths.dataRoots.filter((root) => root !== paths.dataRoot)]
    : [paths.dataRoot];
}

// ---------------------------------------------------------------------------
// Path confinement helpers (shared with fileSign.ts)
// ---------------------------------------------------------------------------

/**
 * Resolve a user-supplied path for confinement checks: realpath when the path
 * exists (so symlinks cannot escape the root), otherwise the lexical
 * path.resolve + path.normalize result.
 */
export function resolveConfinementPath(rawPath: string): string {
  const resolved = path.resolve(rawPath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return path.normalize(resolved);
  }
}

/** True when `resolvedPath` equals `root` or lives strictly inside it. */
export function isPathInside(resolvedPath: string, root: string): boolean {
  const normalizedRoot = path.normalize(root);
  const normalizedPath = path.normalize(resolvedPath);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(normalizedRoot + path.sep);
}

/** Canonicalize an injected root the same way (roots exist in practice). */
function canonicalRoot(root: string): string {
  return resolveConfinementPath(root);
}

function looksLikeAbsolutePath(value: string): boolean {
  return path.isAbsolute(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function argRestricted(message: string): GatewayError {
  return makeError('ARG_RESTRICTED', message);
}

// ---------------------------------------------------------------------------
// R-cwd — cwd / workingDirectory must resolve inside workspaceRoot
// ---------------------------------------------------------------------------

const CWD_KEYS = ['cwd', 'workingDirectory'] as const;

function checkCwd(args: unknown[], workspaceRoot: string, channel: string): GatewayError | null {
  const root = canonicalRoot(workspaceRoot);
  for (const [index, arg] of args.entries()) {
    // The first scheduledTask:update argument is an opaque task ID, not a path.
    if (channel === 'scheduledTask:update' && index === 0) continue;
    const candidates: Array<{ raw: unknown; source: string }> = [];
    if (typeof arg === 'string') {
      // A bare positional string on an R-cwd channel is treated as a cwd.
      candidates.push({ raw: arg, source: `arg[${index}]` });
    } else if (isPlainRecord(arg)) {
      // Nested one level inside an object arg (cowork:session:start options,
      // scheduledTask:create/update input, cowork:config:set config).
      for (const key of CWD_KEYS) {
        if (key in arg) candidates.push({ raw: arg[key], source: `arg[${index}].${key}` });
      }
    }
    for (const { raw, source } of candidates) {
      // Missing (or explicitly null/undefined) means the workspace root.
      if (raw === undefined || raw === null) continue;
      if (typeof raw !== 'string') {
        return argRestricted(`${source} must be a string path`);
      }
      // Empty / whitespace-only means the workspace root.
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue;
      const resolved = resolveConfinementPath(trimmed);
      if (!isPathInside(resolved, root)) {
        return argRestricted(`${source} resolves outside the workspace root`);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// R-path / R-upload — absolute-path-looking args must resolve inside the root
// ---------------------------------------------------------------------------

function collectPathStrings(arg: unknown, out: string[]): void {
  if (typeof arg === 'string') {
    out.push(arg);
    return;
  }
  if (Array.isArray(arg)) {
    // e.g. knowledgeBase:importFiles(metabotId, kbId, filePaths: string[]).
    for (const entry of arg) {
      if (typeof entry === 'string') out.push(entry);
    }
    return;
  }
  if (isPlainRecord(arg)) {
    // e.g. fs:readTextFile { filePath }, readLocalImage { path },
    // gateway:file:sign { path, disposition }.
    for (const value of Object.values(arg)) {
      if (typeof value === 'string') out.push(value);
    }
  }
}

function checkFilePaths(args: unknown[], roots: string[]): GatewayError | null {
  const canonicals = roots.map(canonicalRoot);
  for (const [index, arg] of args.entries()) {
    const strings: string[] = [];
    collectPathStrings(arg, strings);
    for (const value of strings) {
      const trimmed = value.trim();
      if (!looksLikeAbsolutePath(trimmed)) continue;
      const resolved = resolveConfinementPath(trimmed);
      if (!canonicals.some((canonical) => isPathInside(resolved, canonical))) {
        return argRestricted(`arg[${index}] path resolves outside the allowed root`);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// R-exec — executionMode may only be 'auto' or 'local'
// ---------------------------------------------------------------------------

function checkExecMode(args: unknown[]): GatewayError | null {
  for (const [index, arg] of args.entries()) {
    if (!isPlainRecord(arg) || !('executionMode' in arg)) continue;
    const mode = arg.executionMode;
    if (mode === 'auto' || mode === 'local') continue;
    return argRestricted(`arg[${index}].executionMode must be 'auto' or 'local'`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// R-cfg — cowork:config:set accepts only the keys listed in `02`
// ---------------------------------------------------------------------------

const CONFIG_SET_ALLOWED_KEYS = new Set([
  'memoryEnabled',
  'memoryImplicitUpdateEnabled',
  'memoryLlmJudgeEnabled',
  'memoryGuardLevel',
  'memoryUserMemoriesMaxItems',
  // The two below are additionally checked under R-cwd / R-exec.
  'workingDirectory',
  'executionMode',
]);

function checkConfigKeys(args: unknown[], paths: GatewayPaths): GatewayError | null {
  for (const arg of args) {
    if (!isPlainRecord(arg)) continue;
    for (const key of Object.keys(arg)) {
      if (!CONFIG_SET_ALLOWED_KEYS.has(key)) {
        return argRestricted(`cowork:config:set key '${key}' is not allowed`);
      }
    }
  }
  const cwdError = checkCwd(args, paths.workspaceRoot, 'cowork:config:set');
  if (cwdError) return cwdError;
  return checkExecMode(args);
}

// ---------------------------------------------------------------------------
// R-store — store:* accepts only key 'app_config'; remove is always rejected
// ---------------------------------------------------------------------------

function checkStore(channel: string, args: unknown[]): GatewayError | null {
  if (channel === 'store:remove') {
    return argRestricted('store:remove is rejected by R-store');
  }
  if (channel === 'store:get' || channel === 'store:set') {
    if (args[0] !== 'app_config') {
      return argRestricted(`${channel} accepts only key 'app_config'`);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Validate invoke args against the restrictions of the channel's allowlist
 * entry. Returns the first ARG_RESTRICTED error, or null when every listed
 * rule passes (including when the entry lists no restrictions).
 */
export function validateInvokeRestrictions(
  channel: string,
  args: unknown[],
  entry: AllowlistEntry,
  paths: GatewayPaths,
): GatewayError | null {
  const restrictions = entry.restrictions ?? [];
  for (const rule of restrictions) {
    switch (rule) {
      case 'R-cwd': {
        const error = checkCwd(args, paths.workspaceRoot, channel);
        if (error) return error;
        break;
      }
      case 'R-path': {
        const error = checkFilePaths(args, dataRootList(paths));
        if (error) return error;
        break;
      }
      case 'R-upload': {
        const error = checkFilePaths(args, [paths.uploadsRoot]);
        if (error) return error;
        break;
      }
      case 'R-exec': {
        const error = checkExecMode(args);
        if (error) return error;
        break;
      }
      case 'R-cfg': {
        const error = checkConfigKeys(args, paths);
        if (error) return error;
        break;
      }
      case 'R-store': {
        const error = checkStore(channel, args);
        if (error) return error;
        break;
      }
      case 'R-size':
        // Marker only: base64 payloads are limited by the 1 MiB inbound frame
        // limit (protocol.ts INBOUND_FRAME_MAX_BYTES); larger files must go
        // through the upload route. Nothing to validate per-invoke here.
        break;
      default: {
        const exhaustive: never = rule;
        void exhaustive;
        break;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// R-store value transforms — pure helpers the server layer composes with the
// actual store get/set (which never leaves the main process).
// ---------------------------------------------------------------------------

const REDACTED = '__redacted__';

/** Deep clone of plain JSON data (objects/arrays/scalars); returns scalars as-is. */
function deepClonePlain(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((entry) => deepClonePlain(entry));
  }
  if (isPlainRecord(node)) {
    const clone: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(node)) {
      clone[key] = deepClonePlain(entry);
    }
    return clone;
  }
  return node;
}

/**
 * Deep-clone `value` with every `providers.*.apiKey` replaced by
 * "__redacted__" — the shape store:get returns over the gateway (`02` R-store:
 * "On `get`, every `providers.*.apiKey` is replaced").
 */
export function redactAppConfig(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactAppConfigNode(entry));
  }
  if (isPlainRecord(value)) {
    const clone: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      clone[key] = key === 'providers' ? redactProvidersMap(entry) : redactAppConfigNode(entry);
    }
    return clone;
  }
  return value;
}

/** Clone a plain JSON subtree, redacting `providers.*.apiKey` along the way. */
function redactAppConfigNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((entry) => redactAppConfigNode(entry));
  }
  if (isPlainRecord(node)) {
    const clone: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(node)) {
      clone[key] = key === 'providers' ? redactProvidersMap(entry) : redactAppConfigNode(entry);
    }
    return clone;
  }
  return node;
}

/** The `providers` map: each entry is one provider record. */
function redactProvidersMap(node: unknown): unknown {
  if (!isPlainRecord(node)) return redactAppConfigNode(node);
  const clone: Record<string, unknown> = {};
  for (const [providerName, providerEntry] of Object.entries(node)) {
    clone[providerName] = redactProviderEntry(providerEntry);
  }
  return clone;
}

/** One provider record: its `apiKey` never leaves the main process. */
function redactProviderEntry(node: unknown): unknown {
  if (!isPlainRecord(node)) return redactAppConfigNode(node);
  const clone: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(node)) {
    clone[key] = key === 'apiKey' ? REDACTED : redactAppConfigNode(entry);
  }
  return clone;
}

const RELAY_PROVIDER_KEYS = new Set(['idbots', 'metaid-free']);
const PROVIDER_API_FORMATS = new Set(['anthropic', 'openai', 'responses']);
const NEW_PROVIDER_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function mergeProviderEntry(key: string, incoming: unknown, stored: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(incoming)) return null;
  if (stored !== undefined && !isPlainRecord(stored)) return null;
  const storedEntry = isPlainRecord(stored) ? stored : null;
  const relayManaged = RELAY_PROVIDER_KEYS.has(key.trim().toLowerCase());
  if (!storedEntry) {
    if (relayManaged || !NEW_PROVIDER_KEY_PATTERN.test(key)) return null;
  }

  const merged = {
    ...(storedEntry ? deepClonePlain(storedEntry) as Record<string, unknown> : {}),
    ...deepClonePlain(incoming) as Record<string, unknown>,
  };
  if (storedEntry) {
    if (relayManaged || incoming.apiKey === undefined || incoming.apiKey === REDACTED) {
      merged.apiKey = storedEntry.apiKey;
    }
    if (relayManaged || incoming.baseUrl === undefined) merged.baseUrl = storedEntry.baseUrl;
    if (relayManaged || incoming.apiFormat === undefined) merged.apiFormat = storedEntry.apiFormat;
  }

  if (merged.apiKey !== undefined && typeof merged.apiKey !== 'string') return null;
  if (typeof merged.baseUrl !== 'string') return null;
  if (merged.apiFormat !== undefined && !PROVIDER_API_FORMATS.has(String(merged.apiFormat))) return null;
  if (merged.enabled !== undefined && typeof merged.enabled !== 'boolean') return null;
  if (merged.models !== undefined && !Array.isArray(merged.models)) return null;
  if (!storedEntry && (!merged.baseUrl.trim() || !PROVIDER_API_FORMATS.has(String(merged.apiFormat)))) return null;
  return merged;
}

/**
 * Merge an incoming `app_config` set (`02` R-store) into the latest stored
 * value. Existing providers may be edited and new user-owned providers may be
 * added, but removal stays rejected. "__redacted__" always preserves the
 * stored credential, and the relay-managed provider's route and credential
 * remain server-owned. Returns null for an invalid shape.
 */
export function mergeAppConfigSet(stored: unknown, incoming: unknown): unknown | null {
  if (!isPlainRecord(incoming)) return null;
  const storedRecord = isPlainRecord(stored) ? stored : {};
  const storedProviders = isPlainRecord(storedRecord.providers) ? storedRecord.providers : null;

  const merged = deepClonePlain(storedRecord) as Record<string, unknown>;
  for (const [key, value] of Object.entries(incoming)) {
    if (key === 'providers') continue;
    merged[key] = deepClonePlain(value);
  }

  if ('providers' in incoming) {
    const incomingProviders = incoming.providers;
    if (!isPlainRecord(incomingProviders)) return null;
    const storedKeys = storedProviders ? Object.keys(storedProviders) : [];
    if (!storedKeys.every((key) => key in incomingProviders)) return null;
    const mergedProviders: Record<string, unknown> = {};
    for (const [key, incomingEntry] of Object.entries(incomingProviders)) {
      const mergedEntry = mergeProviderEntry(key, incomingEntry, storedProviders?.[key]);
      if (mergedEntry === null) return null;
      mergedProviders[key] = mergedEntry;
    }
    merged.providers = mergedProviders;
  } else if (storedProviders) {
    merged.providers = deepClonePlain(storedProviders);
  }
  return merged;
}
