export const PERMISSION_COLUMN_GAP_PX = 12;
export const PERMISSION_CARD_FALLBACK_HEIGHT_PX = 160;

/**
 * Pack overlay cards into columns. The first column is the rightmost one;
 * each column fills top to bottom, and the next column opens to its left
 * once another card would pass the available height.
 */
export function packPermissionColumns<T extends { requestId: string }>(
  entries: readonly T[],
  heights: ReadonlyMap<string, number>,
  availableHeight: number,
  gap = PERMISSION_COLUMN_GAP_PX,
  fallbackHeight = PERMISSION_CARD_FALLBACK_HEIGHT_PX,
): T[][] {
  const columns: T[][] = [];
  let used = 0;
  for (const entry of entries) {
    const height = heights.get(entry.requestId) ?? fallbackHeight;
    const column = columns[columns.length - 1];
    if (!column || (column.length > 0 && used + gap + height > availableHeight)) {
      columns.push([entry]);
      used = height;
      continue;
    }
    column.push(entry);
    used += gap + height;
  }
  return columns;
}

export type A2AApprovalDescriptor = {
  category: string;
  friendAction: 'invite' | 'remove' | null;
};

export function a2aApprovalOf(permission: {
  toolName: string;
  toolInput?: Record<string, unknown> | null;
}): A2AApprovalDescriptor | null {
  if (permission.toolName !== 'AskUserQuestion') return null;
  const context = permission.toolInput?.context;
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
  const record = context as Record<string, unknown>;
  const action = record.action;
  const friendAction = action === 'invite' || action === 'remove' ? action : null;
  if (record.a2aApproval !== true && !friendAction) return null;
  return {
    category: friendAction
      ? 'friendship'
      : typeof record.category === 'string' && record.category.trim()
        ? record.category.trim()
        : 'other',
    friendAction,
  };
}

export function friendActionOf(permission: {
  toolName: string;
  toolInput?: Record<string, unknown> | null;
}): 'invite' | 'remove' | null {
  return a2aApprovalOf(permission)?.friendAction ?? null;
}
