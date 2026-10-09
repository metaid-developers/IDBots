// idbots-tool-result-shaping: bounds tool-result content at commit time.
//
// This replaces the OpenAICompatProxy's per-session tool_result trimming
// (tier-1 compression) for DSH sessions — with an architectural correction:
// DSH deep-freezes loop-built requests and forbids request-time rewrites (the
// request must stay a pure function of the session log), so shaping happens
// where the result is produced, on the tools/post-execute waterfall, before it
// is materialized into the durable log and derived history. The model-visible
// history stays bounded; the session log stays consistent with what the model
// saw.
//
// Policy: a successful result whose rendered text blocks exceed `maxChars`
// total is replaced with head + tail slices joined by an ellipsis marker that
// records the original length. Error results pass through untouched (deny
// reasons are short and must stay verbatim). Registered { global: true }:
// tools/post-execute dispatches through the agent's scope carrier (Phase 0 F5).
//
// JSON-safe path (upstream issue #50 — "Runtime tool-result shaper tears
// oversized JSON tool results", observed on local_workers_list): when the
// over-budget result is exactly ONE text block whose content parses as a JSON
// document, the head+tail slice is replaced by a document-level trim that keeps
// the text valid JSON, so a consumer never reads a torn key, a half element or a
// truncated prefix that still looks like a complete roster:
//   * arrays are trimmed to a PREFIX of WHOLE elements — never half an element;
//   * arrays are drained before strings, and the largest node first, so a whole
//     record is dropped before a field is nibbled;
//   * when no array is worth draining (a single oversized string member, an
//     array of length 1, or an array whose first element alone overflows) the
//     oversized string itself is shortened instead (char prefix);
//   * the marker rides a namespaced key, so it can never overwrite a key the
//     tool wrote itself (a root object already carrying either namespaced key is
//     left to the head+tail path instead of being overwritten);
//   * a document that is over budget only on whitespace is emitted compact —
//     nothing is lost, so there is no truncation to mark.
// Trim plan, cheapest first (a step only runs when the previous one did not
// already produce a document inside the budget):
//   pass 1  one trim: binary-search the node that can absorb the whole overflow
//           (the issue's payloads end here);
//   pass 2  proportional shrink: cut every node worth cutting by one global
//           ratio, binary-searched for the largest ratio that still fits — a
//           per-node walk needs hundreds of re-renders on a result holding many
//           comparable lists, so the ratio search is step-limited by document
//           size instead;
//   pass 3  one node given up entirely (still better than a torn document);
//   pass 4  hand capacity back to the biggest trimmed nodes while the document
//           still fits.
// Every trim keeps whole elements / a char prefix and is listed in the marker.
// When no plan can bring a document inside the budget (a root object of many
// small members, a budget smaller than the marker itself, a document whose
// nodes are all too small to cut) the legacy head+tail path takes over —
// bounded output, but not valid JSON. That is the honest boundary of this fix.
//
// JSON-safe envelope + key names (machine-readable contract):
//   MARKER_KEY   = '__idbots_tool_result_shaping__'
//   ENVELOPE_KEY = '__idbots_tool_result_envelope__'
//   root object -> the marker is a top-level sibling of the tool's own keys:
//     { ...toolKeys, __idbots_tool_result_shaping__: { ...marker } }
//   root array  -> the kept prefix rides the envelope, the marker is its sibling:
//     { __idbots_tool_result_envelope__: [ ...kept elements ],
//       __idbots_tool_result_shaping__: { ...marker } }
//   root scalar -> the same envelope (a JSON string document has nowhere else
//     to carry the marker)
//   marker = { truncated, mode, kind, path, returned, total, originalChars,
//              note, trimCount, trims: [{ path, kind, returned, total }, ...] }
//     mode     'compact' | 'trimmed' | 'envelope' — which path emitted the
//              marker; the compact path (re-serialization that fits the budget)
//              emits truncated=false and no kind/path/returned/total
//     trimCount  how many nodes the plan actually trimmed
//     trims      the first MARKER_MAX_TRIMS of them, biggest first (bounded so
//                the marker cannot outgrow the budget it enforces)
//     kind     'array' | 'string' — the unit `returned` / `total` count
//     path     JSON path of the primary trim, dot/bracket form ($, $[0], $.a.b)
//     returned kept units of the primary trim (whole elements / chars)
//     total    original units of the primary trim (elements / chars)
//     note     trimmed paths always contain the literal 'tool result trimmed';
//              the compact path's note says 'JSON re-serialized (value
//              unchanged, bytes changed)' (H-81 ③)
//   Only stringified JSON is re-serialized, so unchanged members keep their
//   meaning (number spelling may normalize, e.g. 1.0 -> 1, and duplicate source
//   keys collapse to the last one — JSON.parse semantics).
//
// Both paths are bounded: the JSON-safe path keeps marker + document inside
// `maxChars`; the legacy head+tail path keeps its historical byte-for-byte
// shape (its marker is appended after the sliced budget). Nothing else changes:
// non-JSON text, several text blocks, non-accept decisions, error results and
// results already inside the budget all take the legacy path untouched.
//
// Spill cooperation (2026-09-28, cowork session 540635be — upstream dade791b):
// the spill-policy cap sits under this plugin's 20K, so an oversized result took
// the shaping trim FIRST and spill-policy then spilled the ALREADY-TRIMMED text
// into its "Full formatted result stored at:" file — the recovery channel
// silently held a head+tail paste, and a chair that extracted code from it built
// a file with a missing mid-section. Now, when a spillStore service is mounted,
// shaping saves the FULL original through it BEFORE slicing and the marker
// carries the same locator + retrieval hint the spill notice uses; the shaped
// inline is then token-bounded to sit under the spill-policy cap
// (inlineTokenBudget mirrors the policy's maxInlineTokens via
// generate-runtime-config) so the policy's under-cap early-return keeps the
// marker verbatim and its "full result" promise stays true. Without a
// spillStore (no workspace composition) the legacy 20K behavior is kept
// byte-for-byte. Both paths carry the locator when one exists: the JSON-safe
// marker's `note` names the stored original too.

import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate'

export const name = 'idbots-tool-result-shaping'
export const inject = ['tools']

const DEFAULT_MAX_CHARS = 20000
const DEFAULT_TAIL_CHARS = 4000
const MARKER = (original) => `\n[idbots: tool result trimmed, ${original} chars total — head+tail shown]\n`
const SPILL_MARKER = (original, ref) =>
  `\n[idbots: tool result trimmed, ${original} chars total — head+tail shown; full original stored at: ${ref.locator}. ${ref.retrievalHint}]\n`
const DEFAULT_INLINE_TOKEN_BUDGET = 2048
// Headroom inside the inline token budget for framing and estimator drift —
// the shaped copy must price strictly under the spill-policy cap, or the
// policy re-spills the trimmed text as "Full formatted result" and the
// locator ends up pointing at the wrong (trimmed) copy.
const TOKEN_RESERVE = 128

export const MARKER_KEY = '__idbots_tool_result_shaping__'
export const ENVELOPE_KEY = '__idbots_tool_result_envelope__'

// Pass 2 search: one re-render per step, so the step count is scaled down for
// big documents to keep the whole reshape in the low milliseconds.
const RATIO_SEARCH_MAX_STEPS = 24
const RATIO_SEARCH_MIN_STEPS = 6
const RATIO_SEARCH_CHAR_BUDGET = 4 * 1024 * 1024
// A node whose cut would save fewer than this many chars is left alone: a tiny
// field is never emptied for a negligible slice of the overflow, while a result
// built from many medium members can still be shrunk as a whole.
const MIN_SAVING_CHARS = 8
// Pass 4 hands capacity back to at most this many (biggest) trimmed nodes.
const REGROW_MAX_NODES = 8
// The marker lists at most this many trims (biggest first, plan order) and
// always reports the full `trimCount`: a plan touching thousands of nodes must
// not blow the very budget it is enforcing.
const MARKER_MAX_TRIMS = 8

const textLength = (content) => content.reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : 0), 0)
const tokenPrice = (content) => content.reduce((sum, block) => sum + (block.type === 'text' ? estimateContent([block]) : 0), 0)

/** Head+tail render with the original block walk: the char budget is
 *  front-loaded across blocks and the last block keeps a tail slice. */
function renderShaped(content, markerFor, totalChars, tailChars) {
  let remaining = totalChars
  const shaped = []
  for (let i = 0; i < content.length; i++) {
    const block = content[i]
    if (block.type !== 'text') {
      shaped.push(block)
      continue
    }
    const budget = Math.min(block.text.length, remaining)
    if (budget <= 0) break
    const keepTail = i === content.length - 1 ? Math.min(tailChars, Math.floor(budget / 4)) : 0
    const head = block.text.slice(0, budget - keepTail)
    const tail = keepTail > 0 ? block.text.slice(-keepTail) : ''
    shaped.push({ type: 'text', text: head + markerFor(block) + tail })
    remaining -= budget
  }
  return shaped
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const childPath = (path, key) => (IDENTIFIER.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`)
const comparePath = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const bySizeDesc = (a, b) => b.size - a.size || comparePath(a.path, b.path)
// JSON documents can carry a literal "__proto__" key; define own properties so
// it survives as data instead of hitting the prototype setter.
const setOwn = (target, key, value) => {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true })
}

// Collect every array / string node with its JSON path, current units (whole
// elements / chars) and serialized size, so trims can be planned by path and
// re-rendered from the untouched parse.
const collectTrimTargets = (root) => {
  const arrays = []
  const strings = []
  const walk = (node, nodePath) => {
    if (Array.isArray(node)) {
      const size = JSON.stringify(node).length
      arrays.push({
        path: nodePath,
        kind: 'array',
        units: node.length,
        size,
        // firstSize (and perUnit) bound what a whole-element trim can give up:
        // keeping one element keeps that element's bytes.
        firstSize: node.length > 0 ? JSON.stringify(node[0]).length : 0,
        perUnit: node.length > 0 ? Math.ceil(size / node.length) : 0,
      })
      for (let i = 0; i < node.length; i++) walk(node[i], `${nodePath}[${i}]`)
      return
    }
    if (isPlainObject(node)) {
      for (const key of Object.keys(node)) walk(node[key], childPath(nodePath, key))
      return
    }
    if (typeof node === 'string') strings.push({ path: nodePath, kind: 'string', units: node.length, size: JSON.stringify(node).length })
  }
  walk(root, '$')
  return { arrays, strings }
}

// Rebuild the document from the original parse with only the planned trims
// applied: arrays keep a prefix of WHOLE elements, strings keep a char prefix.
// Object keys are never dropped or rewritten.
const rebuildDocument = (node, nodePath, trims) => {
  if (Array.isArray(node)) {
    const kept = trims.has(nodePath) ? trims.get(nodePath) : node.length
    const out = []
    for (let i = 0; i < kept; i++) out.push(rebuildDocument(node[i], `${nodePath}[${i}]`, trims))
    return out
  }
  if (isPlainObject(node)) {
    const out = {}
    for (const key of Object.keys(node)) setOwn(out, key, rebuildDocument(node[key], childPath(nodePath, key), trims))
    return out
  }
  if (typeof node === 'string' && trims.has(nodePath)) return node.slice(0, trims.get(nodePath))
  return node
}

const JSON_NOTE = (originalChars, maxChars, ref) =>
  `tool result trimmed: JSON kept parseable — arrays lose whole elements only; original ${originalChars} chars, budget ${maxChars} chars` +
  (ref ? `; full original stored at: ${ref.locator}. ${ref.retrievalHint}` : '')

// H-81 ③: the compact path re-serializes the document (value unchanged, bytes
// changed), so the note must say so explicitly — a consumer hashing the text
// must be able to tell a re-ordering from corruption.
const COMPACT_NOTE = (originalChars, shapedChars, maxChars, ref) =>
  `tool result compacted: JSON re-serialized (value unchanged, bytes changed) — original ${originalChars} chars, compact ${shapedChars} chars, budget ${maxChars} chars` +
  (ref ? `; full original stored at: ${ref.locator}. ${ref.retrievalHint}` : '')

// H-81 ②: the marker contract gains a `mode` field — 'compact' | 'trimmed' |
// 'envelope' — and the compact path now emits the marker too. The namespaced
// keys still can never overwrite a key the tool wrote itself.
const withMarkerSibling = (payload, marker) => {
  if (isPlainObject(payload)) {
    const out = {}
    for (const key of Object.keys(payload)) setOwn(out, key, payload[key])
    setOwn(out, MARKER_KEY, marker)
    return JSON.stringify(out)
  }
  const envelope = {}
  setOwn(envelope, ENVELOPE_KEY, payload)
  setOwn(envelope, MARKER_KEY, marker)
  return JSON.stringify(envelope)
}

// JSON-safe shaping of one text block. Returns the shaped text, or null to let
// the caller fall back to the legacy head+tail path (non-JSON document, a
// namespaced-key collision, or a document no trim plan can bring inside budget).
const shapeJsonText = (text, maxChars, ref) => {
  let parsed
  try { parsed = JSON.parse(text) } catch { return null }
  // The namespaced-key collision check runs on the PARSED document, before any
  // path emits it: a root object already carrying either namespaced key is left
  // to the head+tail path instead of being overwritten.
  const isRootObject = isPlainObject(parsed)
  if (isRootObject && Object.keys(parsed).some((key) => key === MARKER_KEY || key === ENVELOPE_KEY)) return null
  // A pretty-printed document can be over budget purely on whitespace: emitting
  // the compact re-serialization loses no content and fits. H-81 ②: this still
  // re-serializes the text (value unchanged, bytes changed), so it is no longer
  // silent — the marker rides alongside with mode='compact' and a note that
  // says re-serialized.
  const compact = JSON.stringify(parsed)
  if (compact.length <= maxChars) {
    const marker = {
      truncated: false,
      mode: 'compact',
      originalChars: text.length,
      shapedChars: compact.length,
      note: COMPACT_NOTE(text.length, compact.length, maxChars, ref),
      trimCount: 0,
      trims: [],
    }
    return withMarkerSibling(parsed, marker)
  }

  const originalChars = text.length
  const { arrays, strings } = collectTrimTargets(parsed)
  const trims = new Map() // json path -> kept units (whole elements / chars)

  // Arrays worth draining first (largest serialized first, path order breaks
  // ties); an array of one element is not worth draining — its oversized member
  // is a string-trim job. Strings come second so a kept element that is itself
  // oversized can still be shortened.
  const arrayTargets = arrays
    .filter((target) => target.units >= 2)
    .sort(bySizeDesc)
  const stringTargets = strings
    .filter((target) => target.units > 0)
    .sort(bySizeDesc)
  const planOrder = [...arrayTargets, ...stringTargets]

  const markerTrims = () => {
    const list = []
    let count = 0
    for (const target of planOrder) {
      if (!trims.has(target.path)) continue
      count += 1
      if (list.length < MARKER_MAX_TRIMS) {
        list.push({ path: target.path, kind: target.kind, returned: trims.get(target.path), total: target.units })
      }
    }
    return { list, count }
  }

  const render = () => {
    const { list, count } = markerTrims()
    const whole = rebuildDocument(parsed, '$', trims)
    const marker = {
      truncated: true,
      // H-81 ②: mode distinguishes a root-object trim ('trimmed') from the
      // envelope path for root arrays / scalars ('envelope').
      mode: isPlainObject(whole) ? 'trimmed' : 'envelope',
      kind: list[0].kind,
      path: list[0].path,
      returned: list[0].returned,
      total: list[0].total,
      originalChars,
      note: JSON_NOTE(originalChars, maxChars, ref),
      trimCount: count,
      trims: list,
    }
    // Root object: marker as a top-level sibling of the tool's own keys.
    // Root array / scalar: the trimmed payload rides the envelope and the marker
    // is its sibling, so the payload keeps its own shape inside the envelope.
    if (isPlainObject(whole)) {
      setOwn(whole, MARKER_KEY, marker)
      return JSON.stringify(whole)
    }
    const envelope = {}
    setOwn(envelope, ENVELOPE_KEY, whole)
    setOwn(envelope, MARKER_KEY, marker)
    return JSON.stringify(envelope)
  }

  const fits = () => trims.size > 0 && render().length <= maxChars
  const currentLength = () => (trims.size > 0 ? render().length : compact.length)

  // A candidate can only fix the document on its own if giving it up (or cutting
  // it to its floor) removes at least the overflow. Skipping the rest keeps the
  // sweep O(candidates) instead of O(candidates x log(units)) full re-renders —
  // a result carrying thousands of small strings would otherwise re-serialize
  // the whole document thousands of times.
  const removableMax = (target, floor) => {
    if (target.kind === 'string') return floor === 0 ? target.units + 2 : Math.max(0, target.units - 1)
    return floor === 0 ? target.size : Math.max(0, target.size - target.firstSize)
  }

  // Binary search the largest kept-unit count that fits, never going below
  // `floor`. Units are whole elements for arrays and chars for strings, so a
  // kept prefix is always a valid, parseable sub-document. Whatever the plan
  // already held for this node is kept unless this search improves on it.
  const drain = (target, floor) => {
    const total = target.units
    const hasPrev = trims.has(target.path)
    const prev = hasPrev ? trims.get(target.path) : total
    let best = null
    let lo = floor
    let hi = total
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      trims.set(target.path, mid)
      if (fits()) {
        best = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    const resolved = best === null ? (hasPrev ? prev : null) : best
    if (resolved === null || resolved >= total) trims.delete(target.path)
    else trims.set(target.path, resolved)
  }

  const sweep = (floor) => {
    const needed = currentLength() - maxChars
    for (const target of planOrder) {
      if (fits()) break
      if (removableMax(target, floor) < needed) continue
      drain(target, floor)
    }
  }

  // Pass 1 — a single trim is what the issue's payloads need.
  sweep(1)

  if (!fits()) {
    // Pass 2 — proportional shrink: cut every node worth cutting by one global
    // ratio and binary-search the largest ratio that still fits. One pass over
    // the nodes replaces hundreds of per-node re-renders on a result holding
    // many comparable lists; the step count shrinks with document size so the
    // search stays cheap on large payloads.
    const ratioSteps = Math.max(
      RATIO_SEARCH_MIN_STEPS,
      Math.min(RATIO_SEARCH_MAX_STEPS, Math.floor(RATIO_SEARCH_CHAR_BUDGET / Math.max(1, text.length))),
    )
    const planRatio = (ratio) => {
      trims.clear()
      for (const target of planOrder) {
        const total = target.units
        const floorUnits = target.kind === 'array' ? 1 : 0
        const next = Math.max(floorUnits, Math.floor(total * ratio))
        const saved = target.kind === 'string' ? total - next : (total - next) * target.perUnit
        if (saved < MIN_SAVING_CHARS) continue
        trims.set(target.path, next)
      }
    }
    let lo = 0
    let hi = 1
    let best = null
    for (let step = 0; step < ratioSteps; step++) {
      const mid = (lo + hi) / 2
      planRatio(mid)
      if (fits()) {
        best = mid
        lo = mid
      } else {
        hi = mid
      }
    }
    if (best === null) trims.clear()
    else planRatio(best)

    if (!fits()) {
      // Pass 3 — a single node given up entirely (floor 0) is still better than
      // a torn document: this is what rescues an array whose first element alone
      // overflows the budget.
      sweep(0)
    }

    // Pass 4 — hand capacity back to the biggest trimmed nodes while the
    // document still fits, so pass 2's flat ratio is not needlessly
    // destructive.
    if (fits()) {
      const trimmed = planOrder.filter((target) => trims.has(target.path)).slice(0, REGROW_MAX_NODES)
      for (const target of trimmed) {
        let bestKept = trims.get(target.path)
        let growLo = bestKept
        let growHi = target.units
        while (growLo <= growHi) {
          const mid = (growLo + growHi) >> 1
          trims.set(target.path, mid)
          if (fits()) {
            bestKept = mid
            growLo = mid + 1
          } else {
            growHi = mid - 1
          }
        }
        if (bestKept >= target.units) trims.delete(target.path)
        else trims.set(target.path, bestKept)
      }
    }
  }

  if (trims.size === 0) return null
  const shaped = render()
  return shaped.length <= maxChars ? shaped : null
}

// The JSON-safe path is only eligible for a single text block.
const shapeJsonResultText = (content, maxChars, ref) => {
  if (!Array.isArray(content) || content.length !== 1) return null
  const block = content[0]
  if (!isPlainObject(block) || block.type !== 'text' || typeof block.text !== 'string') return null
  return shapeJsonText(block.text, maxChars, ref)
}

export function apply(ctx, config = {}) {
  const maxChars = Number.isFinite(config.maxChars) ? config.maxChars : DEFAULT_MAX_CHARS
  const tailChars = Number.isFinite(config.tailChars) ? config.tailChars : DEFAULT_TAIL_CHARS
  const inlineTokenBudget = Number.isFinite(config.inlineTokenBudget) && config.inlineTokenBudget > 0
    ? config.inlineTokenBudget
    : DEFAULT_INLINE_TOKEN_BUDGET
  if (maxChars <= tailChars) {
    throw new Error(`idbots-tool-result-shaping: maxChars (${maxChars}) must exceed tailChars (${tailChars})`)
  }

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    // Shape only a plain accept: a downstream decision that already replaced
    // content or value owns the result, and errors must stay verbatim.
    if (decision?.kind !== 'accept' || decision.content !== undefined || decision.value !== undefined) return decision
    if (result.isError) return decision
    if (textLength(result.content ?? []) <= maxChars) return decision

    // Recoverable trim: persist the FULL original before any slice drops it.
    // Best-effort — a spill failure degrades to the legacy trim instead of
    // failing an otherwise-successful tool result.
    let ref
    const spillStore = ctx.get('spillStore')
    const sessionId = exec.agent?.session?.header?.id
    if (spillStore !== undefined && sessionId !== undefined) {
      try {
        ref = await spillStore.saveText({
          owner: { sessionId },
          source: { kind: 'tool', toolName: exec.name, callId: exec.callId, label: 'shaping' },
          suggestedName: `${exec.name}.txt`,
          content: result.content.filter((block) => block.type === 'text').map((block) => block.text).join(''),
        })
      } catch (error) {
        console.error(`[idbots-tool-result-shaping] ${new Date().toISOString()} ${exec.name}: spill save failed (${String(error)}); trimming without a recovery path`)
      }
    }

    // The shaped copy must price under the spill-policy cap (minus reserve) so the
    // policy's under-cap early-return keeps our marker — locator included —
    // verbatim in history.
    const tokenBudget = inlineTokenBudget - TOKEN_RESERVE

    // JSON-safe path first: one text block whose content parses as a JSON
    // document loses whole elements only, so a consumer never reads a torn key.
    let jsonText = shapeJsonResultText(result.content, maxChars, ref)
    if (jsonText !== null && ref) {
      // Shrink the document (dropping more whole elements) until it prices under
      // the cap. When the document cannot be shrunk that far the head+tail path
      // below takes over, so the policy's honesty invariant still holds.
      let budget = maxChars
      while (tokenPrice([{ type: 'text', text: jsonText }]) > tokenBudget && budget > 500) {
        budget = Math.floor(budget * 0.7)
        const smaller = shapeJsonResultText(result.content, budget, ref)
        if (smaller === null) {
          jsonText = null
          break
        }
        jsonText = smaller
      }
    }
    if (jsonText !== null) {
      console.error(`[idbots-tool-result-shaping] ${new Date().toISOString()} ${exec.name}: ${textLength(result.content)} chars -> ${jsonText.length} chars (json-safe)${ref ? ` (full original: ${ref.locator})` : ''}`)
      return {
        kind: 'accept',
        content: [{ type: 'text', text: jsonText }],
        ...decision.additionalContexts !== undefined ? { additionalContexts: decision.additionalContexts } : {},
      }
    }

    // Legacy head+tail path: byte-for-byte its historical shape without a
    // spillStore; token-bounded with one so the policy never re-spills it.
    const markerFor = ref
      ? (block) => SPILL_MARKER(block.text.length, ref)
      : (block) => MARKER(block.text.length)
    let totalChars = maxChars
    let shaped = renderShaped(result.content, markerFor, totalChars, tailChars)
    if (ref) {
      // The 500-char floor keeps the loop finite; an estimator-pathological
      // result may still overflow and take the policy's re-bound, which bounds
      // history either way.
      while (tokenPrice(shaped) > tokenBudget && totalChars > 500) {
        totalChars = Math.floor(totalChars * 0.7)
        shaped = renderShaped(result.content, markerFor, totalChars, Math.min(tailChars, Math.floor(totalChars / 4)))
      }
    }
    console.error(`[idbots-tool-result-shaping] ${new Date().toISOString()} ${exec.name}: ${textLength(result.content)} chars -> ${textLength(shaped)}${ref ? ` (full original: ${ref.locator})` : ''}`)
    return {
      kind: 'accept',
      content: shaped,
      ...decision.additionalContexts !== undefined ? { additionalContexts: decision.additionalContexts } : {},
    }
  }, { global: true })
}
