export const PERMISSION_RESPONSE_TIMEOUT_MS = 60_000;

export type PermissionTimeoutDefault = 'allow' | 'deny';

/**
 * Host policy: every unanswered tool approval is DENIED after the response
 * window (fail-closed). An earlier build auto-allowed ordinary approvals here
 * (keeping only safety confirms on deny); the 2026-11-03 pre-release review
 * reverted that — an unattended bot must never execute an unanswered
 * bash/write approval just because nobody clicked in time, and a
 * human-language regex carve-out cannot be the safety boundary.
 *
 * AskUserQuestion requests without a default never pass through this
 * resolver: they mount with no watchdog and wait for a person indefinitely.
 * The reason parameter is kept so call sites stay honest about what they
 * pass; it no longer changes the outcome.
 */
export function timeoutDefaultForToolApproval(reason: string | null | undefined): PermissionTimeoutDefault {
  void (typeof reason === 'string' ? reason : '');
  return 'deny';
}

export function stampPermissionDeadline<T extends {
  expiresAt?: number | null;
  timeoutDefault?: PermissionTimeoutDefault | null;
}>(
  request: T,
  timeoutDefault: PermissionTimeoutDefault,
  now = Date.now(),
): T {
  request.expiresAt = now + PERMISSION_RESPONSE_TIMEOUT_MS;
  request.timeoutDefault = timeoutDefault;
  return request;
}
