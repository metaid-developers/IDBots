import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * Data guard: last line of defense against silently starting on a brand-new
 * empty database.
 *
 * Background (2026-11 Windows incident): an agent-driven data-directory
 * migration left the userData junction target without idbots.sqlite; the next
 * launch created a fresh database with zero feedback and the user experienced
 * "all my bots disappeared". Detection deliberately lives OUTSIDE the
 * database: everything inside userData dies with the directory, so a
 * lightweight fingerprint (one JSON per userDataPath, next to the data
 * directory in the appData root) records the last known bot/message counts
 * and is what makes a vanished database noticeable even when the directory
 * itself was swapped out.
 *
 * The guard never blocks startup on its own failures and never deletes
 * anything: detection errors fall through to normal startup (fail-open), and
 * the dialog's "Start with a new database" arm is an explicit user decision.
 * Opt out with IDBOTS_DISABLE_DATA_GUARD=1 (headless test rigs, scripted
 * fresh installs).
 */

export const DATA_GUARD_DIRNAME = 'IDBots-dataguard';

export type DataGuardStats = {
  bots: number;
  messages: number;
};

export type DataGuardFingerprint = {
  version: 1;
  /** ISO timestamp of the last successful snapshot write. */
  updatedAt: string;
  /** Resolved userData path this fingerprint describes. */
  userDataPath: string;
  stats?: DataGuardStats;
};

/**
 * Fingerprints live NEXT TO the data directory (in the appData root), not
 * inside it: a junction swap, a moved data directory, or a migration all
 * leave the fingerprint behind. One hashed file per userDataPath so parallel
 * instances (dev + production, server mode) never clobber each other's
 * snapshot.
 */
export function fingerprintPathFor(appDataPath: string, userDataPath: string): string {
  const key = crypto.createHash('sha1').update(path.resolve(userDataPath)).digest('hex').slice(0, 12);
  return path.join(appDataPath, DATA_GUARD_DIRNAME, `${key}.json`);
}

export function readDataGuardFingerprint(fingerprintPath: string): DataGuardFingerprint | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(fingerprintPath, 'utf8')) as DataGuardFingerprint;
    if (!parsed || parsed.version !== 1 || typeof parsed.userDataPath !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeDataGuardFingerprint(fingerprintPath: string, fingerprint: DataGuardFingerprint): void {
  fs.mkdirSync(path.dirname(fingerprintPath), { recursive: true });
  const tmpPath = `${fingerprintPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(fingerprint, null, 2), 'utf8');
  fs.renameSync(tmpPath, fingerprintPath);
}

const sameDataPath = (a: string, b: string): boolean => {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
};

/**
 * Directories that only exist after REAL prior usage. A bare first boot never
 * has them when the store opens: the renderer (which writes the Chromium
 * profile dirs) and every agent-facing feature directory come up after
 * initStore, while boot-time writes are just logs and GPU caches.
 */
const PRIOR_USAGE_ARTIFACTS = [
  // Chromium profile state written by the renderer from the first UI session
  'Local Storage',
  'Session Storage',
  'IndexedDB',
  'Network',
  // Agent/product feature state
  'dsh-plugins',
  'metaapps',
  'daily-reports',
  'orchestration-workspace',
  'browser-cowork',
  'browser-cache',
  'sandbox',
];

export type MissingDbEvidence = {
  userDataPath: string;
  dbPath: string;
  fingerprint: DataGuardFingerprint | null;
  priorUsageArtifacts: string[];
};

/**
 * Returns evidence when the app is about to open a database that does not
 * exist while the environment shows signs of a previous installation, or
 * null when startup looks like a genuine first run.
 */
export function detectMissingDatabase(options: {
  userDataPath: string;
  dbFilename: string;
  fingerprintPath: string;
}): MissingDbEvidence | null {
  const { userDataPath, dbFilename, fingerprintPath } = options;
  const dbPath = path.join(userDataPath, dbFilename);
  if (fs.existsSync(dbPath)) {
    return null;
  }

  const fingerprint = readDataGuardFingerprint(fingerprintPath);
  const fingerprintMatches = !!fingerprint && sameDataPath(fingerprint.userDataPath, userDataPath);

  let priorUsageArtifacts: string[] = [];
  try {
    const entries = new Set(fs.readdirSync(userDataPath));
    priorUsageArtifacts = PRIOR_USAGE_ARTIFACTS.filter((name) => entries.has(name));
  } catch {
    // Data directory missing entirely: fingerprint evidence still applies.
  }

  if (!fingerprintMatches && priorUsageArtifacts.length === 0) {
    return null;
  }

  return {
    userDataPath,
    dbPath,
    fingerprint: fingerprintMatches ? fingerprint : null,
    priorUsageArtifacts,
  };
}

export function describeMissingDbEvidence(evidence: MissingDbEvidence): string {
  const fingerprint = evidence.fingerprint;
  if (fingerprint?.stats) {
    return `A fingerprint from a previous run was found: last recorded ${fingerprint.updatedAt} with ${fingerprint.stats.bots} bot(s) and ${fingerprint.stats.messages} message(s).`;
  }
  if (fingerprint) {
    return `A fingerprint from a previous run was found (recorded ${fingerprint.updatedAt}).`;
  }
  return `This data directory contains traces of a previous installation: ${evidence.priorUsageArtifacts.join(', ')}.`;
}
