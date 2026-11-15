import path from 'node:path';

export interface StudioTwinToolGuardInput {
  isStudioTwinFrontOffice: boolean;
  toolName: string;
  toolInput: Record<string, unknown>;
  workspaceRoot: string;
}

export type StudioTwinToolGuardVerdict =
  | { action: 'allow' }
  | { action: 'deny'; reason: string };

const MUTATING_FILE_TOOLS = new Set([
  'write',
  'edit',
  'multiedit',
  'notebookedit',
]);

const ALLOWED_REPORT_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.svg',
  '.json',
  '.css',
]);

function normalizePathForCheck(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, '/');
}

function extractTargetPath(toolInput: Record<string, unknown>): string | null {
  for (const key of ['file_path', 'filePath', 'path', 'notebook_path', 'notebookPath']) {
    const value = toolInput?.[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

/**
 * True when `resolvedTarget` sits inside a `/reports/` or `/.cowork-temp/`
 * directory (used by Studio projector pages and ephemeral scratch state).
 */
export function isStudioWhitelistedWritePath(
  targetPath: string,
  workspaceRoot: string,
): boolean {
  const base = workspaceRoot.trim() || process.cwd();
  const resolved = path.isAbsolute(targetPath)
    ? normalizePathForCheck(targetPath)
    : normalizePathForCheck(path.resolve(base, targetPath));

  if (resolved.includes('/.cowork-temp/')) {
    return true;
  }

  const reportsSegmentIndex = resolved.lastIndexOf('/reports/');
  if (reportsSegmentIndex === -1) {
    return false;
  }
  const ext = path.extname(resolved).toLowerCase();
  return ALLOWED_REPORT_EXTENSIONS.has(ext);
}

/**
 * Host-level guardrail for the Twin Bot's Studio front-office chat stream.
 *
 * In Studio, the Twin acts as Chief of Staff: it handles conversation,
 * requirement alignment, visual HTML projections (`reports/*.html`), task
 * decomposition, Worker delegation, and queue-driven owner briefings. Direct
 * authoring or modification of code/deliverable files in the front-office chat
 * is blocked so the Twin delegates concrete production to persistent Worker
 * Bots (or proposes hiring a specialist Worker when the local roster lacks one).
 */
export function evaluateStudioTwinToolGuard(
  input: StudioTwinToolGuardInput,
): StudioTwinToolGuardVerdict {
  if (!input.isStudioTwinFrontOffice) {
    return { action: 'allow' };
  }

  const normalizedTool = String(input.toolName ?? '').trim().toLowerCase();
  if (!MUTATING_FILE_TOOLS.has(normalizedTool)) {
    return { action: 'allow' };
  }

  const target = extractTargetPath(input.toolInput);
  if (target && isStudioWhitelistedWritePath(target, input.workspaceRoot)) {
    return { action: 'allow' };
  }

  const shownPath = target || '(unspecified file)';
  return {
    action: 'deny',
    reason:
      `Studio Chief-of-Staff boundary: writing or editing deliverable/code file "${shownPath}" directly inside the Studio conversation is disabled. ` +
      'In Studio mode, you may only write visual HTML briefing/plan pages under reports/*.html for the right-hand projector. ' +
      'For any concrete file, document, media, or code deliverable: create/update a task card and delegate execution to the best-fit local Worker Bot via local_worker_delegate (call local_workers_list first; if no local Worker matches the required specialty, propose hiring/creating a new specialist Worker to the owner).',
  };
}
