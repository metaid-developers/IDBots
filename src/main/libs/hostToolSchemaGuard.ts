/**
 * Provider-facing schema normalization + last-mile guard for DSH host tools.
 *
 * Why this exists (2026-11-11 incident): one host tool shipped
 * `parameters.type = 'string'` and the provider rejected the ENTIRE request —
 *   400 upstream_bad_request: "tools.77.function.parameters must be a JSON
 *   Schema of type object"
 * — then the session-level route breaker tripped after four such turns. The
 * old normalizer looked like it repaired every non-object schema, but its
 * spread order was `{ type: 'object', properties: {}, ...record }`: a record
 * carrying its own non-object `type` overwrote the coerced `'object'` again,
 * so exactly the schemas it was meant to repair were passed through verbatim.
 *
 * Two layers now live here, both pure and unit-testable:
 *  - normalizeHostToolParameters(): the shared passthrough's conversion
 *    (zod schema / zod raw shape / plain JSON schema / {}).
 *  - guardHostToolSchemas(): an unconditional check at the hand-off boundary
 *    that coerces anything still non-object and NAMES the tools it repaired,
 *    so the next occurrence reports which tool instead of an opaque index.
 */
import { z } from 'zod';

export interface HostToolSchemaCoercion {
  /** Tool name as registered with the runtime. */
  name: string;
  /** Why it was coerced, e.g. "type=string" or "missing type". */
  reason: string;
}

const isZodValue = (value: unknown): boolean =>
  Boolean(value) && typeof value === 'object'
  && (Object.hasOwn(value as object, '_def') || Object.hasOwn(value as object, 'def')
    || typeof (value as any).parse === 'function' || typeof (value as any).safeParse === 'function');

/**
 * Force one plain schema record into a top-level object schema.
 *
 * `record` is spread FIRST and `type`/`properties` are written after it: the
 * reverse order let a record's own `type` win over the coercion.
 * `properties` is preserved when it is already an object (any shape, as-is)
 * and filled with `{}` otherwise; every other key (required,
 * additionalProperties, $defs, description, …) rides the spread untouched.
 */
export const coerceObjectToolSchema = (record: Record<string, unknown>): Record<string, unknown> => ({
  ...record,
  type: 'object',
  properties: record.properties && typeof record.properties === 'object' && !Array.isArray(record.properties)
    ? record.properties
    : {},
});

/**
 * Normalize a tool's `parameters` value into the JSON Schema form providers
 * expect. Handles, in order: absent/non-object → empty object schema; a zod
 * schema → z.toJSONSchema; a zod RAW SHAPE ({key: ZodType}) → z.object() then
 * z.toJSONSchema; an already-object plain schema → returned as-is (same
 * reference); anything else → coerced to object.
 *
 * `onZodConversionError` only exists so the caller keeps its existing WARN
 * log; the fallback itself is the empty object schema.
 */
export function normalizeHostToolParameters(
  parameters: unknown,
  onZodConversionError?: (error: unknown) => void,
): Record<string, unknown> {
  if (!parameters || typeof parameters !== 'object') return { type: 'object', properties: {} };
  try {
    // The SDK's tool() accepts a full zod schema, a zod RAW SHAPE
    // ({key: ZodType} — plain shell with zod values), or plain JSON
    // schema; pi-ai needs the JSON form.
    if (isZodValue(parameters)) {
      return z.toJSONSchema(parameters as any, { target: 'draft-7' }) as Record<string, unknown>;
    }
    const values = Object.values(parameters as Record<string, unknown>);
    if (values.length > 0 && values.some(isZodValue)) {
      return z.toJSONSchema(z.object(parameters as any), { target: 'draft-7' }) as Record<string, unknown>;
    }
    // The SDK's tool() accepts a bare {} (or a shape without top-level type)
    // as "no parameters"; providers require an explicit object schema.
    const record = parameters as Record<string, unknown>;
    if (record.type === 'object') return record;
    return coerceObjectToolSchema(record);
  } catch (error) {
    onZodConversionError?.(error);
    return { type: 'object', properties: {} };
  }
}

export interface HostToolLike {
  name: string;
  parameters?: unknown;
}

/**
 * Unconditional hand-off guard: every tool that leaves the host must carry a
 * top-level object schema. Returns the repaired list plus the names/reasons of
 * everything it had to touch. Idempotent: a second pass over guarded tools
 * reports an empty `coerced` list and returns the same tool objects.
 */
export function guardHostToolSchemas<T extends HostToolLike>(tools: readonly T[]): {
  tools: T[];
  coerced: HostToolSchemaCoercion[];
} {
  const coerced: HostToolSchemaCoercion[] = [];
  const guarded = tools.map((tool) => {
    const parameters = tool.parameters;
    if (parameters && typeof parameters === 'object'
      && (parameters as Record<string, unknown>).type === 'object') {
      return tool;
    }
    const record = parameters && typeof parameters === 'object'
      ? parameters as Record<string, unknown>
      : {};
    const type = record.type;
    const reason = typeof type === 'string' && type.length > 0 ? `type=${type}` : 'missing type';
    coerced.push({ name: tool.name, reason });
    return { ...tool, parameters: coerceObjectToolSchema(record) };
  });
  return { tools: guarded, coerced };
}

/** One-line log fingerprint: which tools were repaired, and why. */
export function formatHostToolSchemaGuardWarning(coerced: readonly HostToolSchemaCoercion[]): string {
  const detail = coerced.map((entry) => `${entry.name} (${entry.reason})`).join(', ');
  return `[tool-schema-guard] coerced ${coerced.length} tool schema(s): ${detail}`;
}
