/**
 * QQ channel trust boundary — the THREE-LAYER permission model.
 *
 * The bug this file exists for: a QQ bot invited into a group could be
 * commanded by ANY group member, and every one of those turns ran with the
 * host bot's full local surface (files, shell, wallet, chain writes). Prompt
 * wording cannot fix that; the decision has to be made ONCE at the message
 * entry point and then carried, frozen, through the whole turn.
 *
 * Layer 1 — normal conversation: answering questions. A group can use this.
 * Layer 2 — owner-only: direct messages. Only the bound owner OpenID.
 * Layer 3 — local machine operations (read local files, run commands, send
 *           attachments, wallet, chain writes). OFF by default EVERYWHERE and
 *           needs its own per-identity allowlist (`localToolsAllowFrom`).
 *
 * Invariants enforced here (not in a prompt):
 *   - Groups NEVER get a tool surface, whatever the config says.
 *   - Groups NEVER read or write long-term memory / knowledge bases.
 *   - Groups NEVER cause an inbound attachment to be downloaded.
 *   - Strangers in DMs get NO reply at all (silence, not "denied").
 *   - Identity is the platform's stable id (member_openid / user openid),
 *     never `senderName` — display names are user-controlled.
 *   - Any throw / missing config / missing id resolves to a silent drop
 *     (fail-closed), never to a permissive fallback.
 *
 * Every decision returns an immutable {@link IMTrustContext} that rides the
 * `IMMessage` into the cowork session. Downstream code may only read it; it
 * must never recompute trust from config mid-turn.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { IMTrustContext, QQConfig, QQGroupPolicy } from './types';
import type { QQInboundLike } from './qqProtocol';

/** Fixed reply for an attachment in a group. Media is never downloaded. */
export const QQ_GROUP_MEDIA_NOTICE = '群里不支持看文件，私聊我';

/** Every group trigger is audited with the question/reply summaries capped here. */
export const QQ_AUDIT_SUMMARY_MAX = 200;

export interface QQSecurityConfig {
  groupPolicy: QQGroupPolicy;
  groupAllowlist: string[];
  /** Bound owner OpenID. Groups do NOT get a pass when this is missing. */
  ownerOpenId: string | null;
  /** Layer 3 master switch. Default OFF. */
  localToolsEnabled: boolean;
  /** Layer 3 per-identity allowlist. Default empty (nobody). */
  localToolsAllowFrom: string[];
}

export type QQGateAction = 'process' | 'static-reply' | 'silent-drop';

export interface QQGateDecision {
  action: QQGateAction;
  /** Frozen trust context to carry through the turn. */
  trust: IMTrustContext;
  /** Set for `static-reply` (currently only the group-media refusal). */
  notice?: string;
  /** Group OpenID when the inbound message came from a group. */
  groupId: string | null;
  senderId: string;
  /**
   * Set ONLY when a group was refused because it is not in the allowlist.
   *
   * It means "this id may be REMEMBERED as a candidate", never "this group may
   * be served". The gateway writes it to the candidate store and returns; the
   * action stays `silent-drop`, so there is still no reply, no model call, no
   * tool and no memory write. The very next message from the same group is
   * refused again unless the owner added it to `groupAllowlist`.
   *
   * Absent for every other refusal (policy disabled, missing id, bot sender,
   * stranger DM): those are not "candidates for the owner to allow".
   */
  pendingGroupId?: string | null;
  /** Why this decision was made — audit/log material, never user facing. */
  reason: string;
}

function trimId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePolicy(value: unknown): QQGroupPolicy {
  // Unknown / missing policy is the strictest one: no group at all. A typo in
  // the config must never widen the surface.
  if (value === 'open' || value === 'allowlist' || value === 'disabled') return value;
  return 'disabled';
}

function normalizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const id = trimId(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Turn a stored `QQConfig` into the security view. Pure and total: every
 * malformed field degrades to the strict side.
 */
export function normalizeQQSecurityConfig(
  config: Partial<QQConfig> | null | undefined
): QQSecurityConfig {
  const raw = config ?? {};
  return {
    // DEFAULT: allowlist with an empty list == no group is served at all.
    groupPolicy: normalizePolicy(raw.groupPolicy ?? 'allowlist'),
    groupAllowlist: normalizeIdList(raw.groupAllowlist),
    ownerOpenId: trimId(raw.ownerUserOpenid) || null,
    localToolsEnabled: raw.localToolsEnabled === true,
    localToolsAllowFrom: normalizeIdList(raw.localToolsAllowFrom),
  };
}

/**
 * Single source of truth for "may this conversation mount tools / use memory".
 * The runner imports these helpers instead of re-deriving the rule, so the
 * policy cannot drift between the gate and the enforcement points.
 */
export function imTrustAllowsTools(trust: IMTrustContext | null | undefined): boolean {
  return trust?.toolScope === 'local';
}

export function imTrustAllowsMemoryRead(trust: IMTrustContext | null | undefined): boolean {
  // No trust context = a non-gated legacy channel; memory behaves as before.
  if (!trust) return true;
  return trust.memoryRead === true;
}

export function imTrustAllowsMemoryWrite(trust: IMTrustContext | null | undefined): boolean {
  if (!trust) return true;
  return trust.memoryWrite === true;
}

function frozenTrust(trust: IMTrustContext): IMTrustContext {
  return Object.freeze({ ...trust }) as IMTrustContext;
}

function deny(
  level: IMTrustContext['level'],
  senderId: string,
  groupId: string | null,
  reason: string,
  decidedAt: number,
  notice?: string,
  pendingGroupId?: string | null
): QQGateDecision {
  return {
    action: notice ? 'static-reply' : 'silent-drop',
    ...(notice ? { notice } : {}),
    ...(pendingGroupId ? { pendingGroupId } : {}),
    trust: frozenTrust({
      level,
      toolScope: 'none',
      memoryRead: false,
      memoryWrite: false,
      attachmentPolicy: 'reject',
      groupId,
      decidedAt,
      reason,
    }),
    groupId,
    senderId,
    reason,
  };
}

/**
 * THE entry-point decision. Called exactly once per inbound message; the
 * returned trust context is what the rest of the pipeline is allowed to use.
 *
 * Never throws: any unexpected error becomes a silent drop.
 */
export function resolveQQMessageGate(
  msg: QQInboundLike | null | undefined,
  config: Partial<QQConfig> | null | undefined,
  now: number
): QQGateDecision {
  try {
    if (!msg || typeof msg !== 'object') {
      return deny('bot-sender', '', null, 'malformed-inbound', now);
    }
    const senderId = trimId(msg.senderId);
    const kind = msg.kind;
    const groupId = kind === 'group' ? (trimId(msg.groupOpenid) || null) : null;

    // Layer 0 (structural): another bot. Dropping here also breaks the
    // bot-to-bot @ loop two bots would otherwise form.
    if (msg.senderIsBot === true) {
      return deny('bot-sender', senderId, groupId, 'sender-is-bot', now);
    }
    if (!senderId) {
      return deny('stranger-dm', senderId, groupId, 'missing-stable-sender-id', now);
    }

    const security = normalizeQQSecurityConfig(config);

    if (kind === 'group') {
      if (!groupId) {
        // No group id means the allowlist cannot be evaluated → refuse.
        return deny('group', senderId, null, 'missing-group-id', now);
      }
      if (security.groupPolicy === 'disabled') {
        return deny('group', senderId, groupId, 'group-policy-disabled', now);
      }
      if (
        security.groupPolicy === 'allowlist'
        && !security.groupAllowlist.includes(groupId)
      ) {
        // The id is handed back ONLY so the gateway can remember it as a
        // candidate for the owner to allow in the settings page. The action is
        // still `silent-drop`: remembering is not answering, and the next
        // message from this group is refused again until `groupAllowlist`
        // actually contains it.
        return deny('group', senderId, groupId, 'group-not-allowlisted', now, undefined, groupId);
      }
      // Layer 1 only. Tools/memory/attachments are structurally off.
      return {
        action: 'process',
        trust: frozenTrust({
          level: 'group',
          toolScope: 'none',
          memoryRead: false,
          memoryWrite: false,
          attachmentPolicy: 'reject',
          groupId,
          decidedAt: now,
          reason: `group-policy-${security.groupPolicy}`,
        }),
        groupId,
        senderId,
        reason: `group-policy-${security.groupPolicy}`,
      };
    }

    if (kind === 'c2c') {
      // Layer 2: DM is owner-only. An unbound channel serves nobody.
      if (!security.ownerOpenId) {
        return deny('stranger-dm', senderId, null, 'no-owner-binding', now);
      }
      if (senderId !== security.ownerOpenId) {
        // Silence on purpose: no reply, no "unauthorized" text. It saves quota
        // and does not advertise that this identity is a bot.
        return deny('stranger-dm', senderId, null, 'sender-is-not-owner', now);
      }
      const layer3 =
        security.localToolsEnabled === true
        && security.localToolsAllowFrom.includes(senderId);
      return {
        action: 'process',
        trust: frozenTrust({
          level: 'owner-dm',
          toolScope: layer3 ? 'local' : 'none',
          memoryRead: true,
          memoryWrite: true,
          attachmentPolicy: 'allow',
          decidedAt: now,
          reason: layer3 ? 'owner-dm-layer3-granted' : 'owner-dm-layer3-default-off',
        }),
        groupId: null,
        senderId,
        reason: layer3 ? 'owner-dm-layer3-granted' : 'owner-dm-layer3-default-off',
      };
    }

    // guild / dm scopes are outside this channel's contract.
    return deny('stranger-dm', senderId, null, `unsupported-scope:${String(kind)}`, now);
  } catch (error) {
    // fail-closed: a broken gate is a closed gate.
    return deny(
      'stranger-dm',
      '',
      null,
      `gate-error:${error instanceof Error ? error.message : String(error)}`,
      now
    );
  }
}

// ---------------------------------------------------------------------------
// Group audit trail
// ---------------------------------------------------------------------------

export type QQGroupAuditOutcome = 'answered' | 'static-reply' | 'dropped' | 'error';

export interface QQGroupAuditEntry {
  /** ISO-8601 local-ish timestamp (Date#toISOString, UTC). */
  at: string;
  groupId: string;
  senderId: string;
  /** Question summary, capped at QQ_AUDIT_SUMMARY_MAX characters. */
  question: string;
  /** Reply summary, capped at QQ_AUDIT_SUMMARY_MAX characters. Empty on drops. */
  reply: string;
  outcome: QQGroupAuditOutcome;
  trustLevel: string;
  reason: string;
}

/** Collapse whitespace and cap a text for the audit trail. */
export function summarizeForAudit(text: string | null | undefined, max = QQ_AUDIT_SUMMARY_MAX): string {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Where the audit trail lands by default (`<userData>/qq/audit`). */
export function resolveDefaultQQAuditDir(): string {
  try {
    const electron = require('electron');
    const userData = electron?.app?.getPath?.('userData');
    if (typeof userData === 'string' && userData) {
      return path.join(userData, 'qq', 'audit');
    }
  } catch {
    // Electron not available (unit tests / plain node).
  }
  return path.join(os.tmpdir(), 'idbots-qq', 'audit');
}

/** Base dir for isolated group workspaces (`<userData>/qq-group-workspaces`). */
export function resolveDefaultQQGroupWorkspaceBase(): string {
  try {
    const electron = require('electron');
    const userData = electron?.app?.getPath?.('userData');
    if (typeof userData === 'string' && userData) {
      return path.join(userData, 'qq-group-workspaces');
    }
  } catch {
    // Electron not available (unit tests / plain node).
  }
  return path.join(os.tmpdir(), 'idbots-qq-group-workspaces');
}

/**
 * Workspace for a group session. Groups must NEVER see the owner's working
 * directory: the cwd is rendered into the system prompt and gives the model a
 * map of the owner's machine. Each group gets its own empty directory, keyed by
 * a sanitized group id.
 */
export function resolveQQGroupWorkspace(groupId: string): string {
  // Only [A-Za-z0-9_-] survive: dots are stripped so a group id can never
  // contribute a '..' segment to the resolved path.
  const raw = trimId(groupId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  const safe = raw || 'unknown-group';
  return path.join(resolveDefaultQQGroupWorkspaceBase(), safe);
}

function localDateStamp(now: number): string {
  const d = new Date(now);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Append-only JSONL audit log for group triggers.
 *
 * Requirements: group id, sender id, question summary, reply summary, time.
 * Never throws — an audit failure must not break (or leak into) a user turn.
 */
export class QQGroupAuditLog {
  private readonly dir: string;
  private readonly now: () => number;

  constructor(dir?: string | null, now?: () => number) {
    this.dir = dir && dir.trim() ? dir : resolveDefaultQQAuditDir();
    this.now = now ?? (() => Date.now());
  }

  getDir(): string {
    return this.dir;
  }

  filePath(now = this.now()): string {
    return path.join(this.dir, `group-${localDateStamp(now)}.jsonl`);
  }

  record(entry: QQGroupAuditEntry): boolean {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const filePath = this.filePath();
      fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  /** Newest-first read across the most recent audit files (diagnostics/tests). */
  readRecent(limit = 50): QQGroupAuditEntry[] {
    const capped = Math.max(1, Math.floor(limit) || 1);
    try {
      const files = fs
        .readdirSync(this.dir)
        .filter((name) => /^group-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
        .sort()
        .reverse();
      const out: QQGroupAuditEntry[] = [];
      for (const file of files) {
        const raw = fs.readFileSync(path.join(this.dir, file), 'utf8');
        const lines = raw.split('\n').filter((line) => line.trim());
        for (let i = lines.length - 1; i >= 0 && out.length < capped; i -= 1) {
          try {
            const parsed = JSON.parse(lines[i]) as QQGroupAuditEntry;
            if (parsed && typeof parsed === 'object') out.push(parsed);
          } catch {
            // Skip a torn line rather than failing the whole read.
          }
        }
        if (out.length >= capped) break;
      }
      return out;
    } catch {
      return [];
    }
  }
}
