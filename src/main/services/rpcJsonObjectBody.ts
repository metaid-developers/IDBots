/**
 * Shared request-body guard for the local MetaID RPC gateway
 * (`metaidRpcServer.ts`).
 *
 * Every POST route on the gateway reads a JSON object body, but the routes grew
 * up reading it inline: `for await (const chunk of req)` followed by
 * `JSON.parse(body)` and then a property read. `JSON.parse` happily returns the
 * literals `null`, `"text"`, `1` and `true`, and arrays — so a caller that sends
 * `null` reaches a property read that throws *inside the async request
 * handler*: the caller gets no response at all (the request hangs until it times
 * out) and the process logs an unhandled rejection. The newer gateway route
 * modules (`memoryGatewayRoutes.ts`, `chatGatewayRoutes.ts`) already avoid this
 * with a local `parseJsonBody` guard; this module is the same rule, shared, so
 * every route inherits one behaviour instead of re-deriving it:
 *
 *   - an empty body keeps whatever meaning the route already gave it: 400
 *     `Invalid JSON body` where the route wrote a bare `JSON.parse(body)`, or
 *     `{}` where it wrote `JSON.parse(body || '{}')` (see `EmptyBodyPolicy`) —
 *     so this guard changes how a bad body is reported, never what a body
 *     means to a route;
 *   - malformed JSON is a 400 with the historical message `Invalid JSON body`,
 *     so existing callers that match on it keep working;
 *   - JSON that parses but is not an object is a 400 that names the received
 *     JSON type (`received null` / `received array` / ...);
 *   - every 400 also carries a stable machine-readable `error_code` —
 *     `BODY_NOT_JSON` when the body never parsed, `BODY_NOT_OBJECT` when it
 *     parsed to a non-object literal — so callers branch on the code instead
 *     of matching message text;
 *   - a valid object body is handed back verbatim, so the route's own
 *     `JSON.parse(body)` keeps behaving exactly as before.
 *
 * The 400 also carries a `contract` block in the union shape agreed across
 * the gateway's rejection bodies — `{ path, fields, body?, schemaVersion: 1 }`
 * — because the response body is the only place a local RPC caller can learn
 * the field names a route expects. `fields` is always listed (`{}` when the
 * route advertises none); `body` is optional in the shape, because a contract
 * that does not constrain the body type may omit it, though the guard's own
 * rejections always state it.
 */
import type { IncomingMessage, ServerResponse } from 'http';

/** Historical message, kept verbatim for bodies that are not valid JSON. */
export const INVALID_JSON_BODY_MESSAGE = 'Invalid JSON body';

/** Message for valid JSON that is not an object (`null`, array, scalar). */
export const JSON_OBJECT_BODY_REQUIRED_MESSAGE = 'Invalid JSON body: expected a JSON object';

/**
 * Stable machine-readable code for a rejected request body, carried as the
 * top-level `error_code` field of the 400. Exactly two states: `BODY_NOT_JSON`
 * (the body never parsed as JSON, an empty strict body included) and
 * `BODY_NOT_OBJECT` (it parsed to a non-object literal). Message text stays
 * free to change; this code is the contract callers branch on.
 */
export type RpcBodyErrorCode = 'BODY_NOT_JSON' | 'BODY_NOT_OBJECT';

/**
 * What an empty request body means to a route, taken from how that route read
 * its body before this guard existed:
 *
 * - `invalid` (default): the route wrote a bare `JSON.parse(body)`, so an empty
 *   body was a `SyntaxError` — reported as 400 `Invalid JSON body` (or, before
 *   this guard, thrown inside the handler and left unanswered).
 * - `object`: the route wrote `JSON.parse(body || '{}')`, or reads no field at
 *   all, so an empty body legitimately means "no fields supplied".
 */
export type EmptyBodyPolicy = 'invalid' | 'object';

export type RpcJsonBodyOptions = {
  emptyBody?: EmptyBodyPolicy;
};

/**
 * One flat shape rather than a discriminated union: this project compiles the
 * main process without `strictNullChecks`, where narrowing on a boolean
 * literal discriminant does not apply.
 */
export type RpcJsonObjectBodyResult = {
  /** True when the body is a JSON object (an empty body counts as `{}`). */
  ok: boolean;
  /** Body string for the route's own `JSON.parse`; `'{}'` when the body was empty. */
  body: string;
  /** Parsed object; `{}` when `ok` is false. */
  value: Record<string, unknown>;
  /** Fixed 400 message to answer with when `ok` is false; `''` otherwise. */
  error: string;
  /** Machine-readable rejection code when `ok` is false; `''` otherwise. */
  errorCode: RpcBodyErrorCode | '';
};

/**
 * Accepted fields per POST route, used only to document the rejection.
 *
 * This is the shared home for the field contracts the routes advertise: a 400
 * whose body names the accepted field names and units saves the caller a blind
 * retry (the shape introduced for `/api/idbots/wallet/transfer` by the
 * wallet-transfer field-contract change). Routes without an entry are listed
 * with `fields: {}`, so a rejected body is always self-describing.
 */
export const RPC_POST_BODY_CONTRACTS: Record<string, Record<string, string>> = {
  '/api/idbots/resolve-metabot-id': {
    name: 'string (required; MetaBot display name, matched case-insensitively)',
  },
  '/api/idbots/metabot/account-summary': {
    metabot_id: 'positive integer (required; enforced by the account lookup, so a missing id fails there rather than inline)',
  },
  '/api/idbots/address/balance': {
    metabot_id: 'positive integer (optional; required unless `addresses` is given — at least one of the two must be present)',
    addresses: 'object (optional) { mvc?, btc?, doge? } — explicit addresses to query; at least one of `metabot_id` / `addresses` must be present',
  },
  '/api/idbots/wallet/balance': {
    metabot_id: 'positive integer (optional; at least one of metabot_id / metabot_ids / address must be present)',
    metabot_ids: 'positive integer[] (optional; batches the same query)',
    address: 'address string (optional; queried as-is per chain)',
    chain: '"mvc" | "btc" | "doge" (optional; omitted queries all three)',
  },
  '/api/idbots/wallet/transfer/records': {
    limit: 'positive integer (optional; default 50)',
    metabot_id: 'positive integer (optional; filters the audit ledger)',
  },
  '/api/idbots/wallet/btc/sign-message': {
    metabot_id: 'positive integer (required; enforced by the wallet lookup, so a missing id fails there rather than inline)',
    message: 'non-empty string (required)',
    encoding: 'BufferEncoding (optional; passed through to signMessage)',
  },
  '/api/idbots/wallet/mrc20/transfer': {
    metabot_id: 'positive integer (required)',
    mrc20_id: 'string (required)',
    symbol: 'string (required; uppercased before use)',
    to_address: 'recipient address string (required)',
    amount: 'string | number > 0 (required; raw MRC20 units)',
    decimal: 'non-negative integer (required)',
    fee_rate: 'number > 0 in sats per byte (required)',
  },
  '/api/idbots/group-task/list': {
    status: '"planning" | "executing" | "review" | "done" | "cancelled" (optional; omitted lists all)',
  },
  '/api/idbots/group-task/show': {
    task_id: 'positive integer (required)',
    view: '"summary" (default) | "full" (optional)',
    before_id: 'positive integer (optional; pages the transcript backwards)',
    limit: 'integer 1..200 (optional; message page size)',
  },
};

/**
 * Name the JSON value a body parsed to, for the rejection message. Malformed
 * JSON and an empty body are named separately so the caller can tell a typo
 * from a wrong-typed body.
 */
export function describeJsonBodyType(rawBody: string, parsed?: unknown): string {
  if (rawBody.trim() === '') return 'empty';
  if (parsed === null) return 'null';
  if (Array.isArray(parsed)) return 'array';
  if (parsed === undefined) return 'invalid JSON';
  return typeof parsed;
}

/**
 * Parse a gateway POST body into an object.
 *
 * Never throws: the caller gets either the object (plus the body string its own
 * `JSON.parse` expects) or a fixed 400 message.
 */
export function parseRpcJsonObjectBody(
  rawBody: string,
  options: RpcJsonBodyOptions = {},
): RpcJsonObjectBodyResult {
  if (rawBody.trim() === '') {
    if ((options.emptyBody ?? 'invalid') === 'object') {
      return { ok: true, body: '{}', value: {}, error: '', errorCode: '' };
    }
    return { ok: false, body: '', value: {}, error: INVALID_JSON_BODY_MESSAGE, errorCode: 'BODY_NOT_JSON' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, body: '', value: {}, error: INVALID_JSON_BODY_MESSAGE, errorCode: 'BODY_NOT_JSON' };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      body: '',
      value: {},
      error: `${JSON_OBJECT_BODY_REQUIRED_MESSAGE} (received ${describeJsonBodyType(rawBody, parsed)})`,
      errorCode: 'BODY_NOT_OBJECT',
    };
  }

  return { ok: true, body: rawBody, value: parsed as Record<string, unknown>, error: '', errorCode: '' };
}

/**
 * Response body for a rejected request body: fixed error + machine code +
 * route contract.
 *
 * The contract carries the union shape agreed across the gateway's rejection
 * bodies: `{ path, fields, body?, schemaVersion: 1 }`. `fields` is always
 * listed; `schemaVersion: 1` pins the shape for callers; `body` is optional
 * in the shape but the guard's rejections always state it, since they exist
 * precisely because the body was not the required JSON object.
 */
export function buildRpcBodyRejection(
  pathname: string,
  error: string,
  errorCode: RpcBodyErrorCode,
): Record<string, unknown> {
  const fields = RPC_POST_BODY_CONTRACTS[pathname] ?? {};
  return {
    success: false,
    error,
    error_code: errorCode,
    contract: {
      path: pathname,
      fields,
      body: 'JSON object',
      schemaVersion: 1,
    },
  };
}

/** Read the whole request body as text (`''` on an empty stream). */
export async function readRpcRequestBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }
  return body;
}

/**
 * Read a gateway POST body and guarantee it is a JSON object.
 *
 * Returns the body string for the route's own `JSON.parse`, or `null` after
 * having answered 400 itself — so a route can never read a field off a
 * non-object body, and can never leave the caller without a response.
 */
export async function readRpcJsonObjectBody(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  options: RpcJsonBodyOptions = {},
): Promise<string | null> {
  const rawBody = await readRpcRequestBody(req);
  const result = parseRpcJsonObjectBody(rawBody, options);
  if (!result.ok) {
    res.writeHead(400);
    // Every failure path above names its machine state; `''` only occurs on
    // the success path, but the flat result type cannot prove that without
    // strictNullChecks narrowing. The sweep tests pin both codes, so a future
    // failure path that forgets the code turns red here instead of lying.
    res.end(JSON.stringify(buildRpcBodyRejection(pathname, result.error, result.errorCode || 'BODY_NOT_JSON')));
    return null;
  }
  return result.body;
}
