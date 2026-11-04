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

export function friendActionOf(permission: {
  toolName: string;
  toolInput?: Record<string, unknown> | null;
}): 'invite' | 'remove' | null {
  if (permission.toolName !== 'AskUserQuestion') return null;
  const context = permission.toolInput?.context;
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
  const action = (context as Record<string, unknown>).action;
  return action === 'invite' || action === 'remove' ? action : null;
}
