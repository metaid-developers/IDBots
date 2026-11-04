/**
 * IM permission policy — two pure decisions kept out of the handler:
 *
 * 1. Is a chat reply a permission ANSWER at all?
 *    The old matcher was `/^(允许|同意|yes|y)$/` — a peer who typed
 *    「我允许了」「允许了」「可以」during a live request got the "please reply
 *    允许/拒绝" reminder instead of an approval (real-device 2026-11-04, three
 *    consecutive replies). The vocabulary below is still an EXPLICIT list —
 *    whole-string equality only, never substring matching, so 「你好」can never
 *    be read as 「好」. Scope is enforced by the CALLER: a reply is only
 *    classified when a live pending permission exists for that exact
 *    conversation; without one, 「允许」is ordinary chat text.
 *
 * 2. Which permission mode does an IM turn run under?
 *    Default is INHERIT: the same persisted global mode the desktop uses
 *    (getPersistedCoworkPermissionMode), so 完全信任 / bypassPermissions is not
 *    re-litigated per channel. A channel may override; absent/invalid falls
 *    back to global. There is deliberately NO per-tool allowlist here — the
 *    mode IS the policy, and a second policy layer would silently contradict
 *    the switch the owner actually set.
 *
 * Plus one DISCLOSURE helper: when a write-like tool targets a path outside the
 * session workspace, the confirmation prompt says so. It never decides anything
 * — the mode already decided whether a prompt exists at all.
 */

import path from 'path';

// ---------------------------------------------------------------------------
// Reply classification
// ---------------------------------------------------------------------------

export type ImPermissionReply = 'allow' | 'deny';

/**
 * Longest normalized reply still treated as a permission answer. A real answer
 * is a short confirmation; anything longer is a new instruction and must not be
 * swallowed as "yes" (or as a stale-request notice).
 */
export const IM_PERMISSION_REPLY_MAX_CHARS = 12;

/**
 * Whole-string allow vocabulary (normalized + lowercased). Kept explicit on
 * purpose: adding a phrase is a code change with a test, not a regex widening.
 */
export const IM_PERMISSION_ALLOW_PHRASES: readonly string[] = [
  '允许', '允许了', '我允许', '我允许了', '允许执行', '允许本次操作',
  '同意', '同意了', '我同意', '同意执行',
  '批准', '批准了', '批准执行',
  '确认', '确认执行',
  '可以', '可以执行', '好', '好的', '行', '嗯', '是的', '对',
  'ok', 'okay', 'yes', 'y', 'allow', 'approved', 'go ahead', 'go',
];

/** Whole-string deny vocabulary (normalized + lowercased). */
export const IM_PERMISSION_DENY_PHRASES: readonly string[] = [
  '拒绝', '拒绝了', '我拒绝', '我拒绝了', '拒绝执行',
  '不同意', '不要', '不行', '不可以', '不批准', '不确认', '不接受', '不准', '不允许',
  '取消', '取消操作', '停止', '停下', '算了', '不用', '别',
  'no', 'n', 'deny', 'denied', 'rejected', 'stop', 'cancel',
];

const TRAILING_PUNCTUATION_RE = /[。！!?？.,，、;；:：\s"'“”‘’）)\]】]+$/;

/** Trim and strip trailing punctuation/whitespace from a chat reply. */
export function normalizeImPermissionReply(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(TRAILING_PUNCTUATION_RE, '')
    .trim()
    .toLowerCase();
}

/**
 * Unambiguous permission words only. Used when the request is ALREADY dead and
 * the handler is deciding whether a message is a late answer: in that position
 * a conversational 「好」/「可以」must stay ordinary chat text, never be
 * hijacked into a stale-request notice.
 */
export const IM_PERMISSION_STRONG_ALLOW_PHRASES: readonly string[] = [
  '允许', '允许了', '我允许', '我允许了', '允许执行', '允许本次操作',
  '同意执行', '批准执行', '同意', '批准',
];

export const IM_PERMISSION_STRONG_DENY_PHRASES: readonly string[] = [
  '拒绝', '拒绝了', '我拒绝', '我拒绝了', '拒绝执行', '不同意', '不批准', '取消操作', '取消',
];

/**
 * Classify a chat reply as an explicit allow/deny answer, or null when it is
 * not answer-shaped (a new instruction, a question, an empty body).
 *
 * Callers must ALSO hold the scope: a live pending permission for the same
 * conversation. This function only answers "is this text an answer at all".
 */
export function classifyImPermissionReply(raw: string): ImPermissionReply | null {
  const normalized = normalizeImPermissionReply(raw);
  if (!normalized) return null;
  if (normalized.length > IM_PERMISSION_REPLY_MAX_CHARS) return null;
  if (IM_PERMISSION_DENY_PHRASES.includes(normalized)) return 'deny';
  if (IM_PERMISSION_ALLOW_PHRASES.includes(normalized)) return 'allow';
  return null;
}

/**
 * Same shape as classifyImPermissionReply, but only the unambiguous permission
 * words count. See IM_PERMISSION_STRONG_* above.
 */
export function classifyStrongImPermissionReply(raw: string): ImPermissionReply | null {
  const normalized = normalizeImPermissionReply(raw);
  if (!normalized) return null;
  if (normalized.length > IM_PERMISSION_REPLY_MAX_CHARS) return null;
  if (IM_PERMISSION_STRONG_DENY_PHRASES.includes(normalized)) return 'deny';
  if (IM_PERMISSION_STRONG_ALLOW_PHRASES.includes(normalized)) return 'allow';
  return null;
}

// ---------------------------------------------------------------------------
// Effective permission mode
// ---------------------------------------------------------------------------

/** The four cowork permission modes, mirrored from coworkStore's union. */
export type ImPermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';

export const IM_PERMISSION_MODES: readonly ImPermissionMode[] = [
  'default', 'plan', 'acceptEdits', 'bypassPermissions',
];

export function isImPermissionMode(value: unknown): value is ImPermissionMode {
  return typeof value === 'string' && (IM_PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * The mode an IM turn actually runs under.
 *
 * Default behaviour is INHERIT: the IM session uses the same persisted global
 * mode as the desktop (getPersistedCoworkPermissionMode). That is the product
 * decision (2026-11-04, owner): a channel must not invent its own permission
 * policy — if the owner set 完全信任 on the desktop, chat is zero-popup too.
 *
 * `override` is the per-channel setting; 'inherit', absent, or an unknown value
 * all fall through to the global mode. Group chats still inherit — the mode is
 * about approvals, not about trust in the room (trust stays per-turn).
 */
export function resolveImPermissionMode(
  override: unknown,
  globalMode: unknown
): ImPermissionMode {
  // 'inherit' is not a mode, so isImPermissionMode() already rejects it.
  if (isImPermissionMode(override)) return override;
  return isImPermissionMode(globalMode) ? globalMode : 'default';
}

/**
 * Platform from a cowork session's IM channel marker:
 * `im:weixin` / `im:weixin:group` → `weixin`.
 *
 * Anything else — null, or the `cowork_ui` channel every desktop session owns —
 * means "not an IM session", and callers must keep that session's own value.
 */
export function imPlatformFromSessionChannel(imChannel: unknown): string | null {
  if (typeof imChannel !== 'string') return null;
  const match = /^im:([a-z0-9_-]+)(?::(?:direct|group))?$/i.exec(imChannel.trim());
  return match ? match[1].toLowerCase() : null;
}

/**
 * The permission mode a session should DISPLAY.
 *
 * IM sessions run under resolveImPermissionMode (channel override, else the
 * persisted global mode). Their `cowork_sessions.permission_mode` row is frozen
 * at session creation by startSession(), so showing that row produced the
 * owner-visible contradiction "channel saved as 完全信任, window still says
 * 默认". This computes the value actually in force instead.
 *
 * READ-ONLY BY DESIGN: the resolved value is never written back to the row. The
 * row is shared with the desktop view of the same conversation, and a
 * channel-level policy must not silently promote that desktop session to
 * bypassPermissions. Desktop sessions (no IM channel) keep their own value.
 */
export function resolveSessionDisplayPermissionMode(input: {
  imChannel: unknown;
  sessionPermissionMode: unknown;
  channelOverride: unknown;
  globalMode: unknown;
}): ImPermissionMode {
  const platform = imPlatformFromSessionChannel(input.imChannel);
  if (!platform) {
    return isImPermissionMode(input.sessionPermissionMode) ? input.sessionPermissionMode : 'default';
  }
  return resolveImPermissionMode(input.channelOverride, input.globalMode);
}

/**
 * Write-like tools and the input fields that carry their target path. Used to
 * DISCLOSE where a to-be-approved operation will act when that target is
 * outside the session workspace — never to auto-decide anything.
 */
export const IM_WRITE_LIKE_TOOLS: readonly string[] = [
  'write', 'write_file', 'writefile', 'create_file',
  'edit', 'edit_file', 'multiedit', 'multi_edit', 'notebookedit', 'notebook_edit',
  'str_replace_editor', 'apply_patch',
];

export const IM_PATH_INPUT_FIELDS: readonly string[] = [
  'file_path', 'filePath', 'path', 'notebook_path', 'notebookPath', 'target_file', 'targetFile',
];

/** First path-like input value, or null when the request carries none. */
export function readToolTargetPath(toolInput: Record<string, unknown> | null | undefined): string | null {
  if (!toolInput || typeof toolInput !== 'object') return null;
  for (const field of IM_PATH_INPUT_FIELDS) {
    const value = (toolInput as Record<string, unknown>)[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** True when `target` resolves inside `root`. False when either side is unknown. */
export function isPathInsideRoot(target: string, root: string): boolean {
  if (!target || !root) return false;
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, target);
  if (resolvedTarget === resolvedRoot) return true;
  return resolvedTarget.startsWith(resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep);
}

/**
 * One line for the confirmation prompt when a write-like tool targets a path
 * OUTSIDE the session workspace, or null when the target is unknown/inside.
 *
 * This is disclosure, not policy: the mode decides whether a prompt exists at
 * all; the prompt should tell the person the one fact they cannot see.
 */
export function describeOutsideWorkspaceTarget(
  toolName: string | null | undefined,
  toolInput: Record<string, unknown> | null | undefined,
  workspaceRoot: string | null | undefined
): string | null {
  const normalized = String(toolName ?? '').trim().toLowerCase();
  if (!IM_WRITE_LIKE_TOOLS.includes(normalized)) return null;
  const target = readToolTargetPath(toolInput);
  if (!target) return null;
  if (workspaceRoot && isPathInsideRoot(target, workspaceRoot)) return null;
  return target;
}

/** One prompt-facing sentence describing what the current mode means. */
export function describeImPermissionMode(mode: ImPermissionMode): string {
  switch (mode) {
    case 'bypassPermissions':
      return '完全信任（零弹窗）：工具调用不再逐次询问，资金、删除、发布上链、对外发消息也按该模式放行；边界由用户指令决定，不得自行扩大范围';
    case 'acceptEdits':
      // The old sentence ("其它工具仍会在这里问") was false: the approval
      // predicate skips acceptEdits for EVERY tool (toolApprovalPolicy.ts:35)
      // and the DSH policy only ever asks in `default`. The model reads this
      // line as fact, so it has to describe what the code actually does.
      return '自动接受编辑（acceptEdits）：文件编辑不再询问；删除、外部命令、对外发送等同样自动放行（与电脑端一致）';
    case 'plan':
      return '计划模式（plan）：只读，不执行改动；需要实际动手时说明并请用户切换模式';
    default:
      return '需人工批准（default）：每次权限请求都在这个会话里问「允许/拒绝」，60 秒不答即拒绝';
  }
}
