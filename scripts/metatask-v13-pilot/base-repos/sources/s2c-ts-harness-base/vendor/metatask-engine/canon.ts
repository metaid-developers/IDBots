import { createHash } from 'node:crypto';

/**
 * MetaTask canonical JSON + double-hash (protocol v1.2 §10.9 / Appendix A).
 *
 * canonJ must be byte-identical to the Python reference:
 *   json.dumps(o, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
 * JSON.stringify with recursively sorted keys and no whitespace matches for
 * JSON-safe values (numbers as integers, strings, booleans, null, arrays,
 * objects); non-ASCII is emitted raw, exactly like ensure_ascii=False.
 */

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const isPlainObject = (value: Json): value is { [key: string]: Json } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sortDeep = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) as [string, Json][];
    const out: Record<string, Json> = {};
    for (const [key, val] of entries) out[key] = sortDeep(val);
    return out;
  }
  return value;
};

export const canonJ = (obj: unknown): Buffer =>
  Buffer.from(JSON.stringify(sortDeep(obj as Json)), 'utf-8');

export const sha256Hex = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex');

/** Inner hash: sha256 over the result with the top-level "hash" key removed (shallow delete). */
export const innerHash = (result: Record<string, unknown>): string => {
  const core: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result)) {
    if (key === 'hash') continue;
    core[key] = value;
  }
  return sha256Hex(canonJ(core));
};

/** Outer hash: sha256 over the full result (with the inner hash embedded). */
export const outerHash = (result: Record<string, unknown>): string =>
  sha256Hex(canonJ(result));
