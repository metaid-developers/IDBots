/**
 * Chat-composer text → pending safety-approval answer.
 *
 * A safety gate (delete, wallet transfer, chain upload, skill install,
 * multisig sign / broadcast) rides AskUserQuestion with a fixed allow/deny
 * option pair and carries `toolInput.context.requestedToolName`. Free-form
 * composer text must never be read as consent for such a gate: only a real
 * option label, or the canonical 允许/拒绝 words, answer it. Anything else
 * leaves the gate pending so the owner's actual click is still required.
 *
 * Before this helper existed, `trySubmitSteer` answered ANY pending
 * AskUserQuestion with `{ behavior: 'allow' }`; `requestSafetyApproval`
 * accepts a bare allow as approval, so typing "不要广播" — or even the deny
 * option's own label — approved a wallet_btc_broadcast gate.
 */

export type SafetyGateSteerPlan =
  | { action: 'allow' | 'deny'; answers: Record<string, string> }
  | { action: 'pass' };

const ALLOW_LABEL_RE = /(允许|同意|allow)/i;
const DENY_LABEL_RE = /(拒绝|不同意|deny)/i;
const ALLOW_TEXT_RE = /^(允许|同意|yes|y)$/i;
const DENY_TEXT_RE = /^(拒绝|不同意|no|n)$/i;

/** True when the request is a host safety gate (not a model-asked question). */
export function isSafetyApprovalToolInput(toolInput: unknown): boolean {
  const input = toolInput && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>) : {};
  const context = input.context && typeof input.context === 'object'
    ? (input.context as Record<string, unknown>)
    : null;
  const requestedToolName = typeof context?.requestedToolName === 'string'
    ? context.requestedToolName.trim()
    : '';
  return requestedToolName.length > 0;
}

function mapTextToLabel(labels: string[], text: string): string | null {
  const normalized = text.trim();
  if (!normalized) return null;
  const exact = labels.find((label) => label.toLowerCase() === normalized.toLowerCase());
  if (exact) return exact;

  // A bare ordinal ("A", "2") may pick an option; text after it is a note,
  // which is fine for a model question but never for a consent gate.
  const letter = /^([A-Za-z])$/.exec(normalized);
  const digit = /^([1-9])$/.exec(normalized);
  const ordinal = letter
    ? letter[1].toUpperCase().charCodeAt(0) - 65
    : digit
      ? Number(digit[1]) - 1
      : -1;
  if (ordinal >= 0 && ordinal < labels.length) return labels[ordinal];

  if (ALLOW_TEXT_RE.test(normalized)) {
    return labels.find((label) => ALLOW_LABEL_RE.test(label)) ?? null;
  }
  if (DENY_TEXT_RE.test(normalized)) {
    return labels.find((label) => DENY_LABEL_RE.test(label)) ?? null;
  }
  return null;
}

/**
 * Decide whether a composer message answers a pending safety gate.
 * `pass` means "not an answer": the caller must leave the gate pending and
 * treat the text as a normal steer / next turn.
 */
export function planSafetyGateSteerAnswer(toolInput: unknown, text: string): SafetyGateSteerPlan {
  if (!isSafetyApprovalToolInput(toolInput)) return { action: 'pass' };
  const input = toolInput as Record<string, unknown>;
  const questions = Array.isArray(input.questions)
    ? (input.questions as Array<Record<string, unknown>>)
    : [];
  if (questions.length === 0) return { action: 'pass' };

  const answers: Record<string, string> = {};
  let deny = false;
  for (const question of questions) {
    const title = typeof question?.question === 'string' ? question.question : '';
    const options = Array.isArray(question?.options)
      ? (question.options as Array<Record<string, unknown>>)
      : [];
    const labels = options
      .map((option) => (typeof option?.label === 'string' ? option.label.trim() : ''))
      .filter(Boolean);
    if (!title || labels.length === 0) return { action: 'pass' };
    const label = mapTextToLabel(labels, text);
    if (!label) return { action: 'pass' };
    if (DENY_LABEL_RE.test(label)) deny = true;
    answers[title] = label;
  }
  return { action: deny ? 'deny' : 'allow', answers };
}
