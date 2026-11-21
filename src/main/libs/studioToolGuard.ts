import path from 'node:path';

export interface StudioTwinToolGuardInput {
  isStudioTwinFrontOffice: boolean;
  /** True when the current Studio turn is a proactive decision/acceptance briefing. */
  isProactiveBriefingTurn?: boolean;
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

const BASH_DENY_REASON_PREFIX =
  'Studio Chief-of-Staff boundary: running mutating, build/package-install, or deliverable-authoring bash commands';

function buildBashDenyReason(detail: string): { action: 'deny'; reason: string } {
  return {
    action: 'deny',
    reason:
      `${BASH_DENY_REASON_PREFIX} (${detail}) directly inside the Studio conversation is disabled. ` +
      'Read-only inspection and verification commands are allowed; in Studio mode, only visual HTML briefing/plan pages under reports/*.html may be authored directly. ' +
      'For any concrete file, document, media, build, or code deliverable: create/update a task card and delegate execution to the best-fit local Worker Bot via local_worker_delegate.',
  };
}

function isAllowedTempOnlyDir(targetPath: string, workspaceRoot: string): boolean {
  const base = workspaceRoot.trim() || process.cwd();
  const resolved = path.isAbsolute(targetPath)
    ? normalizePathForCheck(targetPath)
    : normalizePathForCheck(path.resolve(base, targetPath));
  return resolved.includes('/.cowork-temp/') || resolved.endsWith('/.cowork-temp');
}

function isAllowedTempOrReportDir(targetPath: string, workspaceRoot: string): boolean {
  if (isAllowedTempOnlyDir(targetPath, workspaceRoot)) {
    return true;
  }
  const base = workspaceRoot.trim() || process.cwd();
  const resolved = path.isAbsolute(targetPath)
    ? normalizePathForCheck(targetPath)
    : normalizePathForCheck(path.resolve(base, targetPath));
  const normalizedBase = normalizePathForCheck(base).replace(/\/+$/, '');
  const reportsRoot = `${normalizedBase}/reports`;
  return resolved === reportsRoot || resolved.startsWith(`${reportsRoot}/`) || resolved.includes('/reports/');
}

function isWhitelistedBashTarget(targetPath: string, workspaceRoot: string, allowDirRoot = false): boolean {
  const trimmed = targetPath.trim();
  if (!trimmed || trimmed === '/dev/null') return true;
  if (isStudioWhitelistedWritePath(trimmed, workspaceRoot)) return true;
  return allowDirRoot && isAllowedTempOrReportDir(trimmed, workspaceRoot);
}

/**
 * Split a shell command string into individual command segments (outside single/double
 * quotes), also collecting non-whitelisted output redirections (`>`, `>>`, `1>`, `&>`).
 */
function scanBashSegmentsAndRedirects(command: string): {
  segments: string[];
  redirectTargets: string[];
  nestedShellScripts: string[];
} {
  const segments: string[] = [];
  const redirectTargets: string[] = [];
  const nestedShellScripts: string[] = [];
  let current = '';
  let quote: '\'' | '"' | null = null;
  let escaped = false;

  const pushSegment = () => {
    const trimmed = current.trim();
    if (trimmed) segments.push(trimmed);
    current = '';
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1] ?? '';

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\' && quote !== '\'') {
      current += ch;
      escaped = true;
      continue;
    }

    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }

    if (ch === '\'' || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }

    // Subshell / command substitution $(...)
    if (ch === '$' && next === '(') {
      let depth = 1;
      let j = i + 2;
      let subQuote: '\'' | '"' | null = null;
      let subEscaped = false;
      while (j < command.length && depth > 0) {
        const sc = command[j];
        if (subEscaped) {
          subEscaped = false;
        } else if (sc === '\\' && subQuote !== '\'') {
          subEscaped = true;
        } else if (subQuote) {
          if (sc === subQuote) subQuote = null;
        } else if (sc === '\'' || sc === '"') {
          subQuote = sc;
        } else if (sc === '(') {
          depth += 1;
        } else if (sc === ')') {
          depth -= 1;
        }
        j += 1;
      }
      const inner = command.slice(i + 2, depth === 0 ? j - 1 : j).trim();
      if (inner) nestedShellScripts.push(inner);
      current += command.slice(i, j);
      i = j - 1;
      continue;
    }

    // Backtick command substitution
    if (ch === '`') {
      const end = command.indexOf('`', i + 1);
      if (end !== -1) {
        const inner = command.slice(i + 1, end).trim();
        if (inner) nestedShellScripts.push(inner);
        current += command.slice(i, end + 1);
        i = end;
        continue;
      }
    }

    // Segment separators: ;, \n, &&, ||, |
    if (ch === '\n' || ch === ';') {
      pushSegment();
      continue;
    }
    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      pushSegment();
      i += 1;
      continue;
    }
    if (ch === '|') {
      pushSegment();
      continue;
    }

    // Output redirections outside quotes: [0-9|&]?>[>]? target
    if (ch === '>') {
      // Ignore fd duplications like `2>&1`, `1>&2`, `>&2`
      const prevChar = i > 0 ? command[i - 1] : '';
      const isAppend = next === '>';
      let targetStart = i + (isAppend ? 2 : 1);
      if (command[targetStart] === '&') {
        const afterAmp = command.slice(targetStart + 1).match(/^\d+/);
        if (afterAmp) {
          current += command.slice(i, targetStart + 1 + afterAmp[0].length);
          i = targetStart + afterAmp[0].length;
          continue;
        }
      }
      // Also handle `&>` / `&>>`
      if (prevChar === '&' && current.endsWith('&')) {
        current = current.slice(0, -1);
      }
      // Strip optional fd digit immediately preceding `>` (e.g. `2>` / `1>`)
      if (/^[0-9]$/.test(prevChar) && (current.length === 1 || /\s$/.test(current.slice(0, -1)))) {
        current = current.slice(0, -1);
      }
      while (targetStart < command.length && /\s/.test(command[targetStart])) {
        targetStart += 1;
      }
      let targetEnd = targetStart;
      let tQuote: '\'' | '"' | null = null;
      while (targetEnd < command.length) {
        const tc = command[targetEnd];
        if (tQuote) {
          if (tc === tQuote) tQuote = null;
          targetEnd += 1;
          continue;
        }
        if (tc === '\'' || tc === '"') {
          tQuote = tc;
          targetEnd += 1;
          continue;
        }
        if (/[\s;|&<>]/.test(tc)) break;
        targetEnd += 1;
      }
      const rawTarget = command.slice(targetStart, targetEnd).replace(/^['"]|['"]$/g, '');
      if (rawTarget) redirectTargets.push(rawTarget);
      i = Math.max(i, targetEnd - 1);
      continue;
    }

    current += ch;
  }
  pushSegment();
  return { segments, redirectTargets, nestedShellScripts };
}

function tokenizeSegmentArgs(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '\'' | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== '\'') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

const MUTATING_FS_COMMANDS = new Set([
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'mv',
  'cp',
  'touch',
  'truncate',
  'chmod',
  'chown',
  'chgrp',
  'ln',
  'dd',
  'install',
  'patch',
]);

const GIT_READONLY_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'rev-parse',
  'ls-files',
  'ls-tree',
  'cat-file',
  'describe',
  'blame',
  'shortlog',
  'grep',
]);

const GIT_MUTATING_SUBCOMMANDS = new Set([
  'add',
  'commit',
  'push',
  'pull',
  'fetch',
  'merge',
  'rebase',
  'cherry-pick',
  'reset',
  'revert',
  'checkout',
  'switch',
  'restore',
  'clean',
  'rm',
  'mv',
  'am',
  'apply',
  'init',
  'clone',
]);

const INLINE_WRITE_SCRIPT_PATTERN = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|rmSync|unlinkSync|mkdirSync|renameSync|copyFileSync|fs\.write|fs\.rm|fs\.unlink|fs\.mkdir|fs\.rename|fs\.copyFile|write_text|write_bytes|shutil\.|os\.remove|os\.unlink|os\.rename|os\.makedirs|Path\([^)]*\)\.write_)\b|open\s*\([^)]*,\s*['"][wax+]/i;
const SQLITE_MUTATION_PATTERN = /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|VACUUM|ATTACH|REINDEX)\b/i;

function evaluateSingleBashCommand(command: string, workspaceRoot: string, depth = 0): StudioTwinToolGuardVerdict {
  if (depth > 4) {
    return buildBashDenyReason('deeply nested shell invocation');
  }
  const { segments, redirectTargets, nestedShellScripts } = scanBashSegmentsAndRedirects(command);

  for (const target of redirectTargets) {
    if (!isWhitelistedBashTarget(target, workspaceRoot, false)) {
      return buildBashDenyReason(`shell redirection to "${target}"`);
    }
  }

  for (const nested of nestedShellScripts) {
    const nestedVerdict = evaluateSingleBashCommand(nested, workspaceRoot, depth + 1);
    if (nestedVerdict.action === 'deny') {
      return nestedVerdict;
    }
  }

  for (const segment of segments) {
    const rawTokens = tokenizeSegmentArgs(segment);
    if (rawTokens.length === 0) continue;

    // Strip leading env assignments (`FOO=bar`), `env`, `command`, `nohup`, `time`
    let idx = 0;
    while (idx < rawTokens.length) {
      const tok = rawTokens[idx];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
        idx += 1;
        continue;
      }
      if (tok === 'env' || tok === 'command' || tok === 'nohup' || tok === 'time') {
        idx += 1;
        continue;
      }
      break;
    }
    const tokens = rawTokens.slice(idx);
    if (tokens.length === 0) continue;

    const cmdBase = path.posix.basename(tokens[0]).toLowerCase();
    const args = tokens.slice(1);

    // Recursive bash -c / sh -c / zsh -c inspection
    if ((cmdBase === 'bash' || cmdBase === 'sh' || cmdBase === 'zsh') && args.length > 0) {
      const cIndex = args.findIndex((a) => a === '-c' || a === '-lc');
      if (cIndex !== -1 && args[cIndex + 1]) {
        const subVerdict = evaluateSingleBashCommand(args[cIndex + 1], workspaceRoot, depth + 1);
        if (subVerdict.action === 'deny') return subVerdict;
        continue;
      }
    }

    if (cmdBase === 'tee') {
      const targets = args.filter((a) => !a.startsWith('-'));
      for (const target of targets) {
        if (!isWhitelistedBashTarget(target, workspaceRoot, false)) {
          return buildBashDenyReason(`tee write to "${target}"`);
        }
      }
      continue;
    }

    if (cmdBase === 'mkdir') {
      const dirs = args.filter((a) => !a.startsWith('-'));
      for (const dir of dirs) {
        if (!isAllowedTempOrReportDir(dir, workspaceRoot)) {
          return buildBashDenyReason(`mkdir outside reports/.cowork-temp ("${dir}")`);
        }
      }
      continue;
    }

    if (MUTATING_FS_COMMANDS.has(cmdBase)) {
      const nonFlags = args.filter((a) => !a.startsWith('-'));
      if (cmdBase === 'rm' || cmdBase === 'rmdir' || cmdBase === 'unlink') {
        const allSafe = nonFlags.length > 0 && nonFlags.every((p) => isAllowedTempOnlyDir(p, workspaceRoot));
        if (!allSafe) {
          return buildBashDenyReason(`filesystem mutation "${cmdBase}"`);
        }
        continue;
      }
      const dest = nonFlags[nonFlags.length - 1];
      if (!dest || !isWhitelistedBashTarget(dest, workspaceRoot, cmdBase === 'cp' || cmdBase === 'mv')) {
        return buildBashDenyReason(`filesystem mutation "${cmdBase}"`);
      }
      continue;
    }

    if (cmdBase === 'sed') {
      const hasInplace = args.some((a) => a === '-i' || /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'));
      if (hasInplace) {
        return buildBashDenyReason('in-place edit via sed -i');
      }
      continue;
    }

    if (cmdBase === 'awk' || cmdBase === 'gawk') {
      const hasInplace = args.some((a, i) => a === 'inplace' && args[i - 1] === '-i') || args.some((a) => a === '-iinplace');
      if (hasInplace) {
        return buildBashDenyReason(`in-place edit via ${cmdBase} -i inplace`);
      }
      continue;
    }

    if (cmdBase === 'find') {
      if (args.some((a) => a === '-delete' || a === '-fprint' || a === '-fprintf')) {
        return buildBashDenyReason('mutating find option');
      }
      const execIndex = args.findIndex((a) => a === '-exec' || a === '-execdir');
      if (execIndex !== -1) {
        const execCmd = path.posix.basename(args[execIndex + 1] ?? '').toLowerCase();
        if (MUTATING_FS_COMMANDS.has(execCmd) || execCmd === 'sed' || execCmd === 'tee') {
          return buildBashDenyReason(`find -exec ${execCmd}`);
        }
      }
      continue;
    }

    if (cmdBase === 'git') {
      let subIdx = 0;
      while (subIdx < args.length) {
        const arg = args[subIdx];
        if (arg === '-C' || arg === '-c' || arg === '--git-dir' || arg === '--work-tree') {
          subIdx += 2;
          continue;
        }
        if (arg.startsWith('-')) {
          subIdx += 1;
          continue;
        }
        break;
      }
      const subCmd = (args[subIdx] ?? '').toLowerCase();
      const subArgs = args.slice(subIdx + 1);
      if (!subCmd || GIT_READONLY_SUBCOMMANDS.has(subCmd)) {
        continue;
      }
      if (subCmd === 'branch') {
        const mutatingFlag = subArgs.some((a) => /^-[dDmMcCf]/.test(a) || a === '--delete' || a === '--move' || a === '--copy' || a === '--force');
        const positional = subArgs.filter((a) => !a.startsWith('-'));
        if (mutatingFlag || positional.length > 0) {
          return buildBashDenyReason('git branch mutation');
        }
        continue;
      }
      if (subCmd === 'tag') {
        const mutatingFlag = subArgs.some((a) => /^-[dausf]/.test(a) || a === '--delete' || a === '--sign' || a === '--annotate');
        const listFlag = subArgs.some((a) => a === '-l' || a === '--list' || a === '-v' || a === '--verify');
        const positional = subArgs.filter((a) => !a.startsWith('-'));
        if (mutatingFlag || (positional.length > 0 && !listFlag)) {
          return buildBashDenyReason('git tag mutation');
        }
        continue;
      }
      if (subCmd === 'worktree') {
        if ((subArgs[0] ?? '').toLowerCase() === 'list') continue;
        return buildBashDenyReason(`git worktree ${subArgs[0] ?? 'mutation'}`);
      }
      if (subCmd === 'stash') {
        if ((subArgs[0] ?? '').toLowerCase() === 'list') continue;
        return buildBashDenyReason(`git stash ${subArgs[0] ?? 'mutation'}`);
      }
      if (subCmd === 'remote') {
        const remoteSub = (subArgs.find((a) => !a.startsWith('-')) ?? '').toLowerCase();
        if (!remoteSub || remoteSub === 'show' || remoteSub === 'get-url') continue;
        return buildBashDenyReason(`git remote ${remoteSub}`);
      }
      if (subCmd === 'config') {
        const readFlag = subArgs.some((a) => a === '--get' || a === '--get-all' || a === '--list' || a === '-l');
        if (readFlag) continue;
        return buildBashDenyReason('git config mutation');
      }
      if (GIT_MUTATING_SUBCOMMANDS.has(subCmd) || subCmd) {
        return buildBashDenyReason(`git ${subCmd}`);
      }
      continue;
    }

    if (cmdBase === 'npm' || cmdBase === 'pnpm' || cmdBase === 'yarn' || cmdBase === 'bun') {
      const subCmd = (args.find((a) => !a.startsWith('-')) ?? '').toLowerCase();
      const mutatingPkgActions = new Set([
        'install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade',
        'publish', 'pack', 'dist', 'build', 'link', 'unlink', 'init', 'create',
      ]);
      if (mutatingPkgActions.has(subCmd)) {
        return buildBashDenyReason(`${cmdBase} ${subCmd}`);
      }
      if (subCmd === 'run') {
        const scriptName = (args[args.indexOf('run') + 1] ?? '').toLowerCase();
        if (
          scriptName.startsWith('build')
          || scriptName.startsWith('dist')
          || scriptName.startsWith('pack')
          || scriptName.startsWith('setup')
          || scriptName.startsWith('upgrade')
        ) {
          return buildBashDenyReason(`${cmdBase} run ${scriptName}`);
        }
      }
      continue;
    }

    if (cmdBase === 'pip' || cmdBase === 'pip3' || cmdBase === 'uv' || cmdBase === 'cargo' || cmdBase === 'brew' || cmdBase === 'apt' || cmdBase === 'apt-get') {
      const subCmd = (args.find((a) => !a.startsWith('-')) ?? '').toLowerCase();
      if (['install', 'uninstall', 'upgrade', 'update', 'add', 'remove', 'build', 'publish'].includes(subCmd)) {
        return buildBashDenyReason(`${cmdBase} ${subCmd}`);
      }
      continue;
    }

    if (cmdBase === 'curl' || cmdBase === 'wget') {
      for (let i = 0; i < args.length; i += 1) {
        const a = args[i];
        if (a === '-o' || a === '--output' || a === '-O' || a === '--output-document') {
          const target = args[i + 1] ?? '';
          if (!isWhitelistedBashTarget(target, workspaceRoot, false)) {
            return buildBashDenyReason(`${cmdBase} file download to "${target || 'disk'}"`);
          }
        }
        if (a === '-O' && cmdBase === 'curl') {
          return buildBashDenyReason('curl -O file download');
        }
        if ((a === '-X' || a === '--request') && /^(POST|PUT|PATCH|DELETE)$/i.test(args[i + 1] ?? '')) {
          return buildBashDenyReason(`curl HTTP ${args[i + 1]}`);
        }
        if (a === '-d' || a === '--data' || a === '--data-raw' || a === '--data-binary' || a === '-F' || a === '--form') {
          return buildBashDenyReason('curl mutating request payload');
        }
      }
      continue;
    }

    if (cmdBase === 'sqlite3') {
      const sqlArg = args.slice(1).find((a) => !a.startsWith('-')) ?? '';
      if (SQLITE_MUTATION_PATTERN.test(sqlArg)) {
        return buildBashDenyReason('sqlite3 database mutation');
      }
      continue;
    }

    if (cmdBase === 'node' || cmdBase === 'python' || cmdBase === 'python3' || cmdBase === 'ruby' || cmdBase === 'perl') {
      const evalIdx = args.findIndex((a) => a === '-e' || a === '--eval' || a === '-c' || a === '-pe' || a === '-pi');
      if (cmdBase === 'perl' && args.some((a) => a === '-i' || /^-[a-zA-Z]*i/.test(a))) {
        return buildBashDenyReason('perl in-place edit');
      }
      if (evalIdx !== -1) {
        const code = args[evalIdx + 1] ?? '';
        if (INLINE_WRITE_SCRIPT_PATTERN.test(code)) {
          return buildBashDenyReason(`${cmdBase} inline script file write`);
        }
      }
      continue;
    }

    if (['ffmpeg', 'magick', 'convert', 'pandoc', 'pdflatex', 'xelatex', 'osascript'].includes(cmdBase)) {
      const outputCandidate = args[args.length - 1] ?? '';
      if (!isWhitelistedBashTarget(outputCandidate, workspaceRoot, true) || cmdBase === 'osascript') {
        return buildBashDenyReason(`heavy production / automation CLI "${cmdBase}"`);
      }
    }
  }

  return { action: 'allow' };
}

/**
 * Host-level guardrail for the Twin Bot's Studio front-office chat stream.
 *
 * In Studio, the Twin acts as Chief of Staff: it handles conversation,
 * requirement alignment, visual HTML projections (`reports/*.html`), task
 * decomposition, Worker delegation, and queue-driven owner briefings. Direct
 * authoring or modification of code/deliverable files in the front-office chat
 * (including via mutating `bash` commands) is blocked so the Twin delegates
 * concrete production to persistent Worker Bots (or proposes hiring a specialist
 * Worker when the local roster lacks one), while read-only inspection and
 * verification commands remain open.
 */
export function evaluateStudioTwinToolGuard(
  input: StudioTwinToolGuardInput,
): StudioTwinToolGuardVerdict {
  if (!input.isStudioTwinFrontOffice) {
    return { action: 'allow' };
  }

  const normalizedTool = String(input.toolName ?? '').trim().toLowerCase();
  if (
    input.isProactiveBriefingTurn === true
    && (normalizedTool === 'ask_user_question' || normalizedTool === 'askuserquestion')
  ) {
    return {
      action: 'deny',
      reason:
        'Studio briefing rule: NEVER call ask_user_question during task reporting, acceptance sign-off, or plan/deliverable selection. ' +
        'Present the full deliverable/HTML on the right-hand projector (with clickable preview-file:// or preview-metaapp:// links) and list concise A/B options in your chat reply so the owner can inspect the artifact on the right and reply A or B in the left input box.',
    };
  }
  if (normalizedTool === 'bash') {
    const command = typeof input.toolInput?.command === 'string'
      ? input.toolInput.command
      : typeof input.toolInput?.cmd === 'string'
        ? input.toolInput.cmd
        : '';
    if (!command.trim()) {
      return { action: 'allow' };
    }
    return evaluateSingleBashCommand(command, input.workspaceRoot);
  }
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
