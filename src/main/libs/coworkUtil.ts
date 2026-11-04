import { app, session } from 'electron';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, chmodSync, readdirSync } from 'fs';
import { delimiter, dirname, join, resolve } from 'path';
import { truncateUtf16Units } from './llmSafeText';
import { buildEnvForConfig, getCurrentApiConfig, resolveApiConfigForModel } from './claudeSettings';
import type { OpenAICompatProxyTarget } from './coworkOpenAICompatProxy';
import { getInternalApiBaseURL } from './coworkOpenAICompatProxy';
import { coworkLog } from './coworkLogger';
import { resolveElectronSkillExecutablePath } from './runtimePaths';
import { resolveWritableSkillsRoot } from './skillRoots';
import { getMetaidRpcBase, getMetaidRpcTokenFilePath, METAID_RPC_AUTHFILE_ENV } from '../services/metaidRpcEndpoint';
import { chatCompletionWithTools } from '../services/cognitiveChatCompletion';
import type { MetabotBrainOptions } from '../services/llmFallback';
import { buildTurnAckReplyMessages, buildOwnerWaitUpdateMessages, sanitizeTurnAckReplyForInput, type OwnerWaitUpdateInput } from './turnAckReply';
import { modelAlwaysThinks } from './modelThinking';
import { isSqliteWasmBoundsError } from '../sqliteRecovery';
import { assignPathValue, collapseWindowsPathKeys, pathValueOf } from './windowsPathEnv';
import { appendPythonRuntimeToEnv } from './pythonRuntime';
import { detectSystemChromium } from './chromiumRuntime';

function appendEnvPath(current: string | undefined, additions: string[]): string | undefined {
  const items = new Set<string>();

  for (const entry of additions) {
    if (entry) {
      items.add(entry);
    }
  }

  if (current) {
    for (const entry of current.split(delimiter)) {
      if (entry) {
        items.add(entry);
      }
    }
  }

  return items.size > 0 ? Array.from(items).join(delimiter) : current;
}

function appendEnvPathFallback(current: string | undefined, additions: string[]): string | undefined {
  const items = current ? current.split(delimiter).filter(Boolean) : [];
  for (const entry of additions) {
    if (entry && !items.includes(entry)) items.push(entry);
  }
  return items.length > 0 ? items.join(delimiter) : current;
}

/**
 * Cached user shell PATH. Resolved once and reused across calls.
 */
let cachedUserShellPath: string | null | undefined;

/**
 * Resolve the user's login shell PATH on macOS/Linux.
 * Packaged Electron apps on macOS don't inherit the user's shell profile,
 * so node/npm and other tools won't be in PATH unless we resolve it.
 */
function resolveUserShellPath(): string | null {
  if (cachedUserShellPath !== undefined) return cachedUserShellPath;

  if (process.platform === 'win32') {
    cachedUserShellPath = null;
    return null;
  }

  try {
    const shell = process.env.SHELL || '/bin/bash';
    const result = execSync(`${shell} -ilc 'echo __PATH__=$PATH'`, {
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env },
    });
    const match = result.match(/__PATH__=(.+)/);
    cachedUserShellPath = match ? match[1].trim() : null;
  } catch (error) {
    console.warn('[coworkUtil] Failed to resolve user shell PATH:', error);
    cachedUserShellPath = null;
  }

  return cachedUserShellPath;
}

/**
 * Cached git-bash path on Windows. Resolved once and reused.
 */
let cachedGitBashPath: string | null | undefined;
const LOCAL_NO_PROXY_HOSTS = ['localhost', '127.0.0.1', '::1', '10.0.2.2'];

function normalizeWindowsPath(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim().replace(/\r/g, '');
  if (!trimmed) return null;

  const unquoted = trimmed.replace(/^["']+|["']+$/g, '');
  if (!unquoted) return null;

  return unquoted.replace(/\//g, '\\');
}

function mergeNoProxyList(
  current: string | undefined,
  additions: string[]
): string {
  const merged: string[] = [];
  const seen = new Set<string>();

  const pushValue = (value: string): void => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(trimmed);
  };

  if (current) {
    current
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .forEach(pushValue);
  }

  additions.forEach(pushValue);
  return merged.join(',');
}

function listWindowsCommandPaths(command: string): string[] {
  try {
    const output = execSync(command, { encoding: 'utf-8', timeout: 5000 });
    const parsed = output
      .split(/\r?\n/)
      .map((line) => normalizeWindowsPath(line))
      .filter((line): line is string => Boolean(line && existsSync(line)));
    return Array.from(new Set(parsed));
  } catch {
    return [];
  }
}

function listGitInstallPathsFromRegistry(): string[] {
  const registryKeys = [
    'HKCU\\Software\\GitForWindows',
    'HKLM\\Software\\GitForWindows',
    'HKLM\\Software\\WOW6432Node\\GitForWindows',
  ];

  const installRoots: string[] = [];

  for (const key of registryKeys) {
    try {
      const output = execSync(`reg query "${key}" /v InstallPath`, { encoding: 'utf-8', timeout: 5000 });
      for (const line of output.split(/\r?\n/)) {
        const match = line.match(/InstallPath\s+REG_\w+\s+(.+)$/i);
        const root = normalizeWindowsPath(match?.[1]);
        if (root) {
          installRoots.push(root);
        }
      }
    } catch {
      // registry key might not exist
    }
  }

  return Array.from(new Set(installRoots));
}

function getWindowsGitToolDirs(bashPath: string): string[] {
  const normalized = bashPath.replace(/\//g, '\\');
  const lower = normalized.toLowerCase();
  let gitRoot: string | null = null;

  if (lower.endsWith('\\usr\\bin\\bash.exe')) {
    gitRoot = normalized.slice(0, -'\\usr\\bin\\bash.exe'.length);
  } else if (lower.endsWith('\\bin\\bash.exe')) {
    gitRoot = normalized.slice(0, -'\\bin\\bash.exe'.length);
  }

  if (!gitRoot) {
    const bashDir = dirname(normalized);
    return [bashDir].filter((dir) => existsSync(dir));
  }

  const candidates = [
    join(gitRoot, 'cmd'),
    join(gitRoot, 'mingw64', 'bin'),
    join(gitRoot, 'usr', 'bin'),
    join(gitRoot, 'bin'),
  ];

  return candidates.filter((dir) => existsSync(dir));
}

type ElectronNodeShimInfo = {
  shimDir: string;
  shimScriptPath: string;
};

/**
 * Write the Electron-as-Node shim (node/npx/ts-node launchers backed by
 * ELECTRON_RUN_AS_NODE) into userData/cowork/bin. Applies to every platform:
 * Windows uses it because Start-menu launches lack Node on PATH; macOS/Linux
 * packaged installs hit the same wall when the user never installed Node.
 */
function ensureElectronNodeShim(): ElectronNodeShimInfo | null {
  try {
    const shimDir = join(app.getPath('userData'), 'cowork', 'bin');
    mkdirSync(shimDir, { recursive: true });

    const shimScriptPath = join(shimDir, 'idbots-node-shim.js');

    const nodeSh = join(shimDir, 'node');
    const nodeCmd = join(shimDir, 'node.cmd');
    const npxSh = join(shimDir, 'npx');
    const npxCmd = join(shimDir, 'npx.cmd');
    const tsNodeSh = join(shimDir, 'ts-node');
    const tsNodeCmd = join(shimDir, 'ts-node.cmd');

    const shimScriptContent = [
      '#!/usr/bin/env node',
      '\'use strict\';',
      '',
      'const fs = require(\'fs\');',
      'const path = require(\'path\');',
      'const { spawnSync } = require(\'child_process\');',
      '',
      'const modeArg = process.argv[2] || \'\';',
      'const mode = modeArg.startsWith(\'--mode=\') ? modeArg.slice(\'--mode=\'.length) : \'node\';',
      'const args = modeArg.startsWith(\'--mode=\') ? process.argv.slice(3) : process.argv.slice(2);',
      '',
      'const electronPath = process.env.IDBOTS_ELECTRON_PATH || \'\';',
      'if (!electronPath) {',
      '  console.error(\'IDBOTS_ELECTRON_PATH is not set\');',
      '  process.exit(127);',
      '}',
      '',
      'const shimDir = process.env.IDBOTS_NODE_SHIM_DIR',
      '  ? path.resolve(process.env.IDBOTS_NODE_SHIM_DIR)',
      '  : path.dirname(__filename);',
      'const normalizedShimDir = path.resolve(shimDir).toLowerCase();',
      '',
      'function exists(filePath) {',
      '  try {',
      '    return fs.existsSync(filePath);',
      '  } catch {',
      '    return false;',
      '  }',
      '}',
      '',
      'function runCommand(command, commandArgs, env) {',
      '  const result = spawnSync(command, commandArgs, {',
      '    stdio: \'inherit\',',
      '    env,',
      '    cwd: process.cwd(),',
      '    windowsHide: true,',
      '  });',
      '  if (typeof result.status === \'number\') {',
      '    process.exit(result.status);',
      '  }',
      '  if (result.error) {',
      '    const code = result.error.code === \'ENOENT\' ? 127 : 1;',
      '    console.error(result.error.message || String(result.error));',
      '    process.exit(code);',
      '  }',
      '  process.exit(1);',
      '}',
      '',
      'function runAsNode(nodeArgs) {',
      '  const env = { ...process.env, ELECTRON_RUN_AS_NODE: \'1\' };',
      '  runCommand(electronPath, nodeArgs, env);',
      '}',
      '',
      'function toAbsoluteMaybe(value) {',
      '  if (!value) return null;',
      '  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);',
      '}',
      '',
      'function findScriptFallback(scriptArg) {',
      '  const absolute = toAbsoluteMaybe(scriptArg);',
      '  if (!absolute) return null;',
      '  if (exists(absolute)) return absolute;',
      '',
      '  const ext = path.extname(absolute).toLowerCase();',
      '  const dir = path.dirname(absolute);',
      '  const baseName = ext ? path.basename(absolute, ext) : path.basename(absolute);',
      '  const candidates = [];',
      '',
      '  if (ext === \'.ts\') {',
      '    candidates.push(path.join(dir, `${baseName}.js`));',
      '    candidates.push(path.join(dir, \'dist\', `${baseName}.js`));',
      '  } else if (ext === \'.js\') {',
      '    candidates.push(path.join(dir, \'dist\', `${baseName}.js`));',
      '  } else {',
      '    candidates.push(`${absolute}.js`);',
      '    candidates.push(path.join(dir, \'dist\', `${path.basename(absolute)}.js`));',
      '  }',
      '',
      '  for (const candidate of candidates) {',
      '    if (exists(candidate)) return candidate;',
      '  }',
      '  return null;',
      '}',
      '',
      'function resolveNodeArgs(rawArgs) {',
      '  if (!Array.isArray(rawArgs) || rawArgs.length === 0) {',
      '    return rawArgs;',
      '  }',
      '',
      '  const first = rawArgs[0];',
      '  if (!first || first.startsWith(\'-\')) {',
      '    return rawArgs;',
      '  }',
      '',
      '  const resolved = findScriptFallback(first);',
      '  if (!resolved) {',
      '    return rawArgs;',
      '  }',
      '',
      '  return [resolved, ...rawArgs.slice(1)];',
      '}',
      '',
      'function findExecutableOnPath(names) {',
      '  const envPath = process.env.PATH || \'\';',
      '  const pathEntries = envPath',
      '    .split(path.delimiter)',
      '    .map((entry) => entry.trim().replace(/^["\']+|["\']+$/g, \'\'))',
      '    .filter(Boolean);',
      '',
      '  for (const entry of pathEntries) {',
      '    const resolvedEntry = path.resolve(entry);',
      '    if (resolvedEntry.toLowerCase() === normalizedShimDir) continue;',
      '',
      '    for (const name of names) {',
      '      const full = path.join(resolvedEntry, name);',
      '      if (exists(full)) {',
      '        return full;',
      '      }',
      '    }',
      '  }',
      '',
      '  return null;',
      '}',
      '',
      'function parseTsNodeInvocation(rawArgs) {',
      '  const optionsWithValue = new Set([',
      '    \'-P\', \'--project\',',
      '    \'-r\', \'--require\',',
      '    \'-O\', \'--compiler-options\',',
      '    \'--compiler\', \'--cwd\',',
      '    \'--scopeDir\', \'--transpiler\',',
      '  ]);',
      '',
      '  for (let i = 0; i < rawArgs.length; i += 1) {',
      '    const arg = rawArgs[i];',
      '    if (arg === \'--\') {',
      '      const scriptIndex = i + 1;',
      '      if (scriptIndex < rawArgs.length) {',
      '        return { scriptIndex, trailingArgs: rawArgs.slice(scriptIndex + 1) };',
      '      }',
      '      return null;',
      '    }',
      '    if (!arg.startsWith(\'-\')) {',
      '      return { scriptIndex: i, trailingArgs: rawArgs.slice(i + 1) };',
      '    }',
      '    if (optionsWithValue.has(arg)) {',
      '      i += 1;',
      '    }',
      '  }',
      '',
      '  return null;',
      '}',
      '',
      'function runTsNode(rawArgs) {',
      '  const parsed = parseTsNodeInvocation(rawArgs);',
      '  if (!parsed) {',
      '    const realTsNode = findExecutableOnPath([\'ts-node.cmd\', \'ts-node.exe\', \'ts-node\']);',
      '    if (realTsNode) {',
      '      runCommand(realTsNode, rawArgs, process.env);',
      '      return;',
      '    }',
      '    console.error(\'Unable to parse ts-node arguments and ts-node runtime was not found\');',
      '    process.exit(127);',
      '  }',
      '',
      '  const scriptArg = rawArgs[parsed.scriptIndex];',
      '  const resolvedScript = findScriptFallback(scriptArg);',
      '  if (resolvedScript && resolvedScript.toLowerCase().endsWith(\'.js\')) {',
      '    runAsNode([resolvedScript, ...parsed.trailingArgs]);',
      '    return;',
      '  }',
      '',
      '  const realTsNode = findExecutableOnPath([\'ts-node.cmd\', \'ts-node.exe\', \'ts-node\']);',
      '  if (realTsNode) {',
      '    runCommand(realTsNode, rawArgs, process.env);',
      '    return;',
      '  }',
      '',
      '  console.error(`ts-node is unavailable and no compiled JavaScript fallback was found for: ${scriptArg}`);',
      '  process.exit(127);',
      '}',
      '',
      'function parseNpxInvocation(rawArgs) {',
      '  const optionsWithValue = new Set([',
      '    \'-p\', \'--package\',',
      '    \'-c\', \'--call\',',
      '    \'--cache\', \'--userconfig\',',
      '    \'--registry\', \'--node-arg\',',
      '    \'--node-args\',',
      '  ]);',
      '',
      '  let index = 0;',
      '  while (index < rawArgs.length) {',
      '    const arg = rawArgs[index];',
      '    if (arg === \'--\') {',
      '      index += 1;',
      '      break;',
      '    }',
      '    if (!arg.startsWith(\'-\')) {',
      '      break;',
      '    }',
      '    if (optionsWithValue.has(arg)) {',
      '      index += 2;',
      '      continue;',
      '    }',
      '    index += 1;',
      '  }',
      '',
      '  if (index >= rawArgs.length) {',
      '    return null;',
      '  }',
      '',
      '  return {',
      '    command: rawArgs[index],',
      '    commandArgs: rawArgs.slice(index + 1),',
      '  };',
      '}',
      '',
      'function runNpx(rawArgs) {',
      '  const parsed = parseNpxInvocation(rawArgs);',
      '  if (parsed && parsed.command === \'ts-node\') {',
      '    runTsNode(parsed.commandArgs);',
      '    return;',
      '  }',
      '',
      '  const realNpx = findExecutableOnPath([\'npx.cmd\', \'npx.exe\', \'npx\']);',
      '  if (realNpx) {',
      '    runCommand(realNpx, rawArgs, process.env);',
      '    return;',
      '  }',
      '',
      '  if (parsed) {',
      '    console.error(`npx runtime was not found and cannot execute: ${parsed.command}`);',
      '  } else {',
      '    console.error(\'npx runtime was not found\');',
      '  }',
      '  process.exit(127);',
      '}',
      '',
      'if (mode === \'npx\') {',
      '  runNpx(args);',
      '} else if (mode === \'ts-node\') {',
      '  runTsNode(args);',
      '} else {',
      '  runAsNode(resolveNodeArgs(args));',
      '}',
      '',
    ].join('\n');

    const nodeShContent = [
      '#!/usr/bin/env bash',
      'if [ -z "${IDBOTS_ELECTRON_PATH:-}" ]; then',
      '  echo "IDBOTS_ELECTRON_PATH is not set" >&2',
      '  exit 127',
      'fi',
      'if [ -z "${IDBOTS_NODE_SHIM_SCRIPT:-}" ]; then',
      '  echo "IDBOTS_NODE_SHIM_SCRIPT is not set" >&2',
      '  exit 127',
      'fi',
      'exec env ELECTRON_RUN_AS_NODE=1 "${IDBOTS_ELECTRON_PATH}" "${IDBOTS_NODE_SHIM_SCRIPT}" --mode=node "$@"',
      '',
    ].join('\n');

    const npxShContent = [
      '#!/usr/bin/env bash',
      'if [ -z "${IDBOTS_ELECTRON_PATH:-}" ]; then',
      '  echo "IDBOTS_ELECTRON_PATH is not set" >&2',
      '  exit 127',
      'fi',
      'if [ -z "${IDBOTS_NODE_SHIM_SCRIPT:-}" ]; then',
      '  echo "IDBOTS_NODE_SHIM_SCRIPT is not set" >&2',
      '  exit 127',
      'fi',
      'exec env ELECTRON_RUN_AS_NODE=1 "${IDBOTS_ELECTRON_PATH}" "${IDBOTS_NODE_SHIM_SCRIPT}" --mode=npx "$@"',
      '',
    ].join('\n');

    const tsNodeShContent = [
      '#!/usr/bin/env bash',
      'if [ -z "${IDBOTS_ELECTRON_PATH:-}" ]; then',
      '  echo "IDBOTS_ELECTRON_PATH is not set" >&2',
      '  exit 127',
      'fi',
      'if [ -z "${IDBOTS_NODE_SHIM_SCRIPT:-}" ]; then',
      '  echo "IDBOTS_NODE_SHIM_SCRIPT is not set" >&2',
      '  exit 127',
      'fi',
      'exec env ELECTRON_RUN_AS_NODE=1 "${IDBOTS_ELECTRON_PATH}" "${IDBOTS_NODE_SHIM_SCRIPT}" --mode=ts-node "$@"',
      '',
    ].join('\n');

    const nodeCmdContent = [
      '@echo off',
      'if "%IDBOTS_ELECTRON_PATH%"=="" (',
      '  echo IDBOTS_ELECTRON_PATH is not set 1>&2',
      '  exit /b 127',
      ')',
      'if "%IDBOTS_NODE_SHIM_SCRIPT%"=="" (',
      '  echo IDBOTS_NODE_SHIM_SCRIPT is not set 1>&2',
      '  exit /b 127',
      ')',
      'set ELECTRON_RUN_AS_NODE=1',
      '"%IDBOTS_ELECTRON_PATH%" "%IDBOTS_NODE_SHIM_SCRIPT%" --mode=node %*',
      '',
    ].join('\r\n');

    const npxCmdContent = [
      '@echo off',
      'if "%IDBOTS_ELECTRON_PATH%"=="" (',
      '  echo IDBOTS_ELECTRON_PATH is not set 1>&2',
      '  exit /b 127',
      ')',
      'if "%IDBOTS_NODE_SHIM_SCRIPT%"=="" (',
      '  echo IDBOTS_NODE_SHIM_SCRIPT is not set 1>&2',
      '  exit /b 127',
      ')',
      'set ELECTRON_RUN_AS_NODE=1',
      '"%IDBOTS_ELECTRON_PATH%" "%IDBOTS_NODE_SHIM_SCRIPT%" --mode=npx %*',
      '',
    ].join('\r\n');

    const tsNodeCmdContent = [
      '@echo off',
      'if "%IDBOTS_ELECTRON_PATH%"=="" (',
      '  echo IDBOTS_ELECTRON_PATH is not set 1>&2',
      '  exit /b 127',
      ')',
      'if "%IDBOTS_NODE_SHIM_SCRIPT%"=="" (',
      '  echo IDBOTS_NODE_SHIM_SCRIPT is not set 1>&2',
      '  exit /b 127',
      ')',
      'set ELECTRON_RUN_AS_NODE=1',
      '"%IDBOTS_ELECTRON_PATH%" "%IDBOTS_NODE_SHIM_SCRIPT%" --mode=ts-node %*',
      '',
    ].join('\r\n');

    writeFileSync(shimScriptPath, shimScriptContent, 'utf8');
    writeFileSync(nodeSh, nodeShContent, 'utf8');
    writeFileSync(npxSh, npxShContent, 'utf8');
    writeFileSync(tsNodeSh, tsNodeShContent, 'utf8');
    if (process.platform === 'win32') {
      // .cmd launchers only matter for cmd.exe contexts on Windows.
      writeFileSync(nodeCmd, nodeCmdContent, 'utf8');
      writeFileSync(npxCmd, npxCmdContent, 'utf8');
      writeFileSync(tsNodeCmd, tsNodeCmdContent, 'utf8');
    }
    try {
      chmodSync(nodeSh, 0o755);
      chmodSync(npxSh, 0o755);
      chmodSync(tsNodeSh, 0o755);
    } catch {
      // Ignore chmod errors on file systems that do not support POSIX modes.
    }

    // Cygpath shim: Claude Code CLI may invoke cygpath from bash or cmd contexts.
    // Provide both POSIX and CMD shims so path conversion does not fail when one runtime is missing.
    const cygpathSh = join(shimDir, 'cygpath');
    const cygpathCmd = join(shimDir, 'cygpath.cmd');
    const cygpathShContent = [
      '#!/usr/bin/env bash',
      'if [ "$1" = "-u" ]; then',
      '  p="$2"',
      '  [ -z "$p" ] && exit 1',
      '  p="${p#\\\'}"; p="${p%\\\'}"',
      '  p="${p#\\"}"; p="${p%\\"}"',
      '  p="${p//\\\\/\\/}"',
      '  if [[ "$p" =~ ^([a-zA-Z]):(.*) ]]; then',
      '    d="${BASH_REMATCH[1]}"',
      '    r="${BASH_REMATCH[2]}"',
      '    printf "/%s%s\\n" "$(echo "$d" | tr "[:upper:]" "[:lower:]")" "$r"',
      '  else',
      '    echo "$p"',
      '  fi',
      '  exit 0',
      'fi',
      'if [ "$1" = "-w" ]; then',
      '  p="$2"',
      '  [ -z "$p" ] && exit 1',
      '  p="${p#\\\'}"; p="${p%\\\'}"',
      '  p="${p#\\"}"; p="${p%\\"}"',
      '  if [[ "$p" =~ ^/([a-zA-Z])(.*) ]]; then',
      '    d="${BASH_REMATCH[1]}"',
      '    r="${BASH_REMATCH[2]}"',
      '    r="${r//\\//\\\\}"',
      '    printf "%s:\\\\%s\\n" "$(echo "$d" | tr "[:lower:]" "[:upper:]")" "$r"',
      '  else',
      '    echo "${p//\\//\\\\}"',
      '  fi',
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n');
    const cygpathCmdContent = [
      '@echo off',
      'setlocal EnableExtensions EnableDelayedExpansion',
      'set "mode=%~1"',
      'set "p=%~2"',
      'if "%mode%"=="" exit /b 1',
      'if "%p%"=="" exit /b 1',
      'if /I "%mode%"=="-u" goto to_unix',
      'if /I "%mode%"=="-w" goto to_win',
      'exit /b 1',
      ':trim_quotes',
      'if not "!p!"=="" if "!p:~0,1!"=="\'" set "p=!p:~1!"',
      'if not "!p!"=="" if "!p:~-1!"=="\'" set "p=!p:~0,-1!"',
      'if not "!p!"=="" if "!p:~0,1!"=="\\"" set "p=!p:~1!"',
      'if not "!p!"=="" if "!p:~-1!"=="\\"" set "p=!p:~0,-1!"',
      'goto :eof',
      ':to_unix',
      'call :trim_quotes',
      'set "p=!p:\\=/!"',
      'if "!p:~1,1!"==":" (',
      '  set "drive=!p:~0,1!"',
      '  set "rest=!p:~2!"',
      '  call set "drive=%%drive:A=a%%"',
      '  call set "drive=%%drive:B=b%%"',
      '  call set "drive=%%drive:C=c%%"',
      '  call set "drive=%%drive:D=d%%"',
      '  call set "drive=%%drive:E=e%%"',
      '  call set "drive=%%drive:F=f%%"',
      '  call set "drive=%%drive:G=g%%"',
      '  call set "drive=%%drive:H=h%%"',
      '  call set "drive=%%drive:I=i%%"',
      '  call set "drive=%%drive:J=j%%"',
      '  call set "drive=%%drive:K=k%%"',
      '  call set "drive=%%drive:L=l%%"',
      '  call set "drive=%%drive:M=m%%"',
      '  call set "drive=%%drive:N=n%%"',
      '  call set "drive=%%drive:O=o%%"',
      '  call set "drive=%%drive:P=p%%"',
      '  call set "drive=%%drive:Q=q%%"',
      '  call set "drive=%%drive:R=r%%"',
      '  call set "drive=%%drive:S=s%%"',
      '  call set "drive=%%drive:T=t%%"',
      '  call set "drive=%%drive:U=u%%"',
      '  call set "drive=%%drive:V=v%%"',
      '  call set "drive=%%drive:W=w%%"',
      '  call set "drive=%%drive:X=x%%"',
      '  call set "drive=%%drive:Y=y%%"',
      '  call set "drive=%%drive:Z=z%%"',
      '  echo//!drive!!rest!',
      '  exit /b 0',
      ')',
      'echo/!p!',
      'exit /b 0',
      ':to_win',
      'call :trim_quotes',
      'if "!p:~0,1!"=="/" if not "!p:~2,1!"=="" (',
      '  set "drive=!p:~1,1!"',
      '  set "rest=!p:~2!"',
      '  set "rest=!rest:/=\\!"',
      '  call set "drive=%%drive:a=A%%"',
      '  call set "drive=%%drive:b=B%%"',
      '  call set "drive=%%drive:c=C%%"',
      '  call set "drive=%%drive:d=D%%"',
      '  call set "drive=%%drive:e=E%%"',
      '  call set "drive=%%drive:f=F%%"',
      '  call set "drive=%%drive:g=G%%"',
      '  call set "drive=%%drive:h=H%%"',
      '  call set "drive=%%drive:i=I%%"',
      '  call set "drive=%%drive:j=J%%"',
      '  call set "drive=%%drive:k=K%%"',
      '  call set "drive=%%drive:l=L%%"',
      '  call set "drive=%%drive:m=M%%"',
      '  call set "drive=%%drive:n=N%%"',
      '  call set "drive=%%drive:o=O%%"',
      '  call set "drive=%%drive:p=P%%"',
      '  call set "drive=%%drive:q=Q%%"',
      '  call set "drive=%%drive:r=R%%"',
      '  call set "drive=%%drive:s=S%%"',
      '  call set "drive=%%drive:t=T%%"',
      '  call set "drive=%%drive:u=U%%"',
      '  call set "drive=%%drive:v=V%%"',
      '  call set "drive=%%drive:w=W%%"',
      '  call set "drive=%%drive:x=X%%"',
      '  call set "drive=%%drive:y=Y%%"',
      '  call set "drive=%%drive:z=Z%%"',
      '  echo/!drive!:!rest!',
      '  exit /b 0',
      ')',
      'set "p=!p:/=\\!"',
      'echo/!p!',
      'exit /b 0',
      '',
    ].join('\r\n');
    if (process.platform === 'win32') {
      // cygpath is only invoked by Claude Code CLI from Windows bash/cmd contexts.
      writeFileSync(cygpathSh, cygpathShContent, 'utf8');
      writeFileSync(cygpathCmd, cygpathCmdContent, 'utf8');
      try {
        chmodSync(cygpathSh, 0o755);
      } catch {
        // Ignore chmod errors
      }
    }

    return {
      shimDir,
      shimScriptPath,
    };
  } catch (error) {
    coworkLog('WARN', 'resolveNodeShim', `Failed to prepare Electron Node shim: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Resolve git-bash path on Windows.
 * Claude Code CLI requires git-bash for shell tool execution.
 * Checks: env var > common install paths > PATH lookup > bundled PortableGit fallback.
 */
function resolveWindowsGitBashPath(): string | null {
  if (cachedGitBashPath !== undefined) return cachedGitBashPath;

  if (process.platform !== 'win32') {
    cachedGitBashPath = null;
    return null;
  }

  // 1. Explicit env var (user override)
  const envPath = normalizeWindowsPath(process.env.CLAUDE_CODE_GIT_BASH_PATH);
  if (envPath && existsSync(envPath)) {
    coworkLog('INFO', 'resolveGitBash', `Using CLAUDE_CODE_GIT_BASH_PATH: ${envPath}`);
    cachedGitBashPath = envPath;
    return envPath;
  }

  // 2. Common Git for Windows installation paths (prefer user/system install first)
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || '';
  const userProfile = process.env.USERPROFILE || '';

  const candidates = [
    join(programFiles, 'Git', 'bin', 'bash.exe'),
    join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'),
    join(programFilesX86, 'Git', 'bin', 'bash.exe'),
    join(programFilesX86, 'Git', 'usr', 'bin', 'bash.exe'),
    join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'),
    join(localAppData, 'Programs', 'Git', 'usr', 'bin', 'bash.exe'),
    join(userProfile, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
    join(userProfile, 'scoop', 'apps', 'git', 'current', 'usr', 'bin', 'bash.exe'),
    'C:\\Git\\bin\\bash.exe',
    'C:\\Git\\usr\\bin\\bash.exe',
  ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      coworkLog('INFO', 'resolveGitBash', `Found git-bash at: ${candidate}`);
      cachedGitBashPath = candidate;
      return candidate;
    }
  }

  // 3. Query Git for Windows install root from registry
  const registryInstallRoots = listGitInstallPathsFromRegistry();
  for (const installRoot of registryInstallRoots) {
    const registryCandidates = [
      join(installRoot, 'bin', 'bash.exe'),
      join(installRoot, 'usr', 'bin', 'bash.exe'),
    ];
    for (const candidate of registryCandidates) {
      if (existsSync(candidate)) {
        coworkLog('INFO', 'resolveGitBash', `Found git-bash via registry: ${candidate}`);
        cachedGitBashPath = candidate;
        return candidate;
      }
    }
  }

  // 4. Try `where bash`
  const bashPaths = listWindowsCommandPaths('where bash');
  for (const bashPath of bashPaths) {
    if (bashPath.toLowerCase().endsWith('\\bash.exe')) {
      coworkLog('INFO', 'resolveGitBash', `Found bash via PATH: ${bashPath}`);
      cachedGitBashPath = bashPath;
      return bashPath;
    }
  }

  // 5. Try `where git` and derive bash from git location
  const gitPaths = listWindowsCommandPaths('where git');
  for (const gitPath of gitPaths) {
    const gitRoot = dirname(dirname(gitPath));
    const bashCandidates = [
      join(gitRoot, 'bin', 'bash.exe'),
      join(gitRoot, 'usr', 'bin', 'bash.exe'),
    ];
    for (const candidate of bashCandidates) {
      if (existsSync(candidate)) {
        coworkLog('INFO', 'resolveGitBash', `Found bash via PATH git: ${candidate}`);
        cachedGitBashPath = candidate;
        return candidate;
      }
    }
  }

  // 6. Bundled PortableGit fallback.
  // - Packaged app: resources/mingit
  // - Development mode: project resources/mingit (for local Windows dev without system Git install)
  const bundledRoots = app.isPackaged
    ? [join(process.resourcesPath, 'mingit')]
    : [
      join(__dirname, '..', '..', 'resources', 'mingit'),
      join(app.getAppPath(), 'resources', 'mingit'),
      join(process.cwd(), 'resources', 'mingit'),
    ];
  for (const root of bundledRoots) {
    // Prefer bin/bash.exe on Windows; invoking usr/bin/bash.exe directly may miss Git toolchain PATH.
    const bundledPaths = [
      join(root, 'bin', 'bash.exe'),
      join(root, 'usr', 'bin', 'bash.exe'),
    ];
    for (const p of bundledPaths) {
      if (existsSync(p)) {
        coworkLog('INFO', 'resolveGitBash', `Using bundled PortableGit: ${p}`);
        cachedGitBashPath = p;
        return p;
      }
    }
  }

  coworkLog('WARN', 'resolveGitBash', 'git-bash not found on this system');
  cachedGitBashPath = null;
  return null;
}

/**
 * Resolve Node.js installation directories on Windows.
 * Covers standard installers, nvm-windows, Volta, fnm, and Scoop.
 * Returns de-duplicated list of directories that contain node.exe / npm / npx.
 */
function resolveWindowsNodeDirs(): string[] {
  if (process.platform !== 'win32') return [];

  const found = new Set<string>();

  // 1. Derive from 'where node' — uses cmd.exe PATH which includes user PATH entries
  //    even when the Electron process was launched from a non-terminal context.
  const nodePaths = listWindowsCommandPaths('where node');
  for (const nodePath of nodePaths) {
    found.add(dirname(nodePath));
  }

  // 2. Scan current process.env.PATH entries that contain node.exe
  //    (covers cases where PATH is already set but node dir wasn't found above)
  for (const entry of (process.env.PATH || '').split(';')) {
    const trimmed = entry.trim();
    if (trimmed && existsSync(join(trimmed, 'node.exe'))) {
      found.add(trimmed);
    }
  }

  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || '';
  const appData = process.env.APPDATA || '';
  const userProfile = process.env.USERPROFILE || '';

  // 3. Standard Node.js installer paths
  for (const candidate of [
    join(programFiles, 'nodejs'),
    join(programFilesX86, 'nodejs'),
    localAppData && join(localAppData, 'Programs', 'nodejs'),
  ]) {
    if (candidate && existsSync(join(candidate, 'node.exe'))) {
      found.add(candidate);
    }
  }

  // 4. npm global prefix — where globally-installed CLIs (npx, ts-node, etc.) live
  if (appData) {
    const npmGlobal = join(appData, 'npm');
    if (existsSync(npmGlobal)) {
      found.add(npmGlobal);
    }
  }

  // 5. nvm-windows: active version symlink
  if (appData) {
    const nvmLink = join(appData, 'nvm', 'nodejs');
    if (existsSync(join(nvmLink, 'node.exe'))) {
      found.add(nvmLink);
    }
  }

  // 6. Volta shims (handles node/npm/npx through its own launcher)
  if (localAppData) {
    const voltaBin = join(localAppData, 'Volta', 'bin');
    if (existsSync(voltaBin)) {
      found.add(voltaBin);
    }
  }

  // 7. fnm (Fast Node Manager) — default install shim dir
  if (localAppData) {
    const fnmBin = join(localAppData, 'fnm');
    if (existsSync(fnmBin)) {
      found.add(fnmBin);
    }
  }

  // 8. Scoop — node and shims directories
  if (userProfile) {
    const scoopNode = join(userProfile, 'scoop', 'apps', 'nodejs', 'current');
    if (existsSync(join(scoopNode, 'node.exe'))) {
      found.add(scoopNode);
    }
    const scoopShims = join(userProfile, 'scoop', 'shims');
    if (existsSync(scoopShims)) {
      found.add(scoopShims);
    }
  }

  return Array.from(found).filter(Boolean);
}

/**
 * nvm does not create a `current` symlink, so `~/.nvm/current/bin` misses real
 * installs. Enumerate `~/.nvm/versions/node/*` and return bin dirs newest-first.
 */
function listNvmNodeBinDirs(home: string): string[] {
  try {
    const versionsDir = join(home, '.nvm', 'versions', 'node');
    return readdirSync(versionsDir)
      .map((name) => {
        const match = name.match(/^v?(\d+)\.(\d+)\.(\d+)/);
        return match
          ? { name, score: [Number(match[1]), Number(match[2]), Number(match[3])] as const }
          : null;
      })
      .filter((entry): entry is { name: string; score: readonly [number, number, number] } => Boolean(entry))
      .sort((a, b) => b.score[0] - a.score[0] || b.score[1] - a.score[1] || b.score[2] - a.score[2])
      .map((entry) => join(versionsDir, entry.name, 'bin'))
      .filter((dir) => existsSync(dir));
  } catch {
    return [];
  }
}

function applyPackagedEnvOverrides(env: Record<string, string | undefined>): void {
  // On Windows, resolve git-bash and ensure Git toolchain directories are available in PATH.
  if (process.platform === 'win32') {
    const electronExe = resolveElectronSkillExecutablePath();
    env.IDBOTS_ELECTRON_PATH = electronExe;

    const configuredBashPath = normalizeWindowsPath(env.CLAUDE_CODE_GIT_BASH_PATH);
    const bashPath = configuredBashPath && existsSync(configuredBashPath)
      ? configuredBashPath
      : resolveWindowsGitBashPath();

    if (bashPath) {
      env.CLAUDE_CODE_GIT_BASH_PATH = bashPath;
      const gitToolDirs = getWindowsGitToolDirs(bashPath);
      assignPathValue(env, appendEnvPath(pathValueOf(env), gitToolDirs));
      coworkLog('INFO', 'resolveGitBash', `Injected Windows Git toolchain PATH entries: ${gitToolDirs.join(', ')}`);
    }

    // Prepend shim dir so our cygpath (and node) shims are found first — avoids "cygpath -u" failures when Git's cygpath is missing
    const shimInfo = ensureElectronNodeShim();
    if (shimInfo) {
      assignPathValue(env, appendEnvPath(pathValueOf(env), [shimInfo.shimDir]));
      env.IDBOTS_NODE_SHIM_SCRIPT = shimInfo.shimScriptPath;
      env.IDBOTS_NODE_SHIM_DIR = shimInfo.shimDir;
      coworkLog('INFO', 'resolveNodeShim', `Injected Electron Node shim PATH entry: ${shimInfo.shimDir}`);
    }

    // Inject Node.js directories so that npx/npm/ts-node are findable inside git-bash.
    // Electron apps launched from a shortcut/Start menu only receive the system PATH,
    // which typically excludes user-level Node.js installations.
    const nodeDirs = resolveWindowsNodeDirs();
    if (nodeDirs.length > 0) {
      assignPathValue(env, appendEnvPath(pathValueOf(env), nodeDirs));
      coworkLog('INFO', 'resolveNodeDirs', `Injected Windows Node.js PATH entries: ${nodeDirs.join(', ')}`);
    }

    // Disable MSYS2/Git Bash automatic path conversion.
    // Without this, Unix-style arguments like --path "/protocols/simplebuzz" are silently
    // rewritten to Windows paths (e.g. C:/Program Files/Git/protocols/simplebuzz) before
    // reaching the target process, corrupting MetaID protocol paths and similar values.
    env.MSYS_NO_PATHCONV = '1';
    env.MSYS2_ARG_CONV_EXCL = '*';
  }

  // Guarantee a Node runtime for skill scripts on every platform: write the
  // Electron-as-Node shim into userData/cowork/bin as a FALLBACK after any
  // user-installed Node. Windows is handled in the branch above; on macOS/Linux
  // the fallback must happen AFTER the user-shell PATH resolution below or it
  // would be overwritten. Prepending the shim forced two Electron launches even
  // when real Node was already installed and produced generic exec Dock tiles.
  const injectElectronNodeShim = (): void => {
    if (process.platform === 'win32') return;
    const shimInfo = ensureElectronNodeShim();
    if (!shimInfo) return;
    assignPathValue(env, appendEnvPathFallback(pathValueOf(env), [shimInfo.shimDir]));
    env.IDBOTS_NODE_SHIM_SCRIPT = shimInfo.shimScriptPath;
    env.IDBOTS_NODE_SHIM_DIR = shimInfo.shimDir;
    coworkLog('INFO', 'resolveNodeShim', `Injected Electron Node shim PATH entry: ${shimInfo.shimDir}`);
  };

  if (!app.isPackaged) {
    injectElectronNodeShim();
    return;
  }

  if (!env.HOME) {
    env.HOME = app.getPath('home');
  }

  // Resolve user's shell PATH so that node, npm, and other tools are findable
  const userPath = resolveUserShellPath();
  if (userPath) {
    assignPathValue(env, userPath);
  } else {
    // Fallback: append common node installation paths
    const home = env.HOME || app.getPath('home');
    const commonPaths = [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      ...listNvmNodeBinDirs(home),
      `${home}/.volta/bin`,
      `${home}/.fnm/current/bin`,
    ];
    assignPathValue(env, [pathValueOf(env), ...commonPaths].filter(Boolean).join(delimiter));
  }

  injectElectronNodeShim();

  const resourcesPath = process.resourcesPath;
  const nodePaths = [
    join(resourcesPath, 'app.asar', 'node_modules'),
    join(resourcesPath, 'app.asar.unpacked', 'node_modules'),
  ].filter((nodePath) => existsSync(nodePath));

  if (nodePaths.length > 0) {
    env.NODE_PATH = appendEnvPath(env.NODE_PATH, nodePaths);
  }
}

/**
 * Resolve system proxy configuration from Electron session
 * @param targetUrl Target URL to resolve proxy for
 */
async function resolveSystemProxy(targetUrl: string): Promise<string | null> {
  try {
    const proxyResult = await session.defaultSession.resolveProxy(targetUrl);
    if (!proxyResult || proxyResult === 'DIRECT') {
      return null;
    }

    // proxyResult format: "PROXY host:port" or "SOCKS5 host:port"
    const match = proxyResult.match(/^(PROXY|SOCKS5?)\s+(.+)$/i);
    if (match) {
      const [, type, hostPort] = match;
      const prefix = type.toUpperCase().startsWith('SOCKS') ? 'socks5' : 'http';
      return `${prefix}://${hostPort}`;
    }

    return null;
  } catch (error) {
    console.error('Failed to resolve system proxy:', error);
    return null;
  }
}

/**
 * Writable SKILLs directory (userData/SKILLs in both development and production).
 * Bundled/source SKILLs stay readable via SkillManager.getAllSkillRoots().
 */
export function getSkillsRoot(): string {
  return resolveWritableSkillsRoot();
}

/**
 * Global (not per-session) host env that skill scripts need.
 *
 * Claude subprocesses get this via getEnhancedEnv(). The DSH kernel is a
 * shared runtime, so this map is merged into the DSH child env. Per-session
 * identity (metabot id, mnemonic, image KEY/TOKEN names) rides a separate
 * BASH_ENV channel — see dshSkillSessionEnv.ts — because a shared env would
 * cross-leak between concurrent sessions and DSH scrubs KEY/TOKEN names.
 * IDBOTS_API_BASE_URL is the local cowork proxy (scheduled-task create/list/…).
 *
 * Windows packaged builds ship PortableGit at resources/mingit, but DSH
 * bash-local spawns a bare `bash` name. applyPackagedEnvOverrides prepends
 * those dirs onto PATH here so Start-menu Electron (no Git on system PATH)
 * can still resolve bash.exe. BASH_ENV identity injection cannot help if
 * the bash spawn itself fails with ENOENT.
 */
export function getSkillHostEnv(): Record<string, string> {
  const skillsRoot = getSkillsRoot();
  const env: Record<string, string | undefined> = {
    // Seed PATH so Windows mingit/node injection has a base to prepend to.
    PATH: process.env.PATH ?? process.env.Path,
    CLAUDE_CODE_GIT_BASH_PATH: process.env.CLAUDE_CODE_GIT_BASH_PATH,
  };
  applyPackagedEnvOverrides(env);
  appendPythonRuntimeToEnv(env);

  env.SKILLS_ROOT = skillsRoot;
  env.IDBOTS_SKILLS_ROOT = skillsRoot;
  env.IDBOTS_ELECTRON_PATH = resolveElectronSkillExecutablePath();
  const explicitPlaywrightExecutable = process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH?.trim();
  const playwrightExecutable = explicitPlaywrightExecutable || (process.platform === 'darwin'
    ? detectSystemChromium().executablePath
    : undefined);
  // An unbundled chrome-headless-shell becomes a generic exec Dock tile when
  // a GUI app launches it. Use an app-bundled browser when one is available.
  if (playwrightExecutable) {
    env.PLAYWRIGHT_MCP_EXECUTABLE_PATH = playwrightExecutable;
  }
  env.IDBOTS_APP_DATA_PATH = app.getPath('appData');
  env.IDBOTS_USER_DATA_PATH = app.getPath('userData');
  // Global RPC base (no token). Per-session IDBOTS_RPC_TOKEN still rides
  // the BASH_ENV session file / AUTHFILE; scripts default to 127.0.0.1:31200
  // when this is missing.
  env.IDBOTS_RPC_URL = getMetaidRpcBase();
  // Scrub-proof fallback channel for the local RPC bearer token: DSH bash
  // erases *TOKEN* env names, so SKILL scripts read the token from this
  // mirror file (written per launch by the MetaID RPC server) when the
  // env-borne IDBOTS_RPC_TOKEN is missing.
  env[METAID_RPC_AUTHFILE_ENV] = getMetaidRpcTokenFilePath(app.getPath('userData'));
  const internalApiBaseURL = getInternalApiBaseURL();
  if (internalApiBaseURL) {
    env.IDBOTS_API_BASE_URL = internalApiBaseURL;
  }
  // Local-gateway bypass for proxied environments (e.g. ClashX): proxy env
  // vars inherited from the parent process reach the DSH runtime and its bash
  // tool; without NO_PROXY they route the 127.0.0.1 MetaID RPC gateway (and
  // other local relays) through the system proxy, which intercepts or rejects
  // localhost traffic. Keep any inherited NO_PROXY entries and pin the local
  // hosts. getEnhancedEnv re-merges the same list, so this stays idempotent.
  const mergedNoProxy = mergeNoProxyList(
    process.env.NO_PROXY || process.env.no_proxy,
    LOCAL_NO_PROXY_HOSTS
  );
  env.NO_PROXY = mergedNoProxy;
  env.no_proxy = mergedNoProxy;
  collapseWindowsPathKeys(env);

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.length > 0) out[key] = value;
  }
  return out;
}

/**
 * Get enhanced environment variables (including proxy configuration)
 * Async function to fetch system proxy and inject into environment variables
 */
export async function getEnhancedEnv(
  target: OpenAICompatProxyTarget = 'local',
  apiConfigOverride?: ReturnType<typeof getCurrentApiConfig>
): Promise<Record<string, string | undefined>> {
  const config = apiConfigOverride ?? getCurrentApiConfig(target);
  const env = config
    ? buildEnvForConfig(config)
    : { ...process.env };

  applyPackagedEnvOverrides(env);

  // Keep the embedded Claude Code binary from talking to Anthropic-operated
  // endpoints (telemetry, error reporting, auto-update, nonessential traffic).
  // All model traffic must flow through the per-session provider config only.
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.DISABLE_TELEMETRY = '1';
  env.DISABLE_ERROR_REPORTING = '1';
  env.DISABLE_AUTOUPDATER = '1';
  env.DISABLE_BUG_COMMAND = '1';

  Object.assign(env, getSkillHostEnv());

  const mergedNoProxy = mergeNoProxyList(
    env.NO_PROXY || env.no_proxy,
    LOCAL_NO_PROXY_HOSTS
  );
  env.NO_PROXY = mergedNoProxy;
  env.no_proxy = mergedNoProxy;

  // Skip system proxy resolution if proxy env vars already exist
  if (env.http_proxy || env.HTTP_PROXY || env.https_proxy || env.HTTPS_PROXY) {
    return env;
  }

  // Resolve proxy from system settings
  const proxyUrl = await resolveSystemProxy('https://openrouter.ai');
  if (proxyUrl) {
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    console.log('Injected system proxy for subprocess:', proxyUrl);
  }

  return env;
}

/**
 * Ensure the cowork temp directory exists in the given working directory
 * @param cwd Working directory path
 * @returns Path to the temp directory
 */
export function ensureCoworkTempDir(cwd: string): string {
  const tempDir = join(cwd, '.cowork-temp');
  if (!existsSync(tempDir)) {
    try {
      mkdirSync(tempDir, { recursive: true });
      console.log('Created cowork temp directory:', tempDir);
    } catch (error) {
      console.error('Failed to create cowork temp directory:', error);
      // Fall back to cwd if we can't create the temp dir
      return cwd;
    }
  }
  return tempDir;
}

/**
 * Get enhanced environment variables with TMPDIR set to the cowork temp directory
 * This ensures Claude Agent SDK creates temporary files in the user's working directory
 * @param cwd Working directory path
 */
export async function getEnhancedEnvWithTmpdir(
  cwd: string,
  target: OpenAICompatProxyTarget = 'local',
  apiConfigOverride?: ReturnType<typeof getCurrentApiConfig>
): Promise<Record<string, string | undefined>> {
  const env = await getEnhancedEnv(target, apiConfigOverride);
  const tempDir = ensureCoworkTempDir(cwd);

  // Set temp directory environment variables for all platforms
  env.TMPDIR = tempDir;  // macOS, Linux
  env.TMP = tempDir;     // Windows
  env.TEMP = tempDir;    // Windows

  return env;
}

/** First-line, same-language fallback when the title model call fails. */
export function deriveSessionTitle(userIntent: string, maxChars = 50): string {
  const collapsed = userIntent.replace(/\s+/g, ' ').trim();
  if (!collapsed) return 'New Session';
  if (collapsed.length <= maxChars) return collapsed;
  return `${truncateUtf16Units(collapsed, maxChars).trimEnd()}...`;
}

/** Strip quotes/newlines and cap length so a model title is list-safe. */
export function sanitizeGeneratedSessionTitle(raw: string, fallback: string, maxChars = 50): string {
  const line = raw
    .split('\n')[0]
    ?.replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`«»「」『』]+|["'`«»「」『』]+$/g, '')
    .trim() ?? '';
  if (!line || /^new session$/i.test(line)) return fallback;
  if (line.length <= maxChars) return line;
  return truncateUtf16Units(line, maxChars).trimEnd();
}

/**
 * One-shot title via the configured provider (OpenAI-compatible / Responses).
 * Does not spawn the Claude Agent SDK and does not start a cowork DSH turn.
 */
let sessionTitleBrainProvider: (() => MetabotBrainOptions | null) | null = null;

/**
 * Session titling is a system automation: main.ts sets this to the Twin Bot
 * system brain (primary + fallback) at startup so titles never depend on the
 * bare app default model (the metaid-free onboarding quota). Unset, or a
 * brain with no llmId, keeps the previous app-default behavior.
 */
export function setSessionTitleBrainProvider(provider: (() => MetabotBrainOptions | null) | null): void {
  sessionTitleBrainProvider = provider;
}

export async function generateSessionTitle(userIntent: string | null): Promise<string> {
  if (!userIntent) return 'New Session';
  const fallback = deriveSessionTitle(userIntent);
  const brain = sessionTitleBrainProvider?.() ?? null;

  try {
    const result = await chatCompletionWithTools(
      [
        {
          role: 'system',
          content:
            'You name a chat session. Reply with ONLY the title. Max 50 characters. Same language as the user input. No quotes, no explanation.',
        },
        {
          role: 'user',
          content: `User input:\n${truncateUtf16Units(userIntent, 2000)}`,
        },
      ],
      {
        llmId: brain?.llmId ?? undefined,
        llmProvider: brain?.llmProvider ?? undefined,
        fallbackLlmId: brain?.fallbackLlmId ?? undefined,
        fallbackLlmProvider: brain?.fallbackLlmProvider ?? undefined,
        thinking: 'disabled',
        // Titles stay effort-off regardless of the twin brain's configured
        // effort — a 64-token title must never wait on reasoning.
        effort: 'off',
        maxTokens: 64,
        temperature: 0.2,
        throwOnEmptyContent: true,
        // Per-attempt window: the fallback brain gets its own fresh 12s
        // instead of inheriting the primary's spent signal.
        attemptTimeoutMs: 12_000,
      }
    );
    return sanitizeGeneratedSessionTitle(result.content ?? '', fallback);
  } catch (error) {
    if (isSqliteWasmBoundsError(error)) {
      throw error;
    }
    console.error('Failed to generate session title:', error);
    return fallback;
  }
}

/**
 * Brain provider for the LLM turn-ack reply — same wiring contract as the
 * title brain: main.ts sets it to the Twin system brain at startup so ack
 * replies never depend on the bare app default model.
 */
let turnAckReplyBrainProvider: (() => MetabotBrainOptions | null) | null = null;

export function setTurnAckReplyBrainProvider(provider: (() => MetabotBrainOptions | null) | null): void {
  turnAckReplyBrainProvider = provider;
}

/**
 * One-shot LLM acknowledgment for a turn (first-response latency). Mirrors
 * generateSessionTitle: a direct cognitive-layer call — no kernel spawn, no
 * agent loop — so it returns in seconds while the DSH turn is still warming
 * up. Since 2026-11-03 (second pass, owner decision after session 2c70849f)
 * this is THE first sentence for generic turns — the bot's own words about
 * this message; canned phrase pools are gone. Since the same day's third pass
 * (session 3ecd2a2f) the runner's cerebellum ack gate decides which turns get
 * an interim acknowledgment at all, and the prompt never answers the
 * message's content (this call sees no time/memory context, so a substantive
 * ack can contradict the real reply). The optional signal lets the runner
 * abort the in-flight attempt when the gate's skip verdict lands mid-call
 * (an abort is non-terminal: no fallback retry, no system rescue — the call
 * settles as '' and the turn simply shows no first sentence). Returns '' when
 * the call fails or the output is unusable; the runner then shows no first
 * sentence at all (the activity indicator covers the wait) rather than a
 * canned line. Primary + fallback brain, like titles.
 */
export async function generateTurnAckReply(userText: string, sessionTitle?: string | null, signal?: AbortSignal): Promise<string> {
  try {
    const brain = turnAckReplyBrainProvider?.() ?? null;
    // Effective model for the thinking-aware budget below: the brain's llmId,
    // else the app default the cognitive layer would resolve for an unset
    // llmId (the same default generateSessionTitle rides when no brain has
    // an llmId). Read-only resolution — no proxy pin, no side effects.
    const effectiveModel =
      brain?.llmId ??
      resolveApiConfigForModel(null, 'local', null, brain?.llmProvider ?? null)?.config?.model ??
      null;
    // F2 (2026-10-23 thinking-leak fix): always-thinking models (GLM-5.x —
    // the wire cannot turn their reasoning off, so `thinking: 'disabled'` is
    // a no-op for them) get reasoning headroom; a 96-token ceiling burns
    // entirely in hidden reasoning and the ack comes back empty. Models that
    // can genuinely disable thinking keep the tight 96.
    const maxTokens = modelAlwaysThinks(effectiveModel) ? 2048 : 96;
    const result = await chatCompletionWithTools(
      buildTurnAckReplyMessages({ userText, sessionTitle }),
      {
        llmId: brain?.llmId ?? undefined,
        llmProvider: brain?.llmProvider ?? undefined,
        // Same brain pair the session title rides: a hung primary relay
        // (2026-11-03 acb5961b — the primary ack call timed out with no
        // retry) falls back once, so the refine keeps a chance to land.
        fallbackLlmId: brain?.fallbackLlmId ?? undefined,
        fallbackLlmProvider: brain?.fallbackLlmProvider ?? undefined,
        thinking: 'disabled',
        // An ack must never wait on reasoning (same rationale as titles).
        effort: 'off',
        maxTokens,
        temperature: 0.6,
        throwOnEmptyContent: true,
        // The Responses path injects server-side web_search by default; a
        // search detour would defeat the whole point of a fast ack.
        webSearch: false,
        attemptTimeoutMs: 4_000,
        // Caller abort (the ack gate's skip verdict) — linked into each
        // per-attempt timeout signal by withPerAttemptSignal.
        signal,
      }
    );
    // F1 (2026-10-23 thinking-leak fix): on the always-thinking GLM-5.x
    // brain the ack budget burned in hidden reasoning, content came back
    // empty, and the openai-compat resolver PROMOTED reasoning_content into
    // content — a mid-thought English analysis fragment then leaked out as
    // the ack bubble. Reject reasoning-promoted content and length-truncated
    // completions outright; the runner uses its deterministic opening instead.
    const metadata = result.responseMetadata;
    const promotedFromReasoning = metadata?.contentBlockTypes?.includes('reasoning') ?? false;
    if (promotedFromReasoning || metadata?.stopReason === 'length') {
      console.info(
        '[turnAck] dropped LLM ack reply:',
        `promotedFromReasoning=${promotedFromReasoning}`,
        `stopReason=${metadata?.stopReason ?? 'n/a'}`,
        `blocks=${metadata?.contentBlockTypes?.join(',') ?? 'none'}`
      );
      return '';
    }
    return sanitizeTurnAckReplyForInput(result.content ?? '', userText);
  } catch (error) {
    if (isSqliteWasmBoundsError(error)) {
      throw error;
    }
    console.error('Failed to generate turn ack reply:', error);
    return '';
  }
}

/**
 * One-shot LLM owner wait update — the text of the "still working" heartbeat
 * bubble. Owner decision 2026-11-04: no canned text in ANY bubble (the fixed
 * heartbeat strings read as a recording), so each fire writes its own line
 * from the live wait context. Same call class as generateTurnAckReply: Twin
 * system brain pair, thinking off, tight budget, 4s per-attempt timeout,
 * reasoning-promoted/length-truncated output rejected, input-aware sanitize.
 * Returns '' on any failure — the runner then emits NO heartbeat bubble at
 * all (the owner's rule: no bubble beats a canned one) and backs off to the
 * next window.
 */
export async function generateOwnerWaitUpdate(input: OwnerWaitUpdateInput): Promise<string> {
  try {
    const brain = turnAckReplyBrainProvider?.() ?? null;
    const effectiveModel =
      brain?.llmId ??
      resolveApiConfigForModel(null, 'local', null, brain?.llmProvider ?? null)?.config?.model ??
      null;
    const maxTokens = modelAlwaysThinks(effectiveModel) ? 2048 : 96;
    const result = await chatCompletionWithTools(
      buildOwnerWaitUpdateMessages(input),
      {
        llmId: brain?.llmId ?? undefined,
        llmProvider: brain?.llmProvider ?? undefined,
        fallbackLlmId: brain?.fallbackLlmId ?? undefined,
        fallbackLlmProvider: brain?.fallbackLlmProvider ?? undefined,
        thinking: 'disabled',
        effort: 'off',
        maxTokens,
        temperature: 0.7,
        throwOnEmptyContent: true,
        webSearch: false,
        attemptTimeoutMs: 4_000,
      }
    );
    const metadata = result.responseMetadata;
    const promotedFromReasoning = metadata?.contentBlockTypes?.includes('reasoning') ?? false;
    if (promotedFromReasoning || metadata?.stopReason === 'length') {
      console.info(
        '[ownerWait] dropped LLM wait update:',
        `promotedFromReasoning=${promotedFromReasoning}`,
        `stopReason=${metadata?.stopReason ?? 'n/a'}`,
        `blocks=${metadata?.contentBlockTypes?.join(',') ?? 'none'}`
      );
      return '';
    }
    return sanitizeTurnAckReplyForInput(result.content ?? '', input.userText);
  } catch (error) {
    if (isSqliteWasmBoundsError(error)) {
      throw error;
    }
    console.error('Failed to generate owner wait update:', error);
    return '';
  }
}
