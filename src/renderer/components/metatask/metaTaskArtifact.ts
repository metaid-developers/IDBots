import type { MetaTaskSubmissionCandidate } from '../../types/metatask';

/**
 * Artifact extraction helpers for the detail-v2 deliverables section and the
 * candidate drawer. Everything here is a pure READ of the published result
 * payload (chain fact) — the renderer never re-derives replay state, it only
 * reshapes what the submission pin already carries.
 *
 * Known on-chain result shapes (see docs/design/metatask-detail-v2-mock.html):
 * - metafile:   { type:"metafile", artifactPin, members[], releaseSha256?,
 *                 fixFor?, summary? } (+ optionally a metaapp:// field)
 * - git-bundle: { type:"git-bundle", commit, baseCommit, repoHint?, engine,
 *                 summary }
 */

export type ArtifactKind = 'git' | 'metafile' | 'metaapp' | 'other';

export interface CandidateArtifact {
  kind: ArtifactKind;
  /** Raw result.type string as published (for the type label), else null. */
  resultType: string | null;
  /** metafile:// URI exactly as published (full, extension kept), else null. */
  metafileUri: string | null;
  /** Browser view URL of the metafile (scheme + extension dropped), else null. */
  metafileViewUrl: string | null;
  /** metaapp:// URI found among the result's string fields, else null. */
  metaAppUri: string | null;
  /** App id (pinId after the metaapp:// scheme), else null. */
  metaAppId: string | null;
}

const METAWEB_BROWSER_BASE = 'https://openagentinternet.org/browser';

/** A submission pin's public viewer page (any pin kind). */
export const pinViewUrl = (pinId: string): string => `${METAWEB_BROWSER_BASE}/pin/${pinId}`;

/** metafile://<pin>[.ext…][?…][#…] → browser view URL. Pin ids never contain
 * dots, so everything from the FIRST dot on is extension chrome and drops. */
export const metafileViewUrl = (uri: string): string | null => {
  if (!uri.toLowerCase().startsWith('metafile://')) return null;
  const rest = uri.slice('metafile://'.length).trim();
  const base = rest.split(/[?#]/)[0] || '';
  if (!base) return null;
  const pinId = base.split('.')[0] || '';
  return pinId ? `${METAWEB_BROWSER_BASE}/metafile/${pinId}` : null;
};

/** Normalize a published metafile reference (bare pin / pin[.ext…] / full URI)
 * into the canonical metafile:// URI for display + copy. */
const normalizeMetafileUri = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase().startsWith('metafile://')) return trimmed;
  // Bare pin ids with any extension suffix (pin ids themselves are dot-free).
  if (/^[0-9a-zA-Z]+(\.[0-9a-zA-Z]+)*$/.test(trimmed)) return `metafile://${trimmed}`;
  return null;
};

/** First metaapp:// URI among the result payload's string fields. */
const findMetaAppUri = (result: Record<string, unknown> | null): string | null => {
  if (!result) return null;
  for (const value of Object.values(result)) {
    if (typeof value === 'string' && value.trim().toLowerCase().startsWith('metaapp://')) {
      return value.trim();
    }
  }
  return null;
};

/** Extract every artifact handle a candidate carries. */
export const candidateArtifactOf = (
  cand: Pick<MetaTaskSubmissionCandidate, 'result' | 'attachment'>,
): CandidateArtifact => {
  const result = cand.result;
  const resultType = typeof result?.type === 'string' ? result.type : null;

  let metafileUri: string | null = null;
  if (resultType === 'metafile') {
    const pin = typeof result?.artifactPin === 'string' ? result.artifactPin : null;
    if (pin) metafileUri = normalizeMetafileUri(pin);
  }
  if (!metafileUri && typeof result?.uri === 'string') {
    metafileUri = normalizeMetafileUri(result.uri);
  }
  if (!metafileUri && typeof cand.attachment === 'string') {
    metafileUri = normalizeMetafileUri(cand.attachment);
  }

  const metaAppUri = findMetaAppUri(result);
  const metaAppId = metaAppUri
    ? (metaAppUri.slice('metaapp://'.length).split(/[?#]/)[0] || null)
    : null;

  const kind: ArtifactKind =
    resultType === 'git-bundle'
      ? 'git'
      : resultType === 'metafile'
        ? 'metafile'
        : metaAppUri
          ? 'metaapp'
          : 'other';

  return {
    kind,
    resultType,
    metafileUri,
    metafileViewUrl: metafileUri ? metafileViewUrl(metafileUri) : null,
    metaAppUri,
    metaAppId,
  };
};

/** String array fields of a result payload (members lists). */
export const resultMembers = (result: Record<string, unknown> | null): string[] => {
  if (!result || !Array.isArray(result.members)) return [];
  return result.members.filter((m): m is string => typeof m === 'string' && m.trim().length > 0);
};

/** result.summary when present (the human-facing "what is this" text). */
export const resultSummary = (result: Record<string, unknown> | null): string | null => {
  const summary = result?.summary;
  return typeof summary === 'string' && summary.trim() ? summary.trim() : null;
};

/** git-bundle facts (commit / base / repo hint), all optional. */
export const gitFacts = (
  result: Record<string, unknown> | null,
): { commit: string | null; baseCommit: string | null; repoHint: string | null; engine: string | null } => ({
  commit: typeof result?.commit === 'string' ? result.commit : null,
  baseCommit: typeof result?.baseCommit === 'string' ? result.baseCommit : null,
  repoHint: typeof result?.repoHint === 'string' ? result.repoHint : null,
  engine: typeof result?.engine === 'string' ? result.engine : null,
});

/** releaseSha256 on metafile results (falls back to nothing — the candidate's
 * own hash is shown by callers when this is null). */
export const resultSha = (result: Record<string, unknown> | null): string | null => {
  const sha = result?.releaseSha256;
  return typeof sha === 'string' && sha.trim() ? sha.trim() : null;
};

/** b75b02ff…6965a8-style middle ellipsis for long hashes/commits. */
export const shortHash = (value: string): string =>
  value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
