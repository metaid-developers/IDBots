/**
 * Tool-approval gate — the ONE predicate that decides whether a native tool
 * approval is answered without a human.
 *
 * Extracted from CoworkRunner's DSH `onApprovalRequest` so the decision that
 * governs "does a permission request exist at all" is testable on its own: with
 * `bypassPermissions` (完全信任) an IM turn must produce NO permission request,
 * and with `default` it must still produce one. A test of the surrounding
 * plumbing cannot prove that; this predicate can.
 *
 * Semantics are unchanged from the inline expression it replaced:
 *   acceptEdits | bypassPermissions | session autoApprove | per-tool autoApprove
 * `plan` deliberately does NOT skip — plan mode asks, it just restricts writes.
 */

export type ToolApprovalPermissionMode =
  | 'default'
  | 'plan'
  | 'acceptEdits'
  | 'bypassPermissions';

export interface ToolApprovalGate {
  /** Live session permission mode. Absent/unknown reads as 'default'. */
  mode: ToolApprovalPermissionMode | string | null | undefined;
  toolName?: string | null;
  /** Session-level "accept everything" switch (unattended sessions). */
  autoApprove?: boolean | null;
  /** Persisted per-tool allowlist for this session. */
  autoApproveTools?: ReadonlySet<string> | null;
}

/** True when the approval may be answered automatically (no human prompt). */
export function shouldSkipToolApproval(gate: ToolApprovalGate): boolean {
  const mode = gate.mode;
  if (mode === 'acceptEdits' || mode === 'bypassPermissions') return true;
  if (gate.autoApprove === true) return true;
  const tool = String(gate.toolName ?? '').trim().toLowerCase();
  if (tool && gate.autoApproveTools?.has(tool)) return true;
  return false;
}
