export const PERMISSION_RESPONSE_TIMEOUT_MS = 60_000;

export type PermissionTimeoutDefault = 'allow' | 'deny';

/**
 * Host policy asks that explain a destructive confirmation keep the deny
 * default. Ordinary tool approvals (the kernel approval seam for bash, write,
 * and similar) default to allow. Matched on the reason text the approval
 * dialog already shows, so the countdown and the watchdog agree.
 */
const SAFETY_APPROVAL_REASON_RE = /外部 Agent CLI|external agent CLI|将执行删除|will delete files/i;

export function timeoutDefaultForToolApproval(reason: string | null | undefined): PermissionTimeoutDefault {
  const text = typeof reason === 'string' ? reason : '';
  return SAFETY_APPROVAL_REASON_RE.test(text) ? 'deny' : 'allow';
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
